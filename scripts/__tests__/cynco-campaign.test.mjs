import { describe, it, expect } from 'vitest'
import { decide, runWave } from '../cynco-campaign.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spec = { id: 'c8', title: 't', repo: 'C:/repo', base: '1d03308', marker: 'stage c8 complete', keepGreen: 'python -m pytest a.py -q',
  budget: { hoursPerWave: 1, iterations: 100, bashTimeoutMs: 1000, waves: 3 }, invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, allow: { newFiles: [], edit: [] }, deny: [], measures: 'M', work: [{ id: 1, title: 'W', gateIds: ['C8.1a'], text: 't' }], rules: [], ideation: { enabled: false } }
const g = (over = {}) => ({ sha: 'h', verified: false, gate: { terminator: 'MISS', fails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], passes: [], failCount: 1, errors: [], harnessFault: null, exit: 1, priorRegressions: 0 }, suite: { exit: 0, regressions: [], repairs: [], harnessFault: null }, sweep: { kind: 'derived', killed: 1, total: 1, survived: [] }, posiwid: { verdict: 'Consistent', divergence: 0, dominantObserved: 'inspect' }, ...over })

describe('decide', () => {
  it('pass when gate PASS, suite PASS, no survivors', () => {
    expect(decide({ grade: g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], exit: 0 } }), state: { waveCount: 1, consecutiveNoProgress: 0, lastFails: null }, spec, commitsLanded: 3 }).kind).toBe('pass')
  })
  it('fault on a harness fault', () => { expect(decide({ grade: g({ verified: null }), state: { waveCount: 1, consecutiveNoProgress: 0 }, spec, commitsLanded: 0 }).kind).toBe('fault') })
  it('budget when the wave budget is spent', () => { expect(decide({ grade: g(), state: { waveCount: 3, consecutiveNoProgress: 0, lastFails: ['C8.1a'] }, spec, commitsLanded: 1 }).kind).toBe('budget') })
  it('no-progress after two waves with the same FAIL set and no commits', () => {
    expect(decide({ grade: g(), state: { waveCount: 2, consecutiveNoProgress: 1, lastFails: ['C8.1a'] }, spec, commitsLanded: 0 }).kind).toBe('no-progress')
    expect(decide({ grade: g(), state: { waveCount: 2, consecutiveNoProgress: 1, lastFails: ['C8.1a'] }, spec, commitsLanded: 2 }).kind).toBe('next')
  })
  // Ruling 2: a wave the engine ran WITHOUT its invariants measured nothing the
  // campaign asked for, however green it looks. It is a fault before anything else.
  it('fault when the engine rejected the mission invariants, even on a PASS grade', () => {
    const passing = g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], exit: 0 } })
    const d = decide({ grade: passing, state: { waveCount: 1, consecutiveNoProgress: 0, lastFails: null }, spec, commitsLanded: 3, row: { invariantsRejected: true } })
    expect(d.kind).toBe('fault')
    expect(d.why).toMatch(/without its invariants/)
  })
  it('does not fault when invariantsRejected is absent or false', () => {
    expect(decide({ grade: g(), state: { waveCount: 1, consecutiveNoProgress: 0, lastFails: null }, spec, commitsLanded: 1, row: { invariantsRejected: false } }).kind).toBe('next')
    expect(decide({ grade: g(), state: { waveCount: 1, consecutiveNoProgress: 0, lastFails: null }, spec, commitsLanded: 1 }).kind).toBe('next')
  })
})

const freshState = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'camp-')), 'c8')
  const state = new CampaignState(dir).load()
  state.state.calibration = { gateSha256: 'g', perturbSha256: 'p', baseFails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }] }
  state.state.lastBase = '1d03308'; state.state.lastFails = ['C8.1a']
  return state
}

describe('runWave', () => {
  it('drives one wave through the injected io and records it', async () => {
    const state = freshState()
    const seen = {}
    const io = {
      writeBrief: (path, text, sidecar) => { seen.brief = text; seen.sidecar = sidecar; return path },
      dispatch: async ({ briefFile, invariants }) => { seen.invariants = invariants; return { missionId: 'c8-wave1-1', driverLog: 'C:/tmp/d.log' } },
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'timeout', durationS: 100, commitRange: { base: '1d03308', head: 'h' }, outcome: 'landed', toolStats: { total: 10, commits: 1, byClass: { sourceEdit: 2, fileWrite: 0, inspect: 8 }, byName: {} } }),
      commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }],
      grade: async () => g(),
      salvageOf: () => null,
      ideate: async () => ({ ideation: null }),
      patchRow: (missionId, fields) => { seen.patched = fields },
      commit: () => ({ sha: 'v1' }),
      notify: async (t) => { seen.notified = t; return true },
      economics: () => ['VERDICT: x'],
      appendLog: (text) => { seen.log = text },
    }
    const rec = await runWave(spec, state, io)
    expect(seen.brief).toMatch(/MISSION C8 WAVE 1/)
    expect(seen.sidecar.assertions[0].command).toBe(spec.keepGreen)
    expect(seen.invariants).toEqual(spec.invariants)
    expect(seen.patched).toMatchObject({ verified: false, gate: { terminator: 'MISS' } })
    expect(seen.log).toMatch(/^## C8 wave 1 — c8-wave1-1/)
    expect(seen.notified).toMatch(/C8\.1a: FAIL x/)
    expect(rec.decision.kind).toBe('next')
    expect(state.state.waveCount).toBe(1)
    expect(state.state.lastBase).toBe('h')
    expect(state.waves()).toHaveLength(1)
  })

  // Ruling 5: the verdict commit names repo-relative, forward-slash paths —
  // commitVerdict compares them against `git status --porcelain` output.
  it('passes repo-relative forward-slash paths to the verdict commit', async () => {
    const state = freshState()
    let files = null
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ missionId: 'c8-wave1-1' }),
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', toolStats: {} }),
      commitsBetween: () => [],
      grade: async () => g(),
      salvageOf: () => null,
      patchRow: () => {},
      commit: (args) => { files = args.files; return { sha: 'v1' } },
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
    })
    expect(rec.verdictSha).toBe('v1')
    expect(files).toContain('docs/civkings-redesign-briefs/campaign-log.md')
    expect(files).toContain('docs/civkings-redesign-briefs/c8-wave1.txt')
    expect(files).toContain('docs/civkings-redesign-briefs/c8-wave1.contract.json')
    for (const f of files) { expect(f).not.toMatch(/\\/); expect(f).not.toMatch(/^[A-Za-z]:/) }
  })

  // Ruling 8: an engine fault that leaves no ledger row still SPENDS a wave.
  it('records a fault and still counts the wave when no ledger row appears', async () => {
    const state = freshState()
    const seen = {}
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: true }),
      missionIdFrom: () => null,
      readRow: () => null,
      salvageOf: () => null,
      notify: async (t) => { seen.notified = t; return true },
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/without a ledger row/)
    expect(seen.notified).toMatch(/FAULT/)
    expect(state.state.waveCount).toBe(1)
    expect(state.waves()).toHaveLength(1)
    // persisted, not just held in memory — the next process must see the spend
    expect(new CampaignState(state.dir).load().state.waveCount).toBe(1)
  })

  it('records a fault when the driver never exits', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: false }),
      readRow: () => null,
      salvageOf: () => null,
      notify: async () => true,
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/wall clock/)
    expect(state.state.waveCount).toBe(1)
  })

  // Ruling 7: the advisory occupant may not share the GPU with the wave.
  const ideationSpec = { ...spec, ideation: { enabled: true } }
  const ideationIo = (over) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', toolStats: {} }),
    commitsBetween: () => [],
    firstCommitFiles: () => ['gilded/ui/atlas_view.py'],
    grade: async () => g(),
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...over,
  })

  it('skips ideation while an engine holds the GPU', async () => {
    let ideated = false
    const rec = await runWave(ideationSpec, freshState(), ideationIo({
      engineLive: async () => true,
      ideate: async () => { ideated = true; return { ideation: null } },
    }))
    expect(ideated).toBe(false)
    expect(rec.s4.ideation).toBe(null)
    expect(rec.s4.ideationMeta.error).toBe('engine busy')
  })

  it('runs ideation when no engine is live and records what was followed', async () => {
    const rec = await runWave(ideationSpec, freshState(), ideationIo({
      engineLive: async () => false,
      ideate: async () => ({ ideation: { hypotheses: [{ gateId: 'C8.1a', cause: 'c', firstEdit: 'gilded/ui/atlas_view.py' }], order: ['C8.1a'], trap: null }, taskPath: 't.json', durationMs: 5 }),
    }))
    expect(rec.s4.ideation.hypotheses).toHaveLength(1)
    expect(rec.s4.ideationMeta).toMatchObject({ taskPath: 't.json', durationMs: 5, error: null })
    expect(rec.s4.followed).toBe(true)
    expect(rec.s4.commander).toBe('generator')
  })
})
