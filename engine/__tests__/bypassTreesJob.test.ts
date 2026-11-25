/**
 * The sites that start a process without the executor own their tree under a Job Object (wave 15b,
 * checks C4-3 and C4-5). Under vitest's Node `ownProcessTree` is the walk kind: killing the root of a
 * check that has already ended finds no tree, so a mutant that killed instead of releasing, or that
 * left the tree when exec ended the shell on an output overrun, passed every test. Every engine on
 * this PC runs under Bun, where the tree is a Job Object; `fixtures/bypassTrees.ts` runs the real
 * sites there, as `processTreeJob.test.ts` runs its own, and this file reads its one JSON line.
 *
 * Every case that says a program is gone after a cut or an overrun also says the program was seen carrying its mark
 * while it ran (`seenMarked`, a watcher of `helpers/markedProcesses.ts`; wave 24, round two): "gone" is also the
 * answer of a mark that never named the program, so without it a mark lost in a wrapper would pass every case.
 *
 * The precheck's cut is not here: under Bun on Windows it makes a real `precheck` sandbox whose
 * tool-call audit folder must lie outside the home folder, and a test may make folders only in the
 * temp folder, which is inside it. Windows only, and only where `bun` names its executable.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function findBunExe(): string | null {
  const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: process.platform === 'win32', windowsHide: true, timeout: 15_000 })
  const exe = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).pop() ?? '' : ''
  return exe !== '' && existsSync(exe) ? exe : null
}
const bunExe = process.platform === 'win32' ? findBunExe() : null
const fixture = fileURLToPath(new URL('./fixtures/bypassTrees.ts', import.meta.url))
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

describe.skipIf(process.platform !== 'win32' || bunExe === null)('the bypass sites\' trees under Bun on Windows (fixtures/bypassTrees.ts)', () => {
  let report: any = null
  const get = () => {
    if (report) return report
    const dir = mkdtempSync(join(tmpdir(), 'cynco-bypass-trees-'))
    dirs.push(dir)
    const env = { ...process.env }
    delete env.LOCALCODE_CONTAINMENT_OFF
    const run = spawnSync(bunExe!, [fixture, dir], { encoding: 'utf-8', windowsHide: true, timeout: 150_000, env })
    const last = String(run.stdout ?? '').trim().split('\n').pop() ?? ''
    try { report = JSON.parse(last) } catch (e) {
      throw new Error(`the fixture printed no report (status ${run.status}, ${(e as Error).message}):\n${run.stdout}\n${run.stderr}`)
    }
    expect(report.ok, JSON.stringify(report)).toBe(true)
    return report
  }

  it('takes a Job Object for a child\'s tree, inside the engine\'s own job, as the engine does', () => {
    const r = get()
    expect(r.kind).toBe('job')
    expect(r.engineJob).toBe(true)
  }, 180_000)

  it('a contract check cut at its cap ends the program it started', () => {
    const c = get().cases.contractCut
    expect(c.outcome, JSON.stringify(c)).toBe('timeout')
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the check's cap`).toBe(true)
  }, 180_000)

  it('a contract check that ends on its own leaves a program it started on purpose running', () => {
    const c = get().cases.contractNatural
    expect(c.outcome, JSON.stringify(c)).toBe('passed')
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.aliveAfter, `the program ${c.pid} was killed when the check ended`).toBe(true)
  }, 180_000)

  it('a contract check whose output overruns its buffer ends what the shell started, long before its cap', () => {
    const c = get().cases.contractOverflow
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.ms, JSON.stringify(c)).toBeLessThan(55_000)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the overrun`).toBe(true)
  }, 180_000)

  it('LSP diagnostics cut at their cap end the program a planted py_compile started', () => {
    const c = get().cases.lspCut
    expect(c.diags, JSON.stringify(c)).toEqual([])
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the diagnostics' cap`).toBe(true)
  }, 180_000)

  // Wave 15c, check B4-7: the overrun path of LSP had no test of its own; putting it back to
  // round one's `killed` test survived every case.
  it('LSP diagnostics whose output overruns their buffer end the program a planted py_compile started', () => {
    const c = get().cases.lspOverflow
    expect(c.diags, JSON.stringify(c)).toBe(0)
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.ms, JSON.stringify(c)).toBeLessThan(9_000)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the overrun`).toBe(true)
  }, 180_000)

  // Wave 19, check C4-3: the overrun suppression is py_compile's only. tsc's output that overran is
  // still TypeScript lines: the ones read are diagnostics, where wave 15c's fix reported none at all
  // (a build broken widely enough to print 8 MiB read as clean). The tree is ended as before.
  it('tsc diagnostics whose output overruns their buffer give the errors read, and end the program a planted npx started', () => {
    const c = get().cases.lspTscOverflow
    expect(c.diags, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.first, JSON.stringify(c)).toBe('a stand-in error xxxxxxxxxxx.')
    // The line the overrun cut is not read as an error with half a message.
    expect(c.cut, JSON.stringify(c)).toEqual([])
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.ms, JSON.stringify(c)).toBeLessThan(12_000)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the overrun`).toBe(true)
  }, 180_000)

  // Wave 15c, P4(1b): best-of-N test runs own their tree as the contract check does.
  it('a best-of-N test run cut at its cap ends the program it started, and answers no score', () => {
    const c = get().cases.bestOfNCut
    expect(c.refused, JSON.stringify(c)).toBeNull()
    expect([c.passed, c.total], JSON.stringify(c)).toEqual([0, 0])
    expect(c.ms, JSON.stringify(c)).toBeLessThan(10_000)
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the run's cap`).toBe(true)
  }, 180_000)

  it('a best-of-N test run that ends on its own leaves a program it started on purpose running', () => {
    const c = get().cases.bestOfNNatural
    expect(c.refused, JSON.stringify(c)).toBeNull()
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.aliveAfter, `the program ${c.pid} was killed when the run ended`).toBe(true)
  }, 180_000)

  it('a best-of-N test run whose output overruns its buffer ends what the shell started, long before its cap', () => {
    const c = get().cases.bestOfNOverflow
    expect(c.refused, JSON.stringify(c)).toBeNull()
    expect(c.pid, JSON.stringify(c)).toBeGreaterThan(0)
    expect(c.ms, JSON.stringify(c)).toBeLessThan(55_000)
    expect(c.seenMarked, `the program ${c.pid} was never seen carrying its mark while it ran: ${JSON.stringify(c)}`).toBe(true)
    expect(c.gone, `the program ${c.pid} outlived the overrun`).toBe(true)
  }, 180_000)

  // F255 (wave 24): the fixture's last line ended "what was left" by nine pid numbers it had read up to nineteen
  // seconds earlier, seven of them of programs it had already seen gone, so a number another process had been given
  // meanwhile would have been ended with it. It now ends what carries its mark and nothing else, and says what that was.
  it('ends at its end only what carries its mark: the programs left running on purpose, and nothing is left', () => {
    const r = get()
    const onPurpose = [r.cases.contractNatural?.pid, r.cases.bestOfNNatural?.pid]
    expect(Array.isArray(r.endedAtEnd), `the fixture does not say what it ended at its end: ${JSON.stringify(r)}`).toBe(true)
    for (const pid of r.endedAtEnd) {
      expect(onPurpose, `the fixture ended ${pid} at its end, which is not a program it left running on purpose (${JSON.stringify(r.endedAtEnd)})`).toContain(pid)
    }
    // The best-of-N run's program lives two minutes: it is still running at the end, so it is what shows that the
    // mark finds what it must (the contract check's ends itself after 20 s, and may be gone by then).
    expect(r.endedAtEnd, `the program left running on purpose was not found by its mark: ${JSON.stringify(r)}`).toContain(r.cases.bestOfNNatural.pid)
    expect(r.cleanAfterEnd, `something that carries the fixture's mark was still running after its end: ${JSON.stringify(r)}`).toBe(true)
  }, 180_000)
})
