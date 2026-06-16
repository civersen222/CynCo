// engine/__tests__/daemon/missionLedger.test.ts
import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MissionLedger } from '../../daemon/missionLedger.js'
import type { MissionConfig, Recommendation } from '../../daemon/types.js'

const config: MissionConfig = {
  id: 'mfl-dynasty',
  goal: 'Win the dynasty league',
  leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0005' }],
  triggers: [{
    id: 'daily-news', kind: 'daily', at: '08:00',
    precheck: 'none', missedPolicy: 'skip', prompt: 'Review news',
  }],
  trustLadder: { waiver: { mode: 'ask', promoteAt: 3 } },
}

const rec: Recommendation = { id: 'rec-1', actionType: 'waiver', summary: 'Claim X', detail: 'why' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cynco-ml-'))
  writeFileSync(join(dir, 'mission.json'), JSON.stringify(config), 'utf-8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('MissionLedger', () => {
  it('loads config and creates default state', () => {
    const ml = MissionLedger.load(dir)
    expect(ml.config.id).toBe('mfl-dynasty')
    expect(ml.state.failureStreak).toBe(0)
    expect(ml.state.trust.waiver.approvedStreak).toBe(0)
  })

  it('persists state across reloads', () => {
    const ml = MissionLedger.load(dir)
    ml.setNextFire('daily-news', '2026-06-12T08:00:00.000Z')
    ml.setLastSeen('12345', 'hash-abc')
    ml.saveState()
    const ml2 = MissionLedger.load(dir)
    expect(ml2.state.nextFire['daily-news']).toBe('2026-06-12T08:00:00.000Z')
    expect(ml2.state.lastSeen['12345']).toBe('hash-abc')
  })

  it('appends run records and reads them back newest-last', () => {
    const ml = MissionLedger.load(dir)
    ml.recordRun({ ts: 't1', triggerId: 'daily-news', ok: true, summary: 'a', recommendationIds: [] })
    ml.recordRun({ ts: 't2', triggerId: 'daily-news', ok: false, summary: 'b', recommendationIds: [] })
    const runs = ml.recentRuns(5)
    expect(runs.length).toBe(2)
    expect(runs[1].ts).toBe('t2')
  })

  it('tracks pending approvals and resolves approve → streak++', () => {
    const ml = MissionLedger.load(dir)
    ml.addPending(rec)
    expect(ml.state.pending['rec-1']).toBeDefined()
    const res = ml.resolveApproval('rec-1', 'approve')
    expect(res?.rec.summary).toBe('Claim X')
    expect(ml.state.trust.waiver.approvedStreak).toBe(1)
    expect(ml.state.pending['rec-1']).toBeUndefined()
  })

  it('reject resets the streak', () => {
    const ml = MissionLedger.load(dir)
    ml.state.trust.waiver.approvedStreak = 2
    ml.addPending(rec)
    ml.resolveApproval('rec-1', 'reject')
    expect(ml.state.trust.waiver.approvedStreak).toBe(0)
  })

  it('flags promotion eligibility when streak reaches promoteAt', () => {
    const ml = MissionLedger.load(dir)
    ml.state.trust.waiver.approvedStreak = 2
    ml.addPending(rec)
    const res = ml.resolveApproval('rec-1', 'approve')
    expect(res?.promotionEligible).toBe(true)
    // Phase B: mode must NOT flip automatically
    expect(ml.state.trust.waiver.mode).toBe('ask')
  })

  it('resolveApproval returns null for unknown recId', () => {
    const ml = MissionLedger.load(dir)
    expect(ml.resolveApproval('nope', 'approve')).toBeNull()
  })

  it('unknown actionType (e.g. info) resolves without touching trust', () => {
    const ml = MissionLedger.load(dir)
    ml.addPending({ ...rec, id: 'rec-2', actionType: 'info' })
    const res = ml.resolveApproval('rec-2', 'approve')
    expect(res).not.toBeNull()
    expect(res?.promotionEligible).toBe(false)
  })

  it('survives a corrupt state.json: backs it up and starts fresh', () => {
    writeFileSync(join(dir, 'state.json'), '{"lastSeen": {tru', 'utf-8') // truncated write
    const ml = MissionLedger.load(dir)
    expect(ml.state.failureStreak).toBe(0)
    expect(ml.state.trust.waiver.approvedStreak).toBe(0)
    // corrupt original preserved for forensics
    expect(readFileSync(join(dir, 'state.json.corrupt'), 'utf-8')).toBe('{"lastSeen": {tru')
  })

  it('recentRuns skips unparseable lines instead of throwing', () => {
    const ml = MissionLedger.load(dir)
    ml.recordRun({ ts: 't1', triggerId: 'daily-news', ok: true, summary: 'a', recommendationIds: [] })
    appendFileSync(join(dir, 'runs.jsonl'), '{"ts":"t2","trunc', 'utf-8') // crash mid-append
    appendFileSync(join(dir, 'runs.jsonl'), '\n', 'utf-8')
    ml.recordRun({ ts: 't3', triggerId: 'daily-news', ok: true, summary: 'c', recommendationIds: [] })
    const runs = ml.recentRuns(5)
    expect(runs.map(r => r.ts)).toEqual(['t1', 't3'])
  })

  it('resolveApproval ignores prototype keys like "constructor"', () => {
    const ml = MissionLedger.load(dir)
    expect(ml.resolveApproval('constructor', 'approve')).toBeNull()
    expect(ml.resolveApproval('__proto__', 'approve')).toBeNull()
  })
})
