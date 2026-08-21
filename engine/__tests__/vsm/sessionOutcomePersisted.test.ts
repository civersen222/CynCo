import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The dashboard's session list reads `sessions` (GovernanceDB.getRecentSessions,
 * via /api/sessions in engine/dashboard/server.ts). On a long-lived engine that
 * table was frozen at 14 rows while `measurements` grew past 76,000 — every
 * headless mission wrote per-turn data and not one wrote a session row, so the
 * dashboard showed a list of benchmark runs from a previous era and none of the
 * user's actual work.
 *
 * The cause was that `recordSessionOutcome` was only ever called from process
 * exit — engine/main.ts shutdown and handoff. A server-mode engine serves
 * mission after mission and never exits, so the call never happened. The
 * conversation loop already computed `finalOutcome` at session end and only
 * logged it.
 *
 * These tests pin the two halves: that the write path works at all (it had no
 * test), and that a session id rotation cannot silently drop the outgoing
 * session's row.
 */
describe('session outcomes reach the sessions table', () => {
  let home: string
  let prev: string | undefined
  const opened: Array<{ close(): void }> = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'govhome-'))
    prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    opened.length = 0
  })
  afterEach(() => {
    // Windows will not unlink an open SQLite file, so the handle has to go
    // before the directory does.
    for (const db of opened) db.close()
    if (prev === undefined) delete process.env.CYNCO_HOME
    else process.env.CYNCO_HOME = prev
    // Best-effort: bun:sqlite keeps the -wal/-shm files mapped until its cached
    // statements are finalized, which can outlive close() on Windows. A leaked
    // directory under the OS temp dir is not worth failing a test that already
    // made its assertion — each test gets its own home, so a survivor cannot
    // contaminate the next one.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (e) {
      console.warn(`[test] left ${home} behind: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  // A session with zero turns is dropped at the DB boundary as degenerate
  // (governanceDb.ts recordSession). That guard is correct — a session that
  // never took a turn carries no signal — so the fixture has to seal a real
  // turn, or these tests would be asserting against a shape the product never
  // writes.
  const freshGov = async (turns = 1) => {
    const { CyberneticsGovernance } = await import('../../vsm/cyberneticsGovernance.js')
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < turns; i++) {
      gov.onTurnComplete({
        toolsCalled: 1,
        thinkingTokens: 0,
        totalTokens: 100,
        latencyMs: 10,
        response: 'ok',
      })
    }
    const db = gov.getGovernanceDb()
    if (db) opened.push(db)
    return gov
  }

  it('recordSessionOutcome writes a row getRecentSessions can read back', async () => {
    const gov = await freshGov()
    gov.setSessionId('session-under-test')
    gov.recordSessionOutcome('viable', 'default', 0, 3)

    const rows = gov.getGovernanceDb()!.getRecentSessions(50)
    const mine = rows.find((r: any) => r.sessionId === 'session-under-test')
    expect(mine).toBeDefined()
    expect(mine!.outcome).toBe('viable')
    expect(mine!.filesChanged).toBe(3)
  })

  // The row must be filed under the CANONICAL id the rest of the system
  // journals against, or the join in engine/s5/exportTrainingData.ts (which
  // maps sessionId -> outcome from this very table) silently matches nothing
  // and every mission's decisions become unlabeled training data.
  it('files the row under the canonical session id, not the auto-generated one', async () => {
    const gov = await freshGov()
    const auto = gov.getSessionId()
    gov.setSessionId('session-canonical')
    gov.recordSessionOutcome('marginal', 'default', 0, 0)

    const ids = gov.getGovernanceDb()!.getRecentSessions(50).map((r: any) => r.sessionId)
    expect(ids).toContain('session-canonical')
    expect(ids).not.toContain(auto)
  })

  it('keeps one row per session across several sessions in one process', async () => {
    const gov = await freshGov()
    gov.setSessionId('session-a')
    gov.recordSessionOutcome('viable', 'default', 0, 1)
    gov.setSessionId('session-b')
    gov.recordSessionOutcome('non-viable', 'default', 0, 0)

    const ids = gov.getGovernanceDb()!.getRecentSessions(50).map((r: any) => r.sessionId)
    expect(ids).toContain('session-a')
    expect(ids).toContain('session-b')
  })

  /**
   * The other half of the same complaint. A session row is written at session
   * END, so even with the write path fixed, a mission that has been running for
   * three hours appears nowhere — and long CynCo missions are exactly the work
   * the user wants to watch. `measurements` already has a row per turn from turn
   * one, so the in-flight session is known; it was simply never asked for.
   */
  it('lists a session that has turns but has not ended yet', async () => {
    const gov = await freshGov(0)
    gov.setSessionId('session-in-flight')
    gov.onTurnComplete({ toolsCalled: 1, thinkingTokens: 0, totalTokens: 100, latencyMs: 10, response: 'ok' })

    const db = gov.getGovernanceDb()!
    expect(db.getRecentSessions(50).map((r: any) => r.sessionId)).not.toContain('session-in-flight')

    const live = db.getLiveSessions(50)
    const mine = live.find((r: any) => r.sessionId === 'session-in-flight')
    expect(mine).toBeDefined()
    // 'running' and not a viability verdict: nothing has judged this session,
    // and rendering it as 'viable' would be a claim nobody made.
    expect(mine!.outcome).toBe('running')
    expect(mine!.totalTurns).toBeGreaterThan(0)
  })

  it('drops a session from the live list once it has ended', async () => {
    const gov = await freshGov(1)
    gov.setSessionId('session-finishes')
    gov.onTurnComplete({ toolsCalled: 1, thinkingTokens: 0, totalTokens: 100, latencyMs: 10, response: 'ok' })
    const db = gov.getGovernanceDb()!
    expect(db.getLiveSessions(50).map((r: any) => r.sessionId)).toContain('session-finishes')

    gov.recordSessionOutcome('viable', 'default', 0, 2)

    // Exactly one entry, in one list or the other — never both, or the dropdown
    // shows the same mission twice and the user cannot tell which is real.
    expect(db.getLiveSessions(50).map((r: any) => r.sessionId)).not.toContain('session-finishes')
    expect(db.getRecentSessions(50).map((r: any) => r.sessionId)).toContain('session-finishes')
  })
})

/**
 * A source guard, deliberately. The bug was not that the write path was broken
 * — it worked, and still would have passed the tests above. The bug was that
 * NOTHING CALLED IT except process exit. Only a check on the call site can
 * catch that regressing, and it regressing means the dashboard silently goes
 * blank again while every unit test stays green.
 */
describe('the session-end path persists its outcome, not just logs it', () => {
  // This file is run by both bun:test and vitest (vitest.config.ts aliases
  // bun:test), and `import.meta.dir` is Bun-only — under vitest it is undefined
  // and join() throws before the assertion is ever reached. A URL resolves in
  // both.
  const engineSrc = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
  const loopSrc = () => engineSrc('bridge/conversationLoop.ts')

  it('conversationLoop records the session outcome where it computes finalOutcome', () => {
    const src = loopSrc()
    expect(src).toMatch(/const finalOutcome = /)
    // The call must exist and must pass finalOutcome — persisting a hardcoded
    // 'viable' would keep the dashboard populated and make every session a
    // success, which is worse than an empty list.
    expect(src).toMatch(/recordSessionOutcome\(\s*finalOutcome/)
  })

  it('does not rely on process exit alone — main.ts is not the only call site', () => {
    const main = engineSrc('main.ts')
    const inMain = (main.match(/recordSessionOutcome\(/g) ?? []).length
    const inLoop = (loopSrc().match(/recordSessionOutcome\(/g) ?? []).length
    expect(inMain).toBeGreaterThan(0)
    expect(inLoop).toBeGreaterThan(0)
  })
})
