import { describe, it, expect } from 'vitest'
import { decide, runWave, waveContext, budgetSpent, defaultIo } from '../cynco-campaign.mjs'
import { adopt } from '../cynco-campaign-adopt.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

  // Task 11, live proof 3: dispatch-mission.sh handed back an MSYS pseudo-PID,
  // process.kill() could not see it, and the runner faulted a wave that was in
  // fact running — engine up, invariants armed, nobody waiting for it. The
  // fault is still right (the runner cannot wait on a PID it cannot see); what
  // must never happen again is it reading as "the driver exited".
  it('names the broken PID handoff instead of blaming the driver', async () => {
    const state = freshState()
    const seen = {}
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: false, pidUnseen: 2544 }),
      readRow: () => null,
      salvageOf: () => null,
      notify: async (t) => { seen.notified = t; return true },
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/pid 2544 was already invisible/)
    expect(rec.decision.why).toMatch(/may still be running unwatched/)
    expect(rec.decision.why).toMatch(/driver_c8-wave1\.log/)
    expect(seen.notified).toMatch(/FAULT/)
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

  // Review round 1: a wave-1 fault advances waveCount without ever writing a
  // lastGrade. The next invocation must fall back to the calibration instead of
  // dereferencing it.
  it('generates wave 2 from the calibration after a wave-1 fault left no grade', async () => {
    const state = freshState()
    await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: true }),
      missionIdFrom: () => null,
      readRow: () => null,
      salvageOf: () => null,
      notify: async () => true,
    })
    expect(state.state.waveCount).toBe(1)
    expect(state.state.lastGrade).toBeUndefined()
    // --dry-run's context helper must survive the same state
    const ctx = waveContext(spec, state.state, { salvageOf: () => null })
    expect(ctx.wave).toBe(2)
    expect(ctx.fails.map(f => f.id)).toEqual(['C8.1a'])

    let brief = null
    const rec = await runWave(spec, state, {
      writeBrief: (p, text) => { brief = text; return p },
      dispatch: async () => ({ missionId: 'c8-wave2-1' }),
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', toolStats: {} }),
      commitsBetween: () => [],
      grade: async () => g(),
      salvageOf: () => null,
      patchRow: () => {},
      commit: () => ({ sha: 'v2' }),
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
    })
    expect(brief).toMatch(/MISSION C8 WAVE 2/)
    expect(brief).toMatch(/C8\.1a: FAIL x/)
    expect(rec.decision.kind).toBe('next')
  })

  // Review round 1: pins the `waveCount: wave` fix — decide must see the wave
  // this run makes, not the count before it.
  it('spends the budget on the wave that reaches it, not one wave later', async () => {
    const gradedIo = {
      writeBrief: (p) => p,
      dispatch: async () => ({ missionId: 'c8-wave1-1' }),
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', toolStats: {} }),
      commitsBetween: () => [{ sha: 'h', subject: 'c' }],
      grade: async () => g(),
      salvageOf: () => null,
      patchRow: () => {},
      commit: () => ({ sha: 'v1' }),
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
    }
    const one = await runWave({ ...spec, budget: { ...spec.budget, waves: 1 } }, freshState(), gradedIo)
    expect(one.decision.kind).toBe('budget')
    const two = await runWave({ ...spec, budget: { ...spec.budget, waves: 2 } }, freshState(), gradedIo)
    expect(two.decision.kind).toBe('next')
  })

  // Review round 1: a throw in grade/patch/verdict must not lose the wave.
  it('records a fault and advances the wave when a post-run step throws', async () => {
    const state = freshState()
    const seen = {}
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ missionId: 'c8-wave1-1' }),
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', toolStats: {} }),
      grade: async () => { throw new Error('gate exploded') },
      salvageOf: () => null,
      notify: async (t) => { seen.notified = t; return true },
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/post-run step failed: gate exploded/)
    expect(seen.notified).toMatch(/gate exploded/)
    expect(state.state.waveCount).toBe(1)
    expect(state.waves()).toHaveLength(1)
    expect(new CampaignState(state.dir).load().state.waveCount).toBe(1)
  })

  it('never lets a throwing notify cost the wave record', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: true }),
      missionIdFrom: () => null,
      readRow: () => null,
      salvageOf: () => null,
      notify: async () => { throw new Error('ntfy down') },
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.notified).toBe(false)
    expect(state.waves()).toHaveLength(1)
    expect(state.state.pendingNotifications).toHaveLength(1)
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

// Task 11: adopting a wave that already ran. The adoption marks the row; the
// wave is still counted where every other wave is counted — after it is graded.
describe('adopt', () => {
  it('marks the row and pins lastBase without spending a wave', () => {
    const state = freshState()
    state.state.waveCount = 0
    const row = { missionId: 'c8-wave1-1788634174399', briefFile: 'docs/civkings-redesign-briefs/c8-wave1.txt', commitRange: { base: '1d03308', head: '1bc0f8c' } }
    const r = adopt(state, row.missionId, row)
    expect(r).toMatchObject({ missionId: row.missionId, base: '1d03308', briefFile: row.briefFile })
    expect(state.state.adoptedRow).toBe(row.missionId)
    expect(state.state.lastBase).toBe('1d03308')
    expect(state.state.waveCount).toBe(0)
    // persisted, not just held in memory — the runner is a separate process
    const reloaded = new CampaignState(state.dir).load().state
    expect(reloaded.adoptedRow).toBe(row.missionId)
    expect(reloaded.lastBase).toBe('1d03308')
    expect(reloaded.waveCount).toBe(0)
  })

  it('refuses a row with no commit range — there is nothing to grade', () => {
    expect(() => adopt(freshState(), 'm1', { missionId: 'm1' })).toThrow(/commitRange\.base/)
  })
})

describe('runWave with an adopted row', () => {
  it('starts at GRADE: no dispatch, no brief written, the adopted row graded', async () => {
    const state = freshState()
    state.state.adoptedRow = 'c8-wave1-1788634174399'
    const seen = { dispatched: 0, briefs: 0, ideated: 0 }
    const rec = await runWave({ ...spec, ideation: { enabled: true } }, state, {
      writeBrief: (p) => { seen.briefs++; return p },
      dispatch: async () => { seen.dispatched++; return { missionId: 'nope' } },
      waitForDriver: async () => { throw new Error('waitForDriver must not run for an adopted row') },
      engineLive: async () => false,
      ideate: async () => { seen.ideated++; return { ideation: null } },
      readRow: (missionId) => ({ missionId, briefFile: 'docs/civkings-redesign-briefs/c8-wave1.txt', exitReason: 'timeout', durationS: 28824, commitRange: { base: '1d03308', head: '1bc0f8c' }, outcome: 'landed', toolStats: {} }),
      commitsBetween: () => [{ sha: '1bc0f8c', subject: 'C8 wave 1' }],
      grade: async () => g(),
      salvageOf: () => null,
      patchRow: (missionId, fields) => { seen.patched = { missionId, fields } },
      commit: (args) => { seen.files = args.files; return { sha: 'v1' } },
      notify: async () => true,
      economics: () => [],
      appendLog: (text) => { seen.log = text },
    })
    expect(seen.dispatched).toBe(0)
    expect(seen.briefs).toBe(0)
    expect(seen.ideated).toBe(0)
    expect(rec.wave).toBe(1)
    expect(rec.missionId).toBe('c8-wave1-1788634174399')
    expect(seen.patched.missionId).toBe('c8-wave1-1788634174399')
    expect(seen.log).toMatch(/^## C8 wave 1 — c8-wave1-1788634174399/)
    expect(seen.files).toContain('docs/civkings-redesign-briefs/campaign-log.md')
    // the sidecar of a hand-written brief does not exist; `git add` refuses the
    // whole list when one pathspec matches nothing, so it must not be named
    expect(seen.files).not.toContain('docs/civkings-redesign-briefs/c8-wave1.contract.json')
    expect(state.state.adoptedRow).toBeUndefined()
    expect(state.state.waveCount).toBe(1)
    expect(new CampaignState(state.dir).load().state.adoptedRow).toBeUndefined()
  })

  it('refuses an adopted missionId the ledger does not have', async () => {
    const state = freshState()
    state.state.adoptedRow = 'ghost-1'
    await expect(runWave(spec, state, { readRow: () => null, salvageOf: () => null })).rejects.toThrow(/not in the ledger/)
    expect(state.state.waveCount).toBe(0)
  })
})

describe('defaultIo.waitForDriver', () => {
  const pidFileWith = (pid) => { const p = join(mkdtempSync(join(tmpdir(), 'camp-pid-')), 'driver.pid'); writeFileSync(p, `${pid}\n`); return p }

  it('reports pidUnseen when the pid is not visible on the first probe', async () => {
    // 0x7ffffffe: a pid no process can hold — the same shape as an MSYS
    // pseudo-PID handed to a non-MSYS waiter.
    const r = await defaultIo.waitForDriver({ pidFile: pidFileWith(2147483646), driverLog: 'C:/tmp/d.log', timeoutMs: 60_000 })
    expect(r).toEqual({ exited: false, pidUnseen: 2147483646 })
  })

  it('does not call a live driver exited when the wall clock runs out', async () => {
    const r = await defaultIo.waitForDriver({ pidFile: pidFileWith(process.pid), driverLog: 'C:/tmp/d.log', timeoutMs: 50 })
    expect(r).toEqual({ exited: false })
  })
})

describe('budgetSpent', () => {
  it('is false while waves remain and true once they are gone', () => {
    expect(budgetSpent({ state: { waveCount: 0 } }, spec)).toBe(false)
    expect(budgetSpent({ state: { waveCount: 2 } }, spec)).toBe(false)
    expect(budgetSpent({ state: { waveCount: 3 } }, spec)).toBe(true)
    expect(budgetSpent({ state: { waveCount: 9 } }, spec)).toBe(true)
  })
  it('treats a fresh state with no counter as unspent', () => {
    expect(budgetSpent({ state: {} }, spec)).toBe(false)
  })
})
