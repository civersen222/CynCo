import { describe, it, expect } from 'vitest'
import { decide, runWave, waveContext, budgetSpent, defaultIo, claimedSurvivors, dispatchEnv, waveEnvBase, dirtyOutsideCampaign, inFlightRefusal, adoptInFlight, takeLock, releaseLock, applyProposalDecision, recordReseal, main } from '../cynco-campaign.mjs'
import { summarize as summarizeGateLines } from '../cynco-gate-lines.mjs'
import { adopt } from '../cynco-campaign-adopt.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { promotionProposal } from '../cynco-ideation.mjs'
import { readSeats, writeSeats } from '../cynco-proposals.mjs'
import { defaultIo as calibrateIo } from '../cynco-campaign-calibrate.mjs'
import { writeRuleVerdicts as realWriteRuleVerdicts, main as verdictsMain } from '../cynco-rule-verdicts.mjs'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// runWave only ever sha256s spec.gate / spec.perturb (the Rule-11 re-check), so
// three real files stand in for the sealed instruments here and the shas below
// are computed exactly the way the runner computes them. Phase 4: the identity
// assertion at VERDICT refuses an instrument that is not under
// `.cynco/heldout/`, so the stand-ins are copied into a temp heldout tree
// rather than read from scripts/ where no sealed gate would ever live.
const HELDOUT = join(mkdtempSync(join(tmpdir(), 'inst-')), '.cynco', 'heldout', 'c8')
mkdirSync(HELDOUT, { recursive: true })
const standIn = (src, name) => { const p = join(HELDOUT, name); copyFileSync(fileURLToPath(new URL(src, import.meta.url)), p); return p }
const GATE = standIn('../cynco-campaign-grade.mjs', 'gate_c8.py')
const PERTURB = standIn('../cynco-campaign-spec.mjs', 'perturb_c8.py')
const POSITIVE = standIn('../cynco-gate-lint.mjs', 'positive_c8.py')
// The per-wave identity check calls checkIdentity, which asks git whether
// spec.base is a commit in spec.repo — 'C:/repo' is not a repo, so every io
// that reaches VERDICT hands over a passing check. The failing case is below.
const okIdentity = () => ({ ok: true, problems: [] })

const spec = { id: 'c8', title: 't', repo: 'C:/repo', base: '1d03308', marker: 'stage c8 complete', keepGreen: 'python -m pytest a.py -q',
  gate: GATE, perturb: PERTURB,
  budget: { hoursPerWave: 1, iterations: 100, bashTimeoutMs: 1000, waves: 3 }, invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, allow: { newFiles: ['gilded/ui/portraits.py', 'gilded/assets/portraits/**'], edit: ['gilded/ui/atlas_view.py', 'gilded/ui/registry.py (legend rows only)'] },
  deny: [], measures: 'M', work: [{ id: 1, title: 'W', gateIds: ['C8.1a'], text: 't' }], rules: [], ideation: { enabled: false } }
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
  state.state.calibration = { gateSha256: calibrateIo.sha256(GATE), perturbSha256: calibrateIo.sha256(PERTURB), baseFails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], basePasses: [] }
  state.state.lastBase = '1d03308'; state.state.lastFails = ['C8.1a']
  return state
}

// M1: runWave calls io.exportTriples on EVERY wave (the Level 4 spine). The io
// fakes below predate that call, and every one of them used to print
// "[campaign] triples export/analysis skipped: io.exportTriples is not a
// function" — noise loud enough to hide the day a real export breaks. An inert
// export keeps them quiet; defaulting io.exportTriples to the real exporter
// would instead drag the real ledger into a unit test.
const inertTriples = {
  exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} } }),
  analyseDenials: () => null,
  // Same reasoning for the gate-lines export the VERDICT now regenerates: the
  // real exporter reads ~/.cynco/campaigns, and a unit test must never drag the
  // live campaign dir in. `null` is what a campaign with no evidence yet looks
  // like, so the promotion and the verdict line both stay quiet.
  exportGateLines: () => ({ rows: [], summary: null }),
  // …and the campaign-level gate-outcomes export beside it (Phase 4).
  exportGateOutcomes: () => ({ rows: [], outPath: null }),
  // Phase 4: the rule verdicts are recomputed from the ledger at every VERDICT.
  // The real reader walks ~160 MB of shards; a unit test hands over none.
  readLedgerRows: () => [],
}

// Final review M5 (T7-M3): the fault path computes a board too, and without
// these seams it falls through to defaultIo — the ~160 MB shard walk and the
// REAL home's rule-verdicts.json. A literal fault io spreads this in.
const faultIo = () => ({ readLedgerRows: () => [], datasetsHome: () => mkdtempSync(join(tmpdir(), 'ds-faultio-')), economics: () => null })

/** A gate-lines summary with `held` of `n` CynCo lines and `hHeld` of `hN` human ones. */
const gateLineSummary = (held, n, hHeld, hN) => summarizeGateLines([
  ...Array.from({ length: held }, (_, i) => ({ author: 'cynco', outcome: 'held', lineId: `c${i}` })),
  ...Array.from({ length: n - held }, (_, i) => ({ author: 'cynco', outcome: 'resealed', lineId: `cr${i}` })),
  ...Array.from({ length: hHeld }, (_, i) => ({ author: 'human', outcome: 'held', lineId: `h${i}` })),
  ...Array.from({ length: hN - hHeld }, (_, i) => ({ author: 'human', outcome: 'resealed', lineId: `hr${i}` })),
])

describe('runWave', () => {
  it('drives one wave through the injected io and records it', async () => {
    const state = freshState()
    const seen = {}
    const io = {
      writeBrief: (path, text, sidecar) => { seen.brief = text; seen.sidecar = sidecar; return path },
      dispatch: async ({ briefFile, invariants }) => { seen.invariants = invariants; return { missionId: 'c8-wave1-1', driverLog: 'C:/tmp/d.log' } },
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'timeout', durationS: 100, commitRange: { base: '1d03308', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: { total: 10, commits: 1, byClass: { sourceEdit: 2, fileWrite: 0, inspect: 8 }, byName: {} } }),
      commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null,
      ideate: async () => ({ ideation: null }),
      patchRow: (missionId, fields) => { seen.patched = fields },
      commit: () => ({ sha: 'v1' }),
      notify: async (t) => { seen.notified = t; return true },
      economics: () => ['VERDICT: x'],
      appendLog: (text) => { seen.log = text },
      ...inertTriples,
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
    expect(seen.patched.sweepRetried).toBe(false)
  })

  // Review M5 (F164): a refusal that survived its --mutate retry is told apart
  // on the ROW, not only on the wave record.
  it('patches sweepRetried onto the row beside a doubly refused sweepFault', async () => {
    const state = freshState()
    const seen = {}
    const io = {
      writeBrief: (path) => path,
      dispatch: async () => ({ missionId: 'c8-wave1-1', driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'timeout', durationS: 100, commitRange: { base: '1d03308', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: { total: 10, commits: 1, byClass: { sourceEdit: 2, fileWrite: 0, inspect: 8 }, byName: {} } }),
      commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }],
      grade: async () => ({ ...g(), sweep: null, sweepFault: 'sweep refused (exit 2)', sweepRetried: true }), checkIdentity: okIdentity,
      salvageOf: () => null,
      ideate: async () => ({ ideation: null }),
      patchRow: (missionId, fields) => { seen.patched = fields },
      commit: () => ({ sha: 'v1' }),
      notify: async () => true,
      economics: () => ['VERDICT: x'],
      appendLog: () => {},
      ...inertTriples,
    }
    await runWave(spec, state, io)
    expect(seen.patched).toMatchObject({ sweepFault: 'sweep refused (exit 2)', sweepRetried: true })
    expect('mutationSweep' in seen.patched).toBe(false)
    expect(state.waves()[0].sweepRetried).toBe(true)
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
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
      commitsBetween: () => [],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null,
      patchRow: () => {},
      commit: (args) => { files = args.files; return { sha: 'v1' } },
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
      ...inertTriples,
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
      ...faultIo(),
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
      ...faultIo(),
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
      ...faultIo(),
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/wall clock/)
    expect(state.state.waveCount).toBe(1)
  })

  // Task 2 review N1 + Task 3 review M2: a no-row fault spent GPU time and a
  // wave. Its record carries the wall clock since dispatch as durationS (else
  // the pooled PASS/GPU-h is null for good) and a board reading (else the
  // dashboard's last board undercounts the campaign's waves).
  it('a no-row fault carries durationS = wall clock since dispatch, and a board that counts it', async () => {
    const state = freshState()
    const home = mkdtempSync(join(tmpdir(), 'ds-fault-'))
    let dispatchedMs = null
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => { dispatchedMs = Date.now(); return { driverLog: 'C:/tmp/d.log' } },
      waitForDriver: async () => ({ exited: false }),
      readRow: () => null,
      salvageOf: () => null,
      notify: async () => true,
      // 2 h 30 s after the dispatch stamp
      now: () => Date.parse(state.state.inFlight?.dispatchedAt ?? new Date(dispatchedMs).toISOString()) + 7230_000,
      datasetsHome: () => home, readLedgerRows: () => [], economics: () => null,
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.durationS).toBe(7230)
    expect(rec.durationFrom).toBe('wall-clock')
    expect(rec.scoreboard).toMatchObject({ id: 'c8', decided: false, decision: 'fault', waves: 1, gpuHours: 7230 / 3600, gpuHoursMissing: [] })
    expect(state.waves().at(-1).scoreboard).toEqual(rec.scoreboard)
  })

  it('a board that throws on the fault path is { error } and the fault is still recorded', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: false }),
      readRow: () => null, salvageOf: () => null, notify: async () => true,
      readLedgerRows: () => [], scoreboard: () => { throw new Error('boom') },
    })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.scoreboard).toEqual({ error: 'boom' })
    expect(state.state.waveCount).toBe(1)
    expect(state.waves()).toHaveLength(1)
  })

  // Ruling 7: the advisory occupant may not share the GPU with the wave.
  const ideationSpec = { ...spec, ideation: { enabled: true } }
  const ideationIo = (over) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    firstCommitFiles: () => ['gilded/ui/atlas_view.py'],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
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
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
      commitsBetween: () => [],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null,
      patchRow: () => {},
      commit: () => ({ sha: 'v2' }),
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
      ...inertTriples,
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
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
      commitsBetween: () => [{ sha: 'h', subject: 'c' }],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null,
      patchRow: () => {},
      commit: () => ({ sha: 'v1' }),
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
      ...inertTriples,
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
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
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
    // the row's own duration wins over the wall clock (Task 2 review N1)
    expect(rec.durationS).toBe(10)
    expect(rec.durationFrom).toBe('row')
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
      // T7-M1: the HEAD-vs-base check guards a DISPATCH; an adopted wave already ran.
      repoHead: () => { throw new Error('repoHead must not run for an adopted row') },
      engineLive: async () => false,
      ideate: async () => { seen.ideated++; return { ideation: null } },
      readRow: (missionId) => ({ missionId, briefFile: 'docs/civkings-redesign-briefs/c8-wave1.txt', exitReason: 'timeout', durationS: 28824, commitRange: { base: '1d03308', head: '1bc0f8c' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
      commitsBetween: () => [{ sha: '1bc0f8c', subject: 'C8 wave 1' }],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null,
      patchRow: (missionId, fields) => { seen.patched = { missionId, fields } },
      commit: (args) => { seen.files = args.files; return { sha: 'v1' } },
      notify: async () => true,
      economics: () => [],
      appendLog: (text) => { seen.log = text },
      ...inertTriples,
    })
    expect(seen.dispatched).toBe(0)
    expect(seen.briefs).toBe(0)
    expect(seen.ideated).toBe(0)
    expect(rec.wave).toBe(1)
    expect(rec.missionId).toBe('c8-wave1-1788634174399')
    // Phase 5 ruling 2: a hand-off is a human intervention, and the record says so
    expect(rec.adopted).toBe(true)
    expect(rec.scoreboard.humanInterventionsPerWave).toMatchObject({ adopted: 1, value: 1 })
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
    expect(r).toEqual({ exited: false, timedOut: true })
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

// C1: `pass` was unreachable — ANY sweep survivor denied it, and the sweep
// mutates the whole diff, including files the campaign was forbidden to edit.
// Spec §3.2 only ever claimed "a survivor a work[] item claims".
describe('decide — a green gate must be able to PASS', () => {
  const green = (survived) => g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], exit: 0 }, sweep: { kind: 'derived', killed: 4, total: 6, survived } })
  const st = { waveCount: 1, consecutiveNoProgress: 0, lastFails: null }

  it('passes when every survivor is outside the files the campaign claimed', () => {
    const d = decide({ grade: green(['gilded/tests/test_atlas_actions_m7.py:12', 'gilded/society/beats.py:88']), state: st, spec, commitsLanded: 2 })
    expect(d.kind).toBe('pass')
    expect(d.why).toMatch(/2 survivor\(s\).*none inside a claimed file/)
  })

  it('reports pass-with-survivors when a survivor sits in a claimed file', () => {
    const d = decide({ grade: green(['gilded/tests/test_atlas_actions_m7.py:12', 'gilded/ui/atlas_view.py:214']), state: st, spec, commitsLanded: 2 })
    expect(d.kind).toBe('pass-with-survivors')
    expect(d.survivors).toEqual(['gilded/ui/atlas_view.py:214'])
  })

  it('still passes with no survivors and with no sweep at all', () => {
    expect(decide({ grade: green([]), state: st, spec, commitsLanded: 2 }).kind).toBe('pass')
    expect(decide({ grade: g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], exit: 0 }, sweep: null }), state: st, spec, commitsLanded: 2 }).kind).toBe('pass')
  })
})

describe('claimedSurvivors', () => {
  it('matches allow entries through their globs, notes and backslashes', () => {
    expect(claimedSurvivors(['gilded/ui/atlas_view.py:1'], spec)).toEqual(['gilded/ui/atlas_view.py:1'])
    // "gilded/ui/registry.py (legend rows only)" — the note is not part of the path
    expect(claimedSurvivors(['gilded\\ui\\registry.py:9'], spec)).toEqual(['gilded\\ui\\registry.py:9'])
    // "gilded/assets/portraits/**" — the glob is a prefix
    expect(claimedSurvivors(['gilded/assets/portraits/man_01.jpg:0'], spec)).toHaveLength(1)
    expect(claimedSurvivors(['gilded/society/chassis.py:4', 'gilded/tests/test_c7_history.py:2'], spec)).toEqual([])
    expect(claimedSurvivors([], spec)).toEqual([])
  })
})

describe('runWave — refusals that must not dispatch', () => {
  const noDispatch = (seen) => ({
    sha256: (p) => calibrateIo.sha256(p),
    writeBrief: () => { seen.briefs++; return 'x' },
    dispatch: async () => { seen.dispatched++; return { missionId: 'nope' } },
    salvageOf: () => null,
    notify: async () => true,
  })

  // C1: a PASS grade leaves no FAIL lines, so THE MISSES and THE WORK would both
  // be empty — eight hours of GPU on a blank order.
  it('stops instead of dispatching a brief with no failing gate lines', async () => {
    const state = freshState()
    state.state.lastGrade = { gate: { fails: [], passes: [{ id: 'C8.1a', line: 'C8.1a: PASS' }] } }
    const seen = { briefs: 0, dispatched: 0 }
    const rec = await runWave(spec, state, noDispatch(seen))
    expect(rec.decision).toEqual({ kind: 'stop', why: 'no failing gate lines to work — grade says PASS' })
    expect(seen.dispatched).toBe(0)
    expect(seen.briefs).toBe(0)
    // nothing ran, so nothing was spent
    expect(state.state.waveCount).toBe(0)
    expect(state.waves()).toHaveLength(1)
  })

  // The ideation section is written by a model that just read the repo; a brief
  // naming the sealed gate is refused by sealedPaths AFTER the clock started.
  it('refuses to write a brief that names a sealed instrument', async () => {
    const state = freshState()
    const seen = { briefs: 0, dispatched: 0 }
    const leaky = { ...spec, ideation: { enabled: true } }
    const rec = await runWave(leaky, state, {
      ...noDispatch(seen),
      engineLive: async () => false,
      ideate: async () => ({ ideation: { hypotheses: [{ gateId: 'C8.1a', cause: 'read gate_c8.py to see the floor', firstEdit: 'gilded/ui/atlas_view.py' }], order: ['C8.1a'], trap: null } }),
    })
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toMatch(/names the sealed instrument "gate_c8"/)
    expect(seen.briefs).toBe(0)
    expect(seen.dispatched).toBe(0)
  })
})

// I5: Rule 11 is not a one-off. A gate edited mid-campaign — a fix, a rebase, a
// hand-tweak — makes every reading after it incomparable with wave 1's.
describe('runWave — the instrument must not move under the campaign', () => {
  const noDispatch = (seen) => ({
    sha256: (p) => calibrateIo.sha256(p),
    writeBrief: () => { seen.briefs++; return 'x' },
    dispatch: async () => { seen.dispatched++; return { missionId: 'nope' } },
    salvageOf: () => null,
    notify: async () => true,
  })

  // The refusal names the file the operator has to go and look at. "gate or
  // perturb" sends them to the wrong one two times in three.
  it('stops when the gate sha moved since calibration, and says it was the gate', async () => {
    const state = freshState()
    state.state.calibration.gateSha256 = 'not-the-gate-we-calibrated'
    const seen = { briefs: 0, dispatched: 0 }
    const rec = await runWave(spec, state, noDispatch(seen))
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toBe('gate changed since calibration — re-run to recalibrate')
    expect(seen.dispatched).toBe(0)
    expect(state.state.waveCount).toBe(0)
  })

  it('stops when the perturb sha moved since calibration, and says it was the perturb', async () => {
    const state = freshState()
    state.state.calibration.perturbSha256 = 'moved'
    const rec = await runWave(spec, state, noDispatch({ briefs: 0, dispatched: 0 }))
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toBe('perturb changed since calibration — re-run to recalibrate')
  })

  it('names every instrument that moved when more than one did', async () => {
    const state = freshState()
    state.state.calibration.gateSha256 = 'moved'
    state.state.calibration.perturbSha256 = 'moved'
    state.state.calibration.positiveSha256 = 'moved'
    const rec = await runWave({ ...spec, positive: POSITIVE }, state, noDispatch({ briefs: 0, dispatched: 0 }))
    expect(rec.decision.why).toBe('gate and perturb and positive shim changed since calibration — re-run to recalibrate')
  })

  // The positive shim is part of the instrument (Rule 14): it is what decided
  // the gate was reachable at all, so moving it invalidates the calibration
  // exactly as moving the gate does.
  it('stops when the positive shim sha moved since calibration', async () => {
    const state = freshState()
    state.state.calibration.positiveSha256 = 'moved'
    const seen = { briefs: 0, dispatched: 0 }
    const rec = await runWave({ ...spec, positive: POSITIVE }, state, noDispatch(seen))
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toBe('positive shim changed since calibration — re-run to recalibrate')
    expect(seen.dispatched).toBe(0)
  })

  it('runs the wave when the positive shim is declared and its sha still matches', async () => {
    const state = freshState()
    state.state.calibration.positiveSha256 = calibrateIo.sha256(POSITIVE)
    const rec = await runWave({ ...spec, positive: POSITIVE }, state, {
      writeBrief: (p) => p,
      dispatch: async () => ({ missionId: 'c8-wave1-1' }),
      waitForDriver: async () => ({ exited: true }),
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
      commitsBetween: () => [],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null,
      patchRow: () => {},
      commit: () => ({ sha: 'v1' }),
      notify: async () => true,
      economics: () => [],
      appendLog: () => {},
      ...inertTriples,
    })
    expect(rec.decision.kind).toBe('next')
  })
})

// C2: a runner that dies in the wait leaves a mission on the GPU. The next
// invocation must not dispatch a second one on top of it.
describe('runWave — in-flight state', () => {
  const gradedIo = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    ...over,
  })

  it('persists inFlight the moment dispatch returns and clears it after the grade', async () => {
    const state = freshState()
    let duringWait = null
    await runWave(spec, state, gradedIo({
      waitForDriver: async () => { duringWait = new CampaignState(state.dir).load().state.inFlight; return { exited: true } },
    }))
    expect(duringWait).toMatchObject({ wave: 1, missionId: null, pidFile: 'C:/tmp/driver_c8-wave1.pid', driverLog: 'C:/tmp/driver_c8-wave1.log' })
    expect(duringWait.dispatchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(state.state.inFlight).toBeUndefined()
    expect(new CampaignState(state.dir).load().state.inFlight).toBeUndefined()
  })

  it('clears inFlight on the fault path too', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, gradedIo({ readRow: () => null, missionIdFrom: () => null }))
    expect(rec.decision.kind).toBe('fault')
    expect(new CampaignState(state.dir).load().state.inFlight).toBeUndefined()
  })

  // A throw out of dispatch or wait used to escape runWave entirely: no wave
  // record, no spend, no notification — and main's catch printing a stack.
  it('records a fault when io.dispatch throws instead of letting it escape', async () => {
    const state = freshState()
    const seen = {}
    const rec = await runWave(spec, state, gradedIo({
      dispatch: async () => { throw new Error('dispatch-mission.sh exit 127') },
      notify: async (t) => { seen.notified = t; return true },
    }))
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/dispatch or wait failed: dispatch-mission\.sh exit 127/)
    expect(seen.notified).toMatch(/FAULT/)
    expect(state.state.waveCount).toBe(1)
    expect(new CampaignState(state.dir).load().state.waveCount).toBe(1)
  })

  it('records a fault when io.waitForDriver throws (a missing pid file)', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, gradedIo({ waitForDriver: async () => { throw new Error('ENOENT: driver.pid') } }))
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/ENOENT: driver\.pid/)
    expect(new CampaignState(state.dir).load().state.inFlight).toBeUndefined()
  })

  // I2: the brief and sidecar are untracked after a fault. Left uncommitted they
  // trip the dirty-tree refusal at the NEXT invocation — the campaign bricks
  // itself on files it wrote.
  it('commits the brief and sidecar on the fault path', async () => {
    const state = freshState()
    let committed = null
    await runWave(spec, state, gradedIo({ readRow: () => null, missionIdFrom: () => null, commit: (args) => { committed = args; return { sha: 'f1' } } }))
    expect(committed.branch).toBe('campaign/c8')
    expect(committed.files).toEqual(['docs/civkings-redesign-briefs/c8-wave1.txt', 'docs/civkings-redesign-briefs/c8-wave1.contract.json'])
    expect(committed.message).toBe('C8 wave 1 dispatched, faulted: driver exited without a ledger row')
  })

  it('does not lose the wave when the fault-path commit itself throws', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, gradedIo({ readRow: () => null, missionIdFrom: () => null, commit: () => { throw new Error('tree is dirty') } }))
    expect(rec.decision.kind).toBe('fault')
    expect(state.waves()).toHaveLength(1)
    expect(state.state.waveCount).toBe(1)
  })

  it('uses the missionId the wait read out of the driver log', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, gradedIo({
      dispatch: async () => ({ driverLog: 'C:/tmp/d.log' }),
      waitForDriver: async () => ({ exited: true, missionId: 'c8-wave1-from-the-log' }),
    }))
    expect(rec.missionId).toBe('c8-wave1-from-the-log')
  })
})

describe('inFlightRefusal / adoptInFlight', () => {
  const inFlight = (state, over = {}) => {
    state.state.inFlight = { wave: 2, missionId: null, briefFile: 'docs/civkings-redesign-briefs/c8-wave2.txt', pidFile: 'C:/tmp/driver_c8-wave2.pid', driverLog: 'C:/tmp/driver_c8-wave2.log', dispatchedAt: '2026-09-17T01:02:03.000Z', ...over }
    state.save()
    return state
  }

  it('says nothing when no wave is in flight, and refuses by name when one is', () => {
    expect(inFlightRefusal(freshState())).toBeNull()
    const msg = inFlightRefusal(inFlight(freshState()))
    expect(msg).toMatch(/wave 2 is in flight since 2026-09-17T01:02:03\.000Z/)
    expect(msg).toMatch(/driver log C:\/tmp\/driver_c8-wave2\.log/)
    expect(msg).toMatch(/--adopt-inflight/)
  })

  it('adopts the ledger row the driver log names', async () => {
    const state = inFlight(freshState())
    const r = await adoptInFlight(spec, state, { missionIdFrom: () => 'c8-wave2-1789649392765', pidAlive: () => false })
    expect(r).toEqual({ kind: 'adopted', missionId: 'c8-wave2-1789649392765' })
    const reloaded = new CampaignState(state.dir).load().state
    expect(reloaded.adoptedRow).toBe('c8-wave2-1789649392765')
    expect(reloaded.inFlight).toBeUndefined()
    expect(reloaded.waveCount).toBe(0)
  })

  it('refuses while the driver is still alive and wrote no row', async () => {
    const state = inFlight(freshState())
    const r = await adoptInFlight(spec, state, { missionIdFrom: () => null, pidAlive: () => true })
    expect(r.kind).toBe('alive')
    expect(new CampaignState(state.dir).load().state.inFlight).toBeTruthy()
  })

  it('records a fault when the driver is gone and wrote no row', async () => {
    const state = inFlight(freshState())
    const r = await adoptInFlight(spec, state, { missionIdFrom: () => { throw new Error('ENOENT') }, pidAlive: () => false, notify: async () => true })
    expect(r.kind).toBe('fault')
    expect(r.record.decision.why).toMatch(/gone and wrote no ledger row/)
    // the operator's --adopt-inflight is on the record even when it found nothing to grade
    expect(r.record.adopted).toBe(true)
    expect(new CampaignState(state.dir).waves().at(-1).adopted).toBe(true)
    const reloaded = new CampaignState(state.dir).load().state
    expect(reloaded.inFlight).toBeUndefined()
    expect(reloaded.waveCount).toBe(2)
  })
})

describe('takeLock / releaseLock', () => {
  const lockDir = () => mkdtempSync(join(tmpdir(), 'camp-lock-'))

  it('takes a lock, refuses a live one, and releases it', () => {
    const d = lockDir()
    const a = takeLock(d)
    expect(a.ok).toBe(true)
    expect(readFileSync(join(d, 'runner.lock'), 'utf8')).toBe(String(process.pid))
    const b = takeLock(d)
    expect(b.ok).toBe(false)
    expect(b.pid).toBe(process.pid)
    releaseLock(d)
    expect(existsSync(join(d, 'runner.lock'))).toBe(false)
  })

  it('removes a stale lock whose pid is gone', () => {
    const d = lockDir()
    writeFileSync(join(d, 'runner.lock'), '2147483646')
    expect(takeLock(d).ok).toBe(true)
    expect(readFileSync(join(d, 'runner.lock'), 'utf8')).toBe(String(process.pid))
    releaseLock(d)
  })
})

// I1: the driver writes its ledger row and then tears down. The row is the
// proof the wave is gradeable; the pid is only evidence about a process object.
describe('defaultIo.waitForDriver — the ledger line is the authority', () => {
  const livePidFile = () => { const p = join(mkdtempSync(join(tmpdir(), 'camp-pid-')), 'driver.pid'); writeFileSync(p, `${process.pid}\n`); return p }

  it('returns the missionId as soon as the log has it, while the pid is still alive', async () => {
    let ticks = 0
    const r = await defaultIo.waitForDriver({
      pidFile: livePidFile(), driverLog: 'C:/tmp/d.log', timeoutMs: 5_000, pollMs: 1,
      missionIdFrom: () => (++ticks >= 2 ? 'c8-wave3-1789' : null),
    })
    expect(r).toEqual({ exited: true, missionId: 'c8-wave3-1789' })
    expect(ticks).toBe(2)
  })

  it('returns the missionId from the first look without waiting at all', async () => {
    const r = await defaultIo.waitForDriver({ pidFile: livePidFile(), driverLog: 'C:/tmp/d.log', timeoutMs: 5_000, missionIdFrom: () => 'already-there' })
    expect(r).toEqual({ exited: true, missionId: 'already-there' })
  })
})

// I6: the worker is an unattended model with a Bash tool. Anything in its env
// it can read, print, or post.
// F160 (re-review N-2): a missing Git Bash used to surface as a spent, faulted
// wave, because dispatch was the first spawn. main() checks first and exits 2.
describe('main refuses before touching state when no Git Bash resolves', () => {
  it('returns 2 with the F160 message and never reaches the spec', async () => {
    const errors = []
    const orig = console.error
    console.error = (m) => errors.push(String(m))
    try {
      const code = await main(['C:/nowhere/x.campaign.json', '--waves', '1'], { bashExe: () => { throw new Error('F160: no Git Bash found (no git.exe on PATH) — install Git for Windows or put its bin dir on PATH') } })
      expect(code).toBe(2)
      expect(errors.join('\n')).toMatch(/\[campaign\] F160: no Git Bash found/)
    } finally { console.error = orig }
  })

  // M4 (final review): only the paths that spawn bash refuse. The read-only and
  // decision verbs run without Git Bash.
  const noBash = () => { throw new Error('F160: no Git Bash found (no git.exe on PATH) — install Git for Windows or put its bin dir on PATH') }
  const authorStub = () => {
    const calls = []
    return { calls, authorModule: { defaultAuthorIo: (helpers) => ({ helpers }), authorMain: async (argv) => { calls.push(argv); return 0 }, sealGate: async () => ({ ok: false, problems: ['stub'] }) } }
  }
  const withErrors = async (fn) => {
    const errors = []
    const orig = console.error
    console.error = (m) => errors.push(String(m))
    try { return { code: await fn(), errors: errors.join('\n') } } finally { console.error = orig }
  }

  it('--author still refuses without Git Bash, before the author module runs', async () => {
    const s = authorStub()
    const { code, errors } = await withErrors(() => main(['--author', 'c9'], { authorModule: s.authorModule, bashExe: noBash }))
    expect(code).toBe(2)
    expect(errors).toMatch(/\[campaign\] F160: no Git Bash found/)
    expect(s.calls).toEqual([])
  })

  it('--check runs without Git Bash', async () => {
    const s = authorStub()
    const { code, errors } = await withErrors(() => main(['--check', 'C:/staging/c9', 'C:/tmp/c9_author_base'], { authorModule: s.authorModule, bashExe: noBash }))
    expect(code).toBe(0)
    expect(errors).not.toMatch(/F160/)
    expect(s.calls).toHaveLength(1)
  })

  it('--autopoiesis and --reject-proposal run without Git Bash (their own answers, not F160)', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const heldout = join(home, 'heldout', 'civkings-redesign', 'c8')
    mkdirSync(heldout, { recursive: true })
    for (const n of ['gate_c8.py', 'perturb_c8.py']) writeFileSync(join(heldout, n), '# instrument\n')
    const specPath = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json')
    writeFileSync(specPath, JSON.stringify({ ...spec, repo: '.', gate: join(heldout, 'gate_c8.py'), perturb: join(heldout, 'perturb_c8.py'),
      suiteBaseline: join(heldout, 'suite-baseline.json'), ideation: { enabled: false } }))
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    try {
      const a = await withErrors(() => main([specPath, '--autopoiesis'], { readLedgerRows: () => [], bashExe: noBash }))
      expect(a.code).toBe(2)
      expect(a.errors).toMatch(/--autopoiesis: no campaign state/)
      expect(a.errors).not.toMatch(/F160/)
      const r = await withErrors(() => main(['--reject-proposal', 'gate/c9'], { authorModule: authorStub().authorModule, bashExe: noBash,
        roadmapPath: join(mkdtempSync(join(tmpdir(), 'roadmap-')), 'roadmap.json') }))
      expect(r.errors).not.toMatch(/F160/)
      expect(r.code).toBe(2)
      expect(r.errors).toMatch(/no pending proposal gate\/c9/)
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })
})

describe('dispatchEnv', () => {
  // F161: the spec's env (the engine's explicit llama-server / GGUF paths for a
  // temp home) is laid over the runner's own env BEFORE the stripping, so a
  // spec cannot smuggle a channel the runner strips from itself.
  it('waveEnvBase lays spec.env over the base env, and dispatchEnv still strips it', () => {
    const spec = { env: { LOCALCODE_LLAMA_SERVER: 'C:/x/llama-server.exe', LOCALCODE_MODEL_PATH: 'C:/x/m.gguf' } }
    expect(waveEnvBase(spec, { PATH: '/usr/bin', LOCALCODE_MODEL_PATH: 'stale' })).toEqual({ PATH: '/usr/bin', LOCALCODE_LLAMA_SERVER: 'C:/x/llama-server.exe', LOCALCODE_MODEL_PATH: 'C:/x/m.gguf' })
    expect(waveEnvBase({}, { PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
    expect(dispatchEnv(waveEnvBase({ env: { CYNCO_NTFY_URL: 'http://n' } }, { PATH: '/usr/bin' }), {})).toEqual({ PATH: '/usr/bin' })
  })

  it('strips the ntfy credentials and the GitHub tokens, keeps everything else', () => {
    const env = dispatchEnv({ PATH: '/usr/bin', CYNCO_NTFY_URL: 'http://n', CYNCO_NTFY_TOKEN: 'tk', CYNCO_NTFY_ALERT_TOPIC: 'cynco-alerts', GH_TOKEN: 'gh', GITHUB_TOKEN: 'gh2', CYNCO_GATE_REPO: 'C:/repo' }, { DRIVER_LOG: 'C:/tmp/d.log' })
    expect(env).toEqual({ PATH: '/usr/bin', CYNCO_GATE_REPO: 'C:/repo', DRIVER_LOG: 'C:/tmp/d.log' })
  })

  // Phase 2c-ii: the 9161 dashboard's /api/campaign reads process.env.CYNCO_CAMPAIGN_ID
  // as its fallback `active` campaign when nothing is inFlight — but only if the
  // dispatched engine actually has that var. `defaultIo.dispatch` sets it in the
  // `extra` it hands to dispatchEnv (extra always wins, so it cannot be stripped
  // by the ntfy/GitHub filter above even if a caller's own env happened to carry
  // an unrelated CYNCO_CAMPAIGN_ID already).
  it('carries CYNCO_CAMPAIGN_ID through to the dispatched engine, extra winning over the base env', () => {
    const env = dispatchEnv({ PATH: '/usr/bin', CYNCO_CAMPAIGN_ID: 'stale' }, { CYNCO_CAMPAIGN_ID: 'c8', DRIVER_LOG: 'C:/tmp/d.log' })
    expect(env.CYNCO_CAMPAIGN_ID).toBe('c8')
  })
})

// I2: the runner's OWN untracked briefs must not trip its dirty-tree refusal.
describe('dirtyOutsideCampaign', () => {
  it('exempts the ledger and this campaign\'s untracked briefs, and nothing else', () => {
    const lines = [
      ' M benchmark/cynco-ledger/missions.0004.jsonl',
      '?? docs/civkings-redesign-briefs/c8-wave3.txt',
      '?? docs/civkings-redesign-briefs/c8-wave3.contract.json',
      ' M docs/civkings-redesign-briefs/c8-wave2.txt',
      '?? docs/civkings-redesign-briefs/c7-wave1.txt',
      ' M engine/main.ts',
    ]
    expect(dirtyOutsideCampaign(lines, spec)).toEqual([
      ' M docs/civkings-redesign-briefs/c8-wave2.txt',
      '?? docs/civkings-redesign-briefs/c7-wave1.txt',
      ' M engine/main.ts',
    ])
  })
})

describe('waveContext — Phase 1 fields', () => {
  it('carries the ideation authority, the effective invariants, and the denial digest', () => {
    const s = { waveCount: 1, lastBase: 'abc', lastGrade: null, lastRow: null, ideationAuthority: 0.5, invariantOverrides: { editGapCap: 60 }, denialAnalysis: { invariants: [{ invariant: 'edit-gap', denials: 1, complied: 0, verdict: 'TOO FEW' }] }, calibration: { baseFails: [], basePasses: [] } }
    const ctx = waveContext(spec, s, { salvageOf: () => null })
    expect(ctx.ideationAuthority).toBe(0.5)
    expect(ctx.invariants).toEqual({ ...spec.invariants, editGapCap: 60 })
    expect(ctx.denialDigest).toEqual(s.denialAnalysis.invariants)
    const bare = waveContext(spec, { waveCount: 0, calibration: { baseFails: [], basePasses: [] } }, { salvageOf: () => null })
    expect(bare.ideationAuthority).toBe(0); expect(bare.invariants).toEqual(spec.invariants); expect(bare.denialDigest).toBeNull()
  })
})

// Task 6: the Level 4 spine at VERDICT — every wave regenerates the triples
// dataset, re-asks whether the denials changed anything, records the work
// order it handed to the brief, and raises a cap proposal when a cap is INERT.
describe('runWave — the Level 4 spine at VERDICT', () => {
  const gradedIo = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    readLedgerRows: () => [],
    ...over,
  })

  it('exports the triples, stores the denial analysis, records the work order, and raises a cap proposal when INERT', async () => {
    const state = freshState()
    const seen = { exported: 0, notified: [] }
    const inert = { invariant: 'edit-gap', denials: 80, complied: 2, changed: 3, compliedRate: 0.025, ci: [0.01, 0.09], baseRate: 0.3, p: 0.0001, pAdjusted: 0.0002, verdict: 'INERT' }
    const io = gradedIo({
      exportTriples: () => { seen.exported++; return { summary: { denials: { 'edit-gap': { denials: 80, complied: 2, changed: 3 } }, quiet: { 'edit-gap': { calls: 1000, complied: 300 } } } } },
      analyseDenials: () => ({ invariants: [inert] }),
      notify: async (t) => { seen.notified.push(t); return true },
    })
    const rec = await runWave(spec, state, io)
    expect(seen.exported).toBe(1)
    expect(state.state.denialAnalysis.invariants[0].verdict).toBe('INERT')
    expect(rec.s4.workOrder).toEqual({ applied: false, order: expect.any(Array) })
    expect(state.state.proposals[0]).toMatchObject({ name: 'invariants/editGapCap', newValue: 60, status: 'pending' })
    expect(seen.notified.some(t => /PROPOSAL invariants\/editGapCap/.test(t))).toBe(true)
  })

  it('a failing export never faults the wave', async () => {
    const state = freshState()
    const io = gradedIo({ exportTriples: () => { throw new Error('disk full') } })
    const rec = await runWave(spec, state, io)
    expect(rec.decision.kind).not.toBe('fault')
    expect(state.state.denialAnalysis ?? null).toBeNull()
  })

  // 2d: governance-level POSIWID — one window per wave, replayed fresh every
  // verdict so a runner restart cannot move the onset.
  it('records a governance POSIWID reading and grows the window one wave at a time', async () => {
    const state = freshState()
    const io = gradedIo({
      exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} } }),
      analyseDenials: () => null,
    })
    const rec = await runWave(spec, state, io)
    expect(typeof rec.governancePosiwid.verdict).toBe('string')
    expect(state.state.governancePosiwid.windows).toHaveLength(1)
    expect(state.state.governancePosiwid.windows[0].wave).toBe(1)

    await runWave(spec, state, io)
    expect(state.state.governancePosiwid.windows).toHaveLength(2)
    expect(state.state.governancePosiwid.windows[1].wave).toBe(2)
  })

  // §E: two proposals must not go pending in the same wave. A promotion
  // proposal is computed BEFORE the cap proposal so it can suppress the cap
  // one — otherwise a wave with both an earned-authority signal AND an INERT
  // cap would push two pending proposals at once.
  it('does not also raise a cap proposal in the wave a promotion proposal is raised', async () => {
    const state = freshState()
    // promotionProposal needs >= 8 ideated waves with a significant
    // followed x landed association: 8 followed+landed, 4 not-followed+not-landed.
    for (let i = 0; i < 8; i++) state.appendWave({ wave: i + 1, s4: { ideation: {}, followed: true }, outcome: { landed: true } })
    for (let i = 0; i < 4; i++) state.appendWave({ wave: 8 + i + 1, s4: { ideation: {}, followed: false }, outcome: { landed: false } })
    const inert = { invariant: 'edit-gap', denials: 80, complied: 2, changed: 3, compliedRate: 0.025, ci: [0.01, 0.09], baseRate: 0.3, p: 0.0001, pAdjusted: 0.0002, verdict: 'INERT' }
    const seen = { notified: [] }
    const io = gradedIo({
      exportTriples: () => ({ summary: { denials: { 'edit-gap': { denials: 80, complied: 2, changed: 3 } }, quiet: { 'edit-gap': { calls: 1000, complied: 300 } } } }),
      analyseDenials: () => ({ invariants: [inert] }),
      notify: async (t) => { seen.notified.push(t); return true },
    })
    await runWave(spec, state, io)
    const pending = state.state.proposals.filter(p => p.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].name).toBe('ideation/brief')
    expect(seen.notified.some(t => /PROPOSAL ideation\/brief/.test(t))).toBe(true)
    expect(seen.notified.some(t => /PROPOSAL invariants\//.test(t))).toBe(false)
  })
})

// I1: "campaign to date" is a claim about THIS campaign. The exporter's pooled
// block is every run in the ledger; a c8 verdict that quotes it is quoting c9
// and every hand run too. These two tests use the REAL analyseDenials so the
// verdict is decided by the numbers the runner actually picked up, not by a
// fake that would agree with either block.
describe('runWave — the denial analysis reads THIS campaign, and says so', () => {
  const gradedIo = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    readLedgerRows: () => [],
    ...over,
  })
  // The pooled block reads EFFECTIVE; c8's own block reads INERT. Only a runner
  // reading the campaign block raises the cap proposal.
  const POOLED_EFFECTIVE = { 'edit-gap': { denials: 60, complied: 50, changed: 55 }, 'commit-gap': { denials: 0, complied: 0, changed: 0 }, revert: { denials: 5, complied: 5, changed: 0 } }
  const POOLED_QUIET = { 'edit-gap': { calls: 1000, complied: 200 }, 'commit-gap': { calls: 1000, complied: 10 }, revert: { calls: 1000, complied: 1000 } }
  const C8_INERT = { 'edit-gap': { denials: 80, complied: 2, changed: 3 }, 'commit-gap': { denials: 0, complied: 0, changed: 0 }, revert: { denials: 5, complied: 5, changed: 0 } }
  const C8_QUIET = { 'edit-gap': { calls: 1000, complied: 300 }, 'commit-gap': { calls: 1000, complied: 10 }, revert: { calls: 1000, complied: 1000 } }

  it('analyses the campaign block, not the pool, and labels the verdict line "campaign to date"', async () => {
    const state = freshState()
    const logged = []
    const io = gradedIo({
      exportTriples: () => ({ summary: { denials: POOLED_EFFECTIVE, quiet: POOLED_QUIET, campaigns: { c8: { denials: C8_INERT, quiet: C8_QUIET } } } }),
      appendLog: (t) => logged.push(t),
    })
    await runWave(spec, state, io)
    const e = state.state.denialAnalysis.invariants.find(x => x.invariant === 'edit-gap')
    expect(e.denials).toBe(80); expect(e.verdict).toBe('INERT')
    expect(state.state.proposals[0]).toMatchObject({ name: 'invariants/editGapCap', status: 'pending' })
    expect(logged.join('\n')).toMatch(/- Denials \(campaign to date\):/)
  })

  it('falls back to the pool when the campaign has no block yet, and says which it read', async () => {
    const state = freshState()
    const logged = []
    const io = gradedIo({
      exportTriples: () => ({ summary: { denials: C8_INERT, quiet: C8_QUIET, campaigns: {} } }),
      appendLog: (t) => logged.push(t),
    })
    await runWave(spec, state, io)
    expect(state.state.denialAnalysis.invariants.find(x => x.invariant === 'edit-gap').denials).toBe(80)
    expect(logged.join('\n')).toMatch(/- Denials \(all runs — no campaign block yet\):/)
  })
})

// I2: a verdict that exports a dataset without its own wave in it, and a
// promotion rule that cannot see the wave whose evidence made the case, are
// both one wave behind. The record goes on the record first.
describe('runWave — the wave is on the record before the verdict reads the record set', () => {
  const emptySummary = { summary: { denials: {}, quiet: {}, campaigns: {} } }
  const ideaSpec = { ...spec, ideation: { enabled: true } }
  const gradedIo = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    firstCommitFiles: () => ['gilded/ui/atlas_view.py'],
    engineLive: async () => false,
    ideate: async () => ({ ideation: { hypotheses: [{ gateId: 'C8.1a', cause: 'c', firstEdit: 'gilded/ui/atlas_view.py' }], order: ['C8.1a'], trap: null }, taskPath: 't.json', durationMs: 5 }),
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    readLedgerRows: () => [],
    exportTriples: () => emptySummary,
    ...over,
  })

  it('exports the triples with the current wave already in waves.jsonl', async () => {
    const state = freshState()
    state.appendWave({ wave: -2 }); state.appendWave({ wave: -1 })
    const before = state.waves().length
    let seenAtExport = null
    await runWave(spec, state, gradedIo({ exportTriples: () => { seenAtExport = state.waves().length; return emptySummary } }))
    expect(before).toBe(2)
    expect(seenAtExport).toBe(before + 1)
    // and the record is still one line, patched — not appended twice.
    expect(state.waves()).toHaveLength(before + 1)
    expect(state.waves().at(-1)).toMatchObject({ wave: 1, verdictSha: 'v1', notified: true })
  })

  it('raises the promotion proposal in the very wave that completes the evidence', async () => {
    const state = freshState()
    // SEVEN prior ideated waves — one short of IDEATION_MIN_WAVES, so the
    // prior set alone raises nothing. The current wave is the eighth, and the
    // proposal may only appear if runWave counted it.
    for (let i = 0; i < 4; i++) state.appendWave({ wave: i + 1, s4: { ideation: {}, followed: true }, outcome: { landed: true } })
    for (let i = 0; i < 3; i++) state.appendWave({ wave: 4 + i + 1, s4: { ideation: {}, followed: false }, outcome: { landed: false } })
    expect(promotionProposal(state.waves(), 0)).toBeNull()
    const seen = []
    const rec = await runWave(ideaSpec, state, gradedIo({ notify: async (t) => { seen.push(t); return true } }))
    expect(rec.s4.followed).toBe(true); expect(rec.outcome.landed).toBe(true)
    const pending = state.state.proposals.filter(p => p.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].name).toBe('ideation/brief')
    expect(pending[0].evidence).toMatchObject({ followedLanded: 5, followedMissed: 0, notFollowedLanded: 0, notFollowedMissed: 3 })
    expect(seen.some(t => /PROPOSAL ideation\/brief/.test(t))).toBe(true)
  })

  it('does not record the wave twice when the verdict half throws', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, gradedIo({ appendLog: () => { throw new Error('campaign-log is read-only') } }))
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/post-run step failed: campaign-log is read-only/)
    expect(state.waves()).toHaveLength(1)
    expect(state.waves()[0].decision.kind).toBe('fault')
  })

  // M4: the operator approves a cap between two waves, from a second process.
  // The runner holds this state object for days; without a read-in at the top
  // of the wave, the approval first reaches the dispatch one whole wave late.
  it('picks up an approval granted between waves before it dispatches', async () => {
    const state = freshState()
    state.state.proposals = [{ type: 'Parameter', name: 'invariants/editGapCap', proposedAt: 't1', status: 'pending', newValue: 60, currentValue: 40, bounds: { min: 40, max: 80 } }]
    state.save()
    // The `--approve-proposal` process, writing the decision under this one.
    const disk = JSON.parse(readFileSync(join(state.dir, 'state.json'), 'utf8'))
    disk.proposals[0].status = 'approved'; disk.proposals[0].decidedAt = '2026-09-18T00:00:00.000Z'
    disk.invariantOverrides = { editGapCap: 60 }
    writeFileSync(join(state.dir, 'state.json'), JSON.stringify(disk, null, 2))

    let dispatched = null
    await runWave(spec, state, gradedIo({ dispatch: async ({ invariants }) => { dispatched = invariants; return { missionId: 'c8-wave1-1' } } }))
    expect(dispatched.editGapCap).toBe(60)
    expect(state.state.proposals[0].status).toBe('approved')
  })
})

// ── Phase 3: the evidence layer ─────────────────────────────────────────────

describe('recordReseal', () => {
  const cal = (ids, sha) => ({ gateSha256: sha, baseFails: ids.map(id => ({ id, line: `${id}: FAIL x` })), basePasses: [] })

  it('records the reseal with the lines that are not the same claim any more', () => {
    const s = { reseals: [] }
    const prev = cal(['C8.1a', 'C8.2a'], 'aaaa')
    const next = { gateSha256: 'bbbb', baseFails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }, { id: 'C8.2a', line: 'C8.2a: FAIL x, and y' }], basePasses: [] }
    const r = recordReseal(s, prev, next, { at: '2026-09-23T00:00:00.000Z', wave: 2 })
    expect(r).toEqual({ at: '2026-09-23T00:00:00.000Z', wave: 2, from: { gateSha256: 'aaaa' }, to: { gateSha256: 'bbbb' }, changedLineIds: ['C8.2a'] })
    expect(s.reseals).toEqual([r])
  })

  it('a FIRST calibration is not a reseal', () => {
    const s = { reseals: [] }
    expect(recordReseal(s, null, cal(['C8.1a'], 'aaaa'), { at: 't', wave: 0 })).toBeNull()
    expect(s.reseals).toEqual([])
  })

  it('appends rather than replacing, and survives a state that has no reseals array', () => {
    const s = {}
    recordReseal(s, cal(['a'], '1'), cal(['a'], '2'), { at: 't1', wave: 1 })
    recordReseal(s, cal(['a'], '2'), cal(['b'], '3'), { at: 't2', wave: 2 })
    expect(s.reseals.map(r => r.changedLineIds)).toEqual([[], ['a', 'b']])
  })

  // The whole point of the record is that it is taken from the calibration the
  // runner is ABOUT to overwrite; taken afterwards it would compare the new
  // calibration with itself and every reseal would read as "nothing changed".
  it('the CALIBRATE block records the reseal before it overwrites the calibration', () => {
    const src = readFileSync(fileURLToPath(new URL('../cynco-campaign.mjs', import.meta.url)), 'utf8')
    const call = src.indexOf('recordReseal(state.state, cal,')
    const assign = src.indexOf('state.state.calibration = next')
    expect(call, 'the CALIBRATE block never calls recordReseal').toBeGreaterThan(-1)
    expect(assign, 'the CALIBRATE block no longer assigns the new calibration').toBeGreaterThan(call)
  })
})

describe('the wave record names who wrote the gate', () => {
  const io = () => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
  })

  it('carries spec.author onto gate.author without losing a single graded field', async () => {
    const rec = await runWave({ ...spec, author: 'cynco' }, freshState(), io())
    expect(rec.gate.author).toBe('cynco')
    // Every field the grade produced is still there — `author` is added, not
    // substituted for the reading the wave is judged on.
    expect(rec.gate).toMatchObject({ terminator: 'MISS', failCount: 1, priorRegressions: 0 })
    expect(rec.gate.fails).toEqual(g().gate.fails)
  })

  it('a spec with no author is the human seat, which is what every campaign before c9 was', async () => {
    const rec = await runWave(spec, freshState(), io())
    expect(rec.gate.author).toBe('human')
  })
})

describe('the gate-author promotion at VERDICT', () => {
  const io = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    exportGateLines: () => ({ rows: [], summary: gateLineSummary(30, 30, 17, 17) }),
    ...over,
  })

  it('raises gate-author/gate with the evidence when the bar is cleared', async () => {
    const state = freshState()
    const notified = []
    const rec = await runWave(spec, state, io({ notify: async (m) => { notified.push(m); return true } }))
    const p = state.state.proposals.find(x => x.name === 'gate-author/gate')
    expect(p).toMatchObject({ type: 'Parameter', newValue: 0.5, status: 'pending', bounds: { min: 0, max: 0.5 } })
    expect(p.evidence).toMatchObject({ n: 30, held: 30, rate: 1 })
    expect(p.proposedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(notified.join('\n')).toMatch(/PROPOSAL gate-author\/gate/)
    expect(rec.decision.kind).toBe('next')
  })

  // §E: two proposals must not go pending in the same wave, and that rule does
  // not care which of the three raised the first one.
  it('computes nothing while another proposal is already pending', async () => {
    const state = freshState()
    state.state.proposals = [{ type: 'Code', name: 'gate/c9', status: 'pending', proposedAt: 't' }]
    await runWave(spec, state, io())
    expect(state.state.proposals.map(p => p.name)).toEqual(['gate/c9'])
  })

  it('raises nothing once the authority is already earned', async () => {
    const state = freshState()
    state.state.gateAuthorAuthority = 0.5
    await runWave(spec, state, io())
    expect(state.state.proposals).toEqual([])
  })

  it('raises nothing when the exporter hands back no evidence, and does not fault the wave', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, io({ exportGateLines: () => ({ rows: [], summary: gateLineSummary(0, 0, 0, 0) }) }))
    expect(state.state.proposals).toEqual([])
    expect(rec.decision.kind).toBe('next')
  })

  // The Level 4 spine's rule: a dataset that will not rebuild is logged, never
  // a fault. The wave already happened.
  it('an exporter that throws costs the wave nothing', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, io({ exportGateLines: () => { throw new Error('datasets dir is read-only') } }))
    expect(rec.decision.kind).toBe('next')
    expect(state.state.proposals).toEqual([])
  })

  // Phase 4 residual: the campaign-level outcome dataset is regenerated at the
  // same VERDICT, right after the line dataset, with the same never-a-fault rule.
  it('exports the gate outcomes at every VERDICT, after the gate lines', async () => {
    const calls = []
    const rec = await runWave(spec, freshState(), io({
      exportGateLines: () => { calls.push('lines'); return { rows: [], summary: null } },
      exportGateOutcomes: () => { calls.push('outcomes'); return { rows: [], outPath: 'x' } },
    }))
    expect(calls).toEqual(['lines', 'outcomes'])
    expect(rec.decision.kind).toBe('next')
  })

  it('an outcomes exporter that throws costs the wave nothing', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, io({ exportGateOutcomes: () => { throw new Error('datasets dir is read-only') } }))
    expect(rec.decision.kind).toBe('next')
  })

  it('prints the gate-lines reading in the verdict entry', async () => {
    let entry = null
    await runWave(spec, freshState(), io({ appendLog: (t) => { entry = t } }))
    expect(entry).toMatch(/- Gate lines: cynco 30\/30 held \(rate 1\.000, ci \[0\.89, 1\.00\]\) vs human 17\/17; PARITY/)
  })
})

// ── Phase 3: the gate-author seat ───────────────────────────────────────────

describe('applyProposalDecision on the gate-authoring proposals', () => {
  const pending = (over) => ({ type: 'Parameter', name: 'gate-author/gate', proposedAt: 't1', status: 'pending', newValue: 0.5, bounds: { min: 0, max: 0.5 }, ...over })

  it('gate-author/gate raises the authority, capped at its own bound', () => {
    const s = { proposals: [pending()], gateAuthorAuthority: 0 }
    expect(applyProposalDecision(s, 'gate-author/gate', true)).toEqual({ ok: true, status: 'approved' })
    expect(s.gateAuthorAuthority).toBe(0.5)
    const greedy = { proposals: [pending({ newValue: 1.0 })], gateAuthorAuthority: 0 }
    applyProposalDecision(greedy, 'gate-author/gate', true)
    expect(greedy.gateAuthorAuthority).toBe(0.5)
  })

  it('a rejected gate-author/gate changes no authority', () => {
    const s = { proposals: [pending()], gateAuthorAuthority: 0 }
    expect(applyProposalDecision(s, 'gate-author/gate', false).status).toBe('rejected')
    expect(s.gateAuthorAuthority).toBe(0)
  })

  // gate/<id> is a decision about CODE. It records who decided and nothing
  // else: the seal (the copy into the sealed tree, the campaign json, the
  // campaign-log entry) is the CLI's, because this function is called on every
  // CampaignState.save and must stay pure.
  it('gate/<id> records status and decidedBy and touches nothing else', () => {
    const s = { proposals: [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending', evidence: { lineCount: 12 } }], gateAuthorAuthority: 0, ideationAuthority: 0 }
    expect(applyProposalDecision(s, 'gate/c9', true)).toEqual({ ok: true, status: 'approved' })
    expect(s.proposals[0].status).toBe('approved')
    expect(s.proposals[0].decidedBy).toBe('supervisor')
    expect(s.proposals[0].decidedAt).toBeTruthy()
    expect(s.gateAuthorAuthority).toBe(0)
    expect(s.invariantOverrides).toBeUndefined()
    const rejected = { proposals: [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending' }] }
    expect(applyProposalDecision(rejected, 'gate/c9', false).status).toBe('rejected')
    expect(rejected.proposals[0].decidedBy).toBe('supervisor')
  })
})

describe('main routes the authoring verbs before it loads a campaign spec', () => {
  // The whole point of the routing: `<id>.campaign.json` is what --author
  // PRODUCES, so requiring it here would make the verb that writes a spec
  // depend on the spec already existing.
  const stub = (seal = { ok: true, problems: [], specPath: 'docs/civkings-redesign-briefs/c9.campaign.json' }) => {
    const calls = []
    return { calls, authorModule: {
      defaultAuthorIo: (helpers) => ({ helpers }),
      authorMain: async (argv, io) => { calls.push({ verb: argv[0], argv, io }); return 0 },
      sealGate: async (args) => { calls.push({ verb: 'seal', args }); return seal },
    } }
  }

  // c10: C9's spec was sealed on 2026-09-26 (Phase 5), so the "no spec anywhere"
  // precondition now uses the next unauthored line.
  it('--author c10 reaches the author module with no c10.campaign.json anywhere', async () => {
    expect(existsSync('docs/civkings-redesign-briefs/c10.campaign.json')).toBe(false)
    const s = stub()
    expect(await main(['--author', 'c10'], { authorModule: s.authorModule })).toBe(0)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].argv).toEqual(['--author', 'c10'])
    // the runner's own helpers are what travel over, not an import back
    expect(Object.keys(s.calls[0].io.helpers).sort()).toEqual(['appendLog', 'applyProposalDecision', 'dispatchEnv', 'dispatchRaw', 'missionIdFrom', 'notify', 'readRow', 'releaseLock', 'seatAuthority', 'takeLock', 'waitForDriver'])
  })

  it('--author takes the id from the argv path when none is named', async () => {
    const s = stub()
    expect(await main(['docs/civkings-redesign-briefs/c9.campaign.json', '--author'], { authorModule: s.authorModule })).toBe(0)
    expect(s.calls[0].argv).toEqual(['--author', 'c9'])
  })

  it('--author refuses to name two campaigns at once', async () => {
    const s = stub()
    expect(await main(['docs/civkings-redesign-briefs/c8.campaign.json', '--author', 'c9'], { authorModule: s.authorModule })).toBe(2)
    expect(s.calls).toEqual([])
  })

  it('--check is routed straight through, spec or no spec', async () => {
    const s = stub()
    expect(await main(['--check', 'C:/staging/c9', 'C:/tmp/c9_author_base'], { authorModule: s.authorModule })).toBe(0)
    expect(s.calls[0].verb).toBe('--check')
  })

  // A refused seal used to be a dead end: the approval was already recorded, so
  // there was nothing left to approve once the draft was fixed.
  it('a refused seal leaves the proposal pending and records no decision', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = dir
    try {
      const state = new CampaignState(join(dir, 'campaigns', 'c9')).load()
      state.state.proposals = [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending' }]
      state.save()
      const s = stub({ ok: false, problems: ['brief-visible text names the sealed instrument "gate_c9.py"'] })
      expect(await main(['--approve-proposal', 'gate/c9'], { authorModule: s.authorModule })).toBe(2)
      const saved = JSON.parse(readFileSync(join(dir, 'campaigns', 'c9', 'state.json'), 'utf8'))
      expect(saved.proposals[0].status).toBe('pending')
      expect(saved.proposals[0].decidedBy).toBeUndefined()
      expect(saved.proposals[0].decidedAt).toBeUndefined()
      expect(s.calls.map(c => c.verb)).toEqual(['seal'])
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })

  it('--approve-proposal gate/<id> seals, then decides', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = dir
    try {
      const state = new CampaignState(join(dir, 'campaigns', 'c9')).load()
      state.state.proposals = [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending' }]
      state.save()
      const s = stub()
      expect(await main(['--approve-proposal', 'gate/c9'], { authorModule: s.authorModule })).toBe(0)
      const saved = JSON.parse(readFileSync(join(dir, 'campaigns', 'c9', 'state.json'), 'utf8'))
      expect(saved.proposals[0]).toMatchObject({ status: 'approved', decidedBy: 'supervisor' })
      expect(s.calls.map(c => c.verb)).toEqual(['seal'])
      expect(s.calls[0].args.id).toBe('c9')
      expect(s.calls[0].args.roadmap.lines.some(l => l.id === 'c9')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })

  // Review #8: the approve branch and the author verbs read and write the
  // roadmap through the same injectable path the reject branch always used.
  it('--approve-proposal gate/<id> loads and saves the roadmap at the injected path, never the live one', async () => {
    const before = readFileSync('docs/civkings-redesign-briefs/roadmap.json', 'utf8')
    const dir = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const roadmapPath = join(mkdtempSync(join(tmpdir(), 'roadmap-')), 'roadmap.json')
    writeFileSync(roadmapPath, JSON.stringify({ lines: [{ id: 'c9', name: 'INJECTED', bar: 'b', base: 'abcdef1', status: 'proposed' }] }, null, 2) + '\n')
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = dir
    try {
      const state = new CampaignState(join(dir, 'campaigns', 'c9')).load()
      state.state.proposals = [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending' }]
      state.save()
      const s = stub()
      // A sealGate that does what the real one does with the roadmap: advance the line and save it through io.
      s.authorModule.sealGate = async (args) => {
        s.calls.push({ verb: 'seal', args })
        args.roadmap.lines.find(l => l.id === 'c9').status = 'sealed'
        args.io.saveRoadmap('docs/civkings-redesign-briefs/roadmap.json', args.roadmap)
        return { ok: true, problems: [], specPath: 'x' }
      }
      expect(await main(['--approve-proposal', 'gate/c9'], { authorModule: s.authorModule, roadmapPath })).toBe(0)
      expect(s.calls[0].args.roadmap.lines[0].name).toBe('INJECTED')
      expect(JSON.parse(readFileSync(roadmapPath, 'utf8')).lines[0].status).toBe('sealed')
      expect(readFileSync('docs/civkings-redesign-briefs/roadmap.json', 'utf8')).toBe(before)
      // and the author route's io reads the same path
      expect(await main(['--author', 'c9'], { authorModule: s.authorModule, roadmapPath })).toBe(0)
      expect(s.calls.at(-1).io.loadRoadmap().lines[0].name).toBe('INJECTED')
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })

  /**
   * A refusal REOPENS the line, or the campaign is stuck: `--author` refuses a
   * `proposed` line and `nextOpenLine` holds every later line behind it, so a
   * DO-NOT-SEAL verdict would leave the gate neither sealable nor re-authorable.
   *
   * `roadmapPath` is injected because this path WRITES the roadmap. Redirecting
   * CYNCO_HOME is not enough — the roadmap is repo-relative and shared with the
   * live campaign — and the first cut of this branch rewound the checked-in c9
   * line from `proposed` to `authoring` on every suite run.
   */
  it('--reject-proposal gate/<id> decides, reopens the line, and seals nothing', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const roadmapPath = join(mkdtempSync(join(tmpdir(), 'roadmap-')), 'roadmap.json')
    writeFileSync(roadmapPath, JSON.stringify({ lines: [{ id: 'c9', name: 'Ship shell', bar: 'b', base: 'abcdef1', status: 'proposed' }] }, null, 2) + '\n')
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = dir
    try {
      const state = new CampaignState(join(dir, 'campaigns', 'c9')).load()
      state.state.authoring = { c9: { stagingDir: 'C:/s/c9' } }
      state.state.proposals = [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending' }]
      state.save()
      const s = stub()
      const notePath = join(mkdtempSync(join(tmpdir(), 'note-')), 'note.txt')
      writeFileSync(notePath, 'gate C9.1b: _press must draw first.\n')
      expect(await main(['--reject-proposal', 'gate/c9', '--note', notePath], { authorModule: s.authorModule, roadmapPath })).toBe(0)
      expect(s.calls).toEqual([])
      expect(JSON.parse(readFileSync(roadmapPath, 'utf8')).lines[0].status).toBe('authoring')
      const after = new CampaignState(join(dir, 'campaigns', 'c9')).load().state
      expect(after.proposals[0].status).toBe('rejected')
      expect(after.authoring.c9.refusals).toEqual([expect.objectContaining({ by: 'supervisor', notePath })])
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })

  // And it never touches the checked-in roadmap unless asked to.
  it('--reject-proposal leaves the live roadmap alone when given its own path', async () => {
    const before = readFileSync('docs/civkings-redesign-briefs/roadmap.json', 'utf8')
    const dir = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const roadmapPath = join(mkdtempSync(join(tmpdir(), 'roadmap-')), 'roadmap.json')
    writeFileSync(roadmapPath, JSON.stringify({ lines: [{ id: 'c9', name: 'n', bar: 'b', base: 'abcdef1', status: 'proposed' }] }, null, 2) + '\n')
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = dir
    try {
      const state = new CampaignState(join(dir, 'campaigns', 'c9')).load()
      state.state.proposals = [{ type: 'Code', name: 'gate/c9', proposedAt: 't1', status: 'pending' }]
      state.save()
      await main(['--reject-proposal', 'gate/c9'], { authorModule: stub().authorModule, roadmapPath })
      expect(readFileSync('docs/civkings-redesign-briefs/roadmap.json', 'utf8')).toBe(before)
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })

  it('a gate/<id> decision with no pending proposal refuses without sealing', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = dir
    try {
      const s = stub()
      expect(await main(['--approve-proposal', 'gate/c9'], { authorModule: s.authorModule })).toBe(2)
      expect(s.calls).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev
    }
  })
})

// ── Phase 4: identity is asserted at every verdict and before every approval ──

describe('the identity assertion at VERDICT', () => {
  const io = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(),
    checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    // Evidence that clears the gate-author bar, so a proposal WOULD be raised
    // on an intact wave — the violated case must be seen to suppress it.
    exportGateLines: () => ({ rows: [], summary: gateLineSummary(30, 30, 17, 17) }),
    ...over,
  })

  it('records the identity reading on the wave record and marks the Rule 11 re-check for this wave', async () => {
    const state = freshState()
    let entry = null
    const rec = await runWave(spec, state, io({ appendLog: (t) => { entry = t } }))
    expect(state.state.rule11CheckedWave).toBe(1)
    expect(rec.identity).toMatchObject({ intact: true, violated: [] })
    expect(Object.keys(rec.identity.evidence)).toEqual(['gate-sealed', 'rule-11', 'revert-refused', 'marker-recorded'])
    expect(state.waves().at(-1).identity.intact).toBe(true)
    expect(entry).toMatch(/^- Identity: intact$/m)
    expect(rec.decision.kind).toBe('next')
    expect(state.state.proposals.map(p => p.name)).toEqual(['gate-author/gate'])
  })

  it('a violated identity faults the wave, names what broke, and raises no proposal', async () => {
    const state = freshState()
    let entry = null, notified = []
    const rec = await runWave(spec, state, io({
      checkIdentity: () => ({ ok: false, problems: ['gate does not exist'] }),
      appendLog: (t) => { entry = t },
      notify: async (m) => { notified.push(m); return true },
    }))
    expect(rec.decision).toEqual({ kind: 'fault', why: 'identity violated: gate-sealed' })
    expect(rec.identity).toMatchObject({ intact: false, violated: ['gate-sealed'] })
    expect(state.state.proposals).toEqual([])
    expect(notified.some(m => /PROPOSAL/.test(m))).toBe(false)
    expect(notified.some(m => /FAULT — identity violated: gate-sealed/.test(m))).toBe(true)
    expect(entry).toMatch(/^- Identity: VIOLATED gate-sealed$/m)
    expect(entry).toMatch(/^Verdict: \*\*STOP \(fault\)\*\* — identity violated: gate-sealed/m)
    // The record on disk carries the fault, not the decision made before the check.
    expect(state.waves().at(-1).decision.kind).toBe('fault')
    expect(state.state.waveCount).toBe(1)
  })

  it('a ledger row that does not record markerSeen violates marker-recorded', async () => {
    const state = freshState()
    const rec = await runWave(spec, state, io({ readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', toolStats: {} }) }))
    expect(rec.decision).toEqual({ kind: 'fault', why: 'identity violated: marker-recorded' })
  })

  // Review fix 5: the promotions read the seat's EFFECTIVE authority. A fresh
  // campaign (state value 0) whose seat already holds 0.5 in the retained
  // store must not re-propose the promotion the seat earned elsewhere.
  it('a fresh campaign whose seat is at 0.5 in the store raises no gate-author promotion', async () => {
    const home = mkdtempSync(join(tmpdir(), 'seats-'))
    writeSeats(home, readSeats(home), { seat: 'gate-author', authority: 0.5, decidedAt: 't', campaign: 'c8' })
    const state = freshState()
    expect(state.state.gateAuthorAuthority).toBe(0)
    const rec = await runWave(spec, state, io({ seatsHome: () => home }))
    expect(rec.decision.kind).toBe('next')
    expect(state.state.proposals).toEqual([])
    // Control: the same wave with an empty store does raise it.
    const control = freshState()
    await runWave(spec, control, io({ seatsHome: () => mkdtempSync(join(tmpdir(), 'seats-empty-')) }))
    expect(control.state.proposals.map(p => p.name)).toEqual(['gate-author/gate'])
  })

  it('a fresh campaign whose ideation seat is at 0.5 in the store raises no ideation promotion', async () => {
    const home = mkdtempSync(join(tmpdir(), 'seats-'))
    writeSeats(home, readSeats(home), { seat: 'ideation', authority: 0.5, decidedAt: 't', campaign: 'c8' })
    const state = freshState()
    for (let i = 0; i < 8; i++) state.appendWave({ wave: i + 1, s4: { ideation: {}, followed: true }, outcome: { landed: true } })
    for (let i = 0; i < 4; i++) state.appendWave({ wave: 8 + i + 1, s4: { ideation: {}, followed: false }, outcome: { landed: false } })
    expect(promotionProposal(state.waves(), 0)).not.toBeNull()
    await runWave(spec, state, io({ seatsHome: () => home, exportGateLines: () => ({ rows: [], summary: null }) }))
    expect(state.state.proposals.filter(p => p.name === 'ideation/brief')).toEqual([])
  })

  it('a spec that turns the revert ban off faults the wave', async () => {
    const state = freshState()
    const rec = await runWave({ ...spec, invariants: { ...spec.invariants, revertBan: false } }, state, io())
    expect(rec.identity.violated).toEqual(['revert-refused'])
    expect(rec.decision.kind).toBe('fault')
  })
})

describe('main asserts identity before it applies an operator decision', () => {
  const BASE_SHA = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const setup = ({ calibrated = true } = {}) => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const heldout = join(home, 'heldout', 'civkings-redesign', 'c8')
    mkdirSync(heldout, { recursive: true })
    for (const n of ['gate_c8.py', 'perturb_c8.py']) writeFileSync(join(heldout, n), '# instrument\n')
    const specPath = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json')
    writeFileSync(specPath, JSON.stringify({ ...spec, repo: '.', base: BASE_SHA, gate: join(heldout, 'gate_c8.py'), perturb: join(heldout, 'perturb_c8.py'),
      suiteBaseline: join(heldout, 'suite-baseline.json'), ideation: { enabled: false } }))
    const state = new CampaignState(join(home, 'campaigns', 'c8')).load()
    if (calibrated) state.state.calibration = { gateSha256: 'g', perturbSha256: 'p', baseFails: [], basePasses: [] }
    state.state.proposals = [{ type: 'Parameter', name: 'ideation/brief', proposedAt: 't1', status: 'pending', newValue: 0.5, bounds: { min: 0, max: 0.5 } }]
    state.save()
    return { home, specPath, stateDir: state.dir }
  }
  const withHome = async (home, fn) => {
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    try { return await fn() } finally { if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev }
  }

  it('--approve-proposal ideation/brief approves and writes the seat into the retained store', async () => {
    const { home, specPath, stateDir } = setup()
    expect(await withHome(home, () => main([specPath, '--approve-proposal', 'ideation/brief']))).toBe(0)
    const disk = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
    expect(disk.proposals[0].status).toBe('approved')
    expect(disk.ideationAuthority).toBe(0.5)
    const seats = JSON.parse(readFileSync(join(home, 'retained', 'seats.json'), 'utf8'))
    expect(seats).toMatchObject({ schema: 1, version: 1, seats: { ideation: { authority: 0.5, campaign: 'c8' } } })
  })

  it('an uncalibrated campaign (rule-11 not intact) cannot approve; the proposal stays pending', async () => {
    const { home, specPath, stateDir } = setup({ calibrated: false })
    expect(await withHome(home, () => main([specPath, '--approve-proposal', 'ideation/brief']))).toBe(2)
    const disk = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
    expect(disk.proposals[0].status).toBe('pending')
    expect(existsSync(join(home, 'retained', 'seats.json'))).toBe(false)
  })
})

// ── Phase 4: the rule verdicts the engine's S5 authority is read from ────────

describe('the rule verdicts at VERDICT', () => {
  const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
  const ledger = () => [
    ...Array.from({ length: 12 }, () => ({ outcome: 'failed', verified: false, mutationSweep: sweep, s5Decisions: [{ ruleIds: ['X', 'Y'] }] })),
    ...Array.from({ length: 12 }, () => ({ outcome: 'landed', verified: true, mutationSweep: sweep, s5Decisions: [{ ruleIds: ['Y'] }] })),
  ]
  const io = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    ...over,
  })

  it('writes <home>/datasets/rule-verdicts.json from the ledger and records the reading on the wave', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rv-home-'))
    const state = freshState()
    const rec = await runWave(spec, state, io({ readLedgerRows: ledger, datasetsHome: () => home }))
    expect(rec.ruleVerdicts).toMatchObject({ version: 1, predictive: ['X'], total: 3, rules: 2, modelRows: 0, runnerRows: 1 })
    const f = JSON.parse(readFileSync(join(home, 'datasets', 'rule-verdicts.json'), 'utf8'))
    expect(f).toMatchObject({ schema: 1, version: 1, campaign: 'c8', predictive: ['X'] })
    expect(f.rules.X.verdict).toBe('PREDICTIVE')
    // The persisted record carries it too, not only the returned one.
    expect(state.waves().at(-1).ruleVerdicts).toEqual(rec.ruleVerdicts)
  })

  it('reuses the rows the triples export already read instead of reading the ledger twice', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rv-home-'))
    const rec = await runWave(spec, freshState(), io({
      exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} }, rows: ledger() }),
      readLedgerRows: () => { throw new Error('the ledger must not be read a second time') },
      datasetsHome: () => home,
    }))
    expect(rec.ruleVerdicts).toMatchObject({ version: 1, predictive: ['X'], total: 3, rules: 2, modelRows: 0, runnerRows: 1 })
  })

  it('a verdict file that will not write costs the wave nothing', async () => {
    const rec = await runWave(spec, freshState(), io({ datasetsHome: () => { throw new Error('datasets dir is read-only') } }))
    expect(rec.decision.kind).toBe('next')
    expect(rec.ruleVerdicts).toBeNull()
  })

  it('the default io reads the datasets home from cyncoHome and the rows from the ledger shards', () => {
    expect(typeof defaultIo.readLedgerRows).toBe('function')
    expect(defaultIo.datasetsHome()).toBe(process.env.CYNCO_HOME)
  })
})

// ── Phase 4 ruling 4: the campaign autopoiesis checklist at VERDICT ─────────

describe('the autopoiesis checklist at VERDICT', () => {
  const io = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: true, identityGuard: { passed: true }, toolStats: {} }),
    commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    ...over,
  })

  it('records rec.autopoiesis on the wave record and prints the line in the verdict entry', async () => {
    const state = freshState()
    let entry = null
    const rec = await runWave(spec, state, io({ appendLog: (t) => { entry = t } }))
    // c8 is human-authored and has no approved proposal: gate is unproduced.
    expect(rec.autopoiesis).toMatchObject({
      criteria: { hasBoundary: true, boundarySelfProduced: false, internalProduction: true, organizationMaintained: true },
      isAutopoietic: false,
    })
    expect(rec.autopoiesis.missing).toContain('boundarySelfProduced')
    expect(rec.autopoiesis.missing).toContain('organizationallyClosed')
    expect(rec.autopoiesis.network.unproduced).toContain('gate')
    expect(rec.autopoiesis.facts).toMatchObject({ gateAuthor: 'human', waves: 1, rows: 1, commitsLanded: 1 })
    expect(state.waves().at(-1).autopoiesis).toEqual(rec.autopoiesis)
    const met = 6 - rec.autopoiesis.missing.length
    expect(entry).toMatch(new RegExp(`^- Autopoiesis: ${met}/6 — missing ${rec.autopoiesis.missing.join(', ')}$`, 'm'))
  })

  it('reads the prior waves\' identity and the campaign\'s rows off the ledger the triples export read', async () => {
    const state = freshState()
    state.appendWave({ wave: 0, missionId: 'c8-old', gradedAt: 't0', identity: { intact: true } })
    const rec = await runWave(spec, state, io({
      exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} }, rows: [{ missionId: 'c8-old', identityGuard: { passed: false } }, { missionId: 'other' }] }),
    }))
    expect(rec.autopoiesis.facts.identityHistory).toEqual({ waves: 1, intact: 1, rows: 2, passed: 1 })
    expect(rec.autopoiesis.criteria.organizationMaintained).toBe(false)
  })

  it('a violated identity reads hasBoundary false', async () => {
    const rec = await runWave(spec, freshState(), io({ checkIdentity: () => ({ ok: false, problems: ['gate does not exist'] }) }))
    expect(rec.decision.kind).toBe('fault')
    expect(rec.autopoiesis.criteria.hasBoundary).toBe(false)
    expect(rec.autopoiesis.criteria.organizationMaintained).toBe(false)
  })

  it('an approved proposal on state and the retained seat store feed the network', async () => {
    const home = mkdtempSync(join(tmpdir(), 'seats-'))
    writeSeats(home, readSeats(home), { seat: 'gate-author', authority: 0.5, decidedAt: 't', campaign: 'c7' })
    const state = freshState()
    state.state.proposals = [{ name: 'invariants/editGapCap', status: 'approved', decidedAt: 't' }]
    const rec = await runWave(spec, state, io({ seatsHome: () => home }))
    expect(rec.autopoiesis.facts).toMatchObject({ proposalRaised: true, proposalApproved: true, seatAuthority: 0.5 })
    expect(rec.autopoiesis.network.productions).toContainEqual(['configuration', 'seat'])
  })

  it('records whether this wave\'s brief carried the campaign-to-date PACING digest', async () => {
    const state = freshState()
    state.state.lastRow = { missionId: 'c8-w0', exitReason: 'marker', durationS: 1, toolStats: {}, invariants: { denialCount: 2, nextCallClassByInvariant: { 'edit-gap': { sourceEdit: 2 } } } }
    state.state.denialAnalysis = { invariants: [{ invariant: 'edit-gap', complied: 2, denials: 2 }] }
    let brief = null
    const rec = await runWave(spec, state, io({ writeBrief: (p, text) => { brief = text; return p } }))
    expect(brief).toMatch(/; campaign to date edit-gap 2\/2/)
    // The runner records the generator's own predicate; the checklist reads the flag.
    expect(rec.s4.pacingFromDenials).toBe(true)
    expect(state.waves().at(-1).s4.pacingFromDenials).toBe(true)
    expect(rec.autopoiesis.facts.pacingDigest).toBe(true)
    expect(rec.autopoiesis.criteria.circularProduction).toBe(true)
    // Control: no prior denials, no digest.
    const control = await runWave(spec, freshState(), io())
    expect(control.s4.pacingFromDenials).toBe(false)
    expect(control.autopoiesis.facts.pacingDigest).toBe(false)
  })

  it('an assessment that throws is recorded as assessError and costs the wave nothing', async () => {
    let entry = null
    const rec = await runWave(spec, freshState(), io({ assessAutopoiesis: () => { throw new Error('boom') }, appendLog: (t) => { entry = t } }))
    expect(rec.decision.kind).toBe('next')
    expect(rec.autopoiesis).toEqual({ assessError: 'boom' })
    expect(entry).toMatch(/^- Autopoiesis: UNASSESSED — boom$/m)
  })
})

// ── Phase 5 ruling 2: the scoreboard at VERDICT ─────────────────────────────

describe('the scoreboard at VERDICT', () => {
  const io = (over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 7200, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: true, identityGuard: { passed: true }, toolStats: {},
      operatorNotes: [{ source: 'operator', deliveredAtIteration: 4, dropped: null }] }),
    commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }, { sha: 'i', subject: 'C8 commit 2' }],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => ['VERDICT: frontier spent $10.00 SUPERVISING (development $1.00 and'],
    appendLog: () => {},
    // one temp datasets dir per io: the verdicts the VERDICT writes are the ones it reads
    datasetsHome: ((d) => () => d)(mkdtempSync(join(tmpdir(), 'ds-sb-'))),
    ...inertTriples,
    ...over,
  })

  it('records rec.scoreboard with this wave in it and prints the line right after the autopoiesis line', async () => {
    const state = freshState()
    let entry = null
    // no verdict file for this one, on purpose: the null path of perRulePrecision
    const rec = await runWave(spec, state, io({ appendLog: (t) => { entry = t }, readRuleVerdicts: () => null }))
    // the per-wave inputs are on the record itself
    expect(rec.durationS).toBe(7200)
    expect(rec.outcome.commitsLanded).toBe(2)
    expect(rec.adopted).toBe(false)
    expect(rec.scoreboard).toMatchObject({ id: 'c8', decided: false, decision: 'next', waves: 1, gpuHours: 2, passRatePerGpuHour: null, wavesPerCampaign: null,
      // calibration 1 fail → this wave's 1 fail, 2 commits landed
      gateLinesFixedPerLandedWave: { value: 0, landedWaves: 1, fixed: 0 },
      humanInterventionsPerWave: { value: 1, notes: 1 }, perRulePrecision: null, supervisionDollarsPerWave: 10 })
    expect(entry).toMatch(/^- Autopoiesis: .*\n- Scoreboard: PASS\/GPU-h open \| waves 1 so far \(open\) \| lines fixed per landed wave 0\.00 \| human interventions per wave 1\.00 \| rules predictive null \(no rule-verdicts\.json/m)
    // stored on the record the dashboard reads
    expect(state.waves().at(-1).scoreboard).toEqual(rec.scoreboard)
  })

  it('reads the rule verdicts the VERDICT just wrote', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ds-sb-'))
    const rec = await runWave(spec, freshState(), io({ datasetsHome: () => home, readLedgerRows: () => [] }))
    expect(rec.ruleVerdicts).not.toBeNull()
    expect(rec.scoreboard.perRulePrecision).toMatchObject({ predictive: 0, total: rec.ruleVerdicts.rules })
  })

  it('a PASS wave decides the campaign on the board', async () => {
    const pass = g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], failCount: 0, exit: 0 } })
    const rec = await runWave(spec, freshState(), io({ grade: async () => pass }))
    expect(rec.decision.kind).toBe('pass')
    expect(rec.scoreboard).toMatchObject({ decided: true, decision: 'pass', wavesPerCampaign: 1, gateLinesFixedPerLandedWave: { fixed: 1, landedWaves: 1 } })
    expect(rec.scoreboard.passRatePerGpuHour).toBeCloseTo(0.5, 10)
  })

  it('the board reads the FINAL decision: an identity fault after the append is not a pass', async () => {
    const pass = g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], failCount: 0, exit: 0 } })
    const rec = await runWave(spec, freshState(), io({ grade: async () => pass, checkIdentity: () => ({ ok: false, problems: ['gate does not exist'] }) }))
    expect(rec.decision.kind).toBe('fault')
    expect(rec.scoreboard).toMatchObject({ decided: false, decision: 'fault' })
  })

  it('an economics script that did not run (null from the capped reader) is named on the board and prints no economics', async () => {
    let entry = null
    const rec = await runWave(spec, freshState(), io({ economics: () => null, appendLog: (t) => { entry = t } }))
    expect(rec.decision.kind).toBe('next')
    expect(rec.scoreboard.supervisionDollarsPerWave).toBeNull()
    expect(rec.scoreboard.unmeasured).toContain('supervisionDollarsPerWave: no economics line (the economics script did not run)')
    expect(entry).not.toMatch(/Economics after this wave/)
  })

  it('a scoreboard that throws is recorded as { error } and costs the wave nothing', async () => {
    let entry = null
    const rec = await runWave(spec, freshState(), io({ scoreboard: () => { throw new Error('boom') }, appendLog: (t) => { entry = t } }))
    expect(rec.decision.kind).toBe('next')
    expect(rec.scoreboard).toEqual({ error: 'boom' })
    expect(entry).toMatch(/^- Scoreboard: UNMEASURED — boom$/m)
  })
})

// ── Phase 6 ruling 2–3: gate progress mid-wave, R1.no-progress in shadow ────
describe('runWave — gate progress measured by the runner mid-wave', () => {
  const MIN = 60_000
  const progressSpec = { ...spec, budget: { ...spec.budget, hoursPerWave: 4 }, progress: { everyMs: 30 * MIN } }
  const oneFail = { terminator: 'MISS', fails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], passes: [], errors: [], failCount: 1, exit: 1, harnessFault: null }
  const io = (over = {}) => {
    const seen = { archived: [], dispatched: 0, ticksBeforeDispatch: 0, entry: null }
    let head = 'BASESHA'
    return { seen, io: {
      writeBrief: (p) => p,
      dispatch: async () => { seen.dispatched += 1; return { missionId: 'c8-wave1-1' } },
      // The HEAD-vs-base check (Rule 11) reads HEAD = base before dispatch;
      // the wave then commits C1 between the two ticks.
      repoHead: (repo, rev) => (rev === 'HEAD' ? head : rev === '1d03308' ? 'BASESHA' : null),
      progressProbe: { archive: (repo, sha, dest) => { seen.archived.push({ repo, sha, dest }); return { ok: true } }, runGate: () => oneFail, removeDir: () => {} },
      waitForDriver: async ({ onTick }) => {
        const t = Date.now()
        onTick?.({ elapsedMs: 0, nowMs: t + 31 * MIN })
        head = 'C1'
        onTick?.({ elapsedMs: 0, nowMs: t + 130 * MIN })
        return { exited: true }
      },
      readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 9000, commitRange: { base: 'BASESHA', head: 'C1' }, outcome: 'landed', markerSeen: false, toolStats: {} }),
      commitsBetween: () => [{ sha: 'C1', subject: 'c' }],
      grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null, patchRow: () => {}, commit: () => ({ sha: 'v1' }), notify: async () => true, economics: () => [],
      appendLog: (t) => { seen.entry = t },
      datasetsHome: ((d) => () => d)(mkdtempSync(join(tmpdir(), 'ds-prog-'))),
      ...inertTriples,
      ...over,
    } }
  }

  it('records the readings and the shadow decisions on the wave record, and prints the Progress line before the Scoreboard', async () => {
    const state = freshState()
    const { seen, io: fake } = io()
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    let rec
    try { rec = await runWave(progressSpec, state, fake) } finally { console.log = orig }
    // The first tick finds HEAD still at the base: the start grade is reused,
    // no gate runs. The second finds C1: archived and graded (one probe run).
    expect(seen.archived).toHaveLength(1)
    expect(seen.archived[0]).toMatchObject({ repo: 'C:/repo', sha: 'C1' })
    expect(rec.progress).toHaveLength(2)
    expect(rec.progress[0]).toMatchObject({ sha: 'BASESHA', fails: 1, reusedFrom: 'start' })
    expect(rec.progress[1]).toMatchObject({ sha: 'C1', fails: 1, passes: 0, failIds: ['C8.1a'] })
    expect(rec.progress[1].elapsedFraction).toBeCloseTo(130 / 240, 2)
    expect(rec.shadowDecisions.map(d => d.fired)).toEqual([false, true])
    expect(rec.shadowDecisions[1]).toMatchObject({ rule: 'R1.no-progress', startFails: 1, fails: 1 })
    // Stored on waves.jsonl, where the ladder (Task 4) reads it.
    expect(state.waves().at(-1).shadowDecisions).toEqual(rec.shadowDecisions)
    expect(seen.entry).toMatch(/^- Autopoiesis: .*\n- Progress: 1 → 1 fails over 2 readings \(no drop; last at 130 min: 1\); R1\.no-progress fired at 54% \(would have saved 1\.8 h\)\n- Scoreboard: /m)
    expect(logs.join('\n')).toMatch(/\[campaign\] progress @ 130m: 1 fails \(was 1\)/)
    // Shadow: the wave was not stopped — it ran to its grade.
    expect(rec.decision.kind).toBe('next')
  })

  // Phase 6 Task 4: the shadow decisions reach the ladder as one runner row,
  // `R1.no-progress` (source 'runner'), built from THIS campaign's waves (the
  // wave just recorded included) and every other runner-driven campaign's
  // waves under <home>/campaigns — the rule is one rule across campaigns.
  it('the shadow decisions reach the ladder as R1.no-progress over every runner-driven campaign\'s waves', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ds-ladder-'))
    const other = new CampaignState(join(home, 'campaigns', 'c7'))
    const past = [{ at: 't', sha: 's', fails: 3, elapsedFraction: 0.7 }]
    for (const [i, kind] of ['next', 'budget'].entries()) {
      other.appendWave({ wave: i + 1, missionId: `c7-wave${i + 1}-1`, decision: { kind }, progress: past, shadowDecisions: [{ rule: 'R1.no-progress', fired: true, elapsedFraction: 0.7 }] })
    }
    // A dir without a waves.jsonl is not runner-driven and adds nothing; a
    // stale copy of this campaign under the home is read from the state instead.
    mkdirSync(join(home, 'campaigns', 'hand'), { recursive: true })
    new CampaignState(join(home, 'campaigns', 'c8')).appendWave({ wave: 9, missionId: 'stale', decision: { kind: 'next' }, progress: past, shadowDecisions: [{ rule: 'R1.no-progress', fired: true, elapsedFraction: 0.7 }] })
    const { seen, io: fake } = io({ datasetsHome: () => home })
    const rec = await runWave(progressSpec, freshState(), fake)
    const f = JSON.parse(readFileSync(join(home, 'datasets', 'rule-verdicts.json'), 'utf8'))
    expect(f.rules['R1.no-progress']).toMatchObject({ source: 'runner', scope: 'waves', firedTotal: 3, n: 3, failures: 3, scopeN: 3, precision: 1, p: null, verdict: 'TOO FEW — cannot tell' })
    expect(rec.ruleVerdicts).toMatchObject({ runnerRows: 1, rules: 0 })
    expect(rec.ruleVerdicts.runners['R1.no-progress']).toEqual(f.rules['R1.no-progress'])
    // Named with its verdict on the ladder line; the Progress line is untouched.
    expect(seen.entry).toMatch(/^- Outcome hindcast: UNMEASURED — .*; R1\.no-progress precision 100% \[\d+, \d+\] on 3 fired p\(Holm\) null TOO FEW$/m)
    expect(seen.entry).toMatch(/^- Progress: 1 → 1 fails /m)
  })

  // Task 4 review M6: the ladder reads this wave's FINAL decision — a pass the
  // identity check turns into a fault is a failure for R1 on this verdict.
  it('R1 reads the decision after the identity check: a pass turned fault counts as failed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ds-m6-'))
    const pass = g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], failCount: 0, exit: 0 } })
    const { io: fake } = io({ datasetsHome: () => home, grade: async () => pass, checkIdentity: () => ({ ok: false, problems: ['moved'] }) })
    const rec = await runWave(progressSpec, freshState(), fake)
    expect(rec.decision.kind).toBe('fault')
    const f = JSON.parse(readFileSync(join(home, 'datasets', 'rule-verdicts.json'), 'utf8'))
    expect(f.rules['R1.no-progress']).toMatchObject({ firedTotal: 1, n: 1, failures: 1, scopeN: 1 })
  })

  // Task 4 review I1: the CLI rebuild builds the runner row exactly as the
  // VERDICT does, so the S5 rules are corrected over the same Holm family.
  it('a CLI rebuild and the VERDICT write the same pAdjusted for every rule on the same inputs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ds-i1-'))
    const sw = { kind: 'withheld', killed: 1, total: 1, survived: [] }
    const lr = (i, failed, fires) => ({ missionId: `L${i}`, outcome: failed ? 'failed' : 'landed', verified: !failed, mutationSweep: sw, s5Decisions: [{ ruleIds: fires ? ['X'] : [] }] })
    // X: 8 of 9 fired missions failed, 3 of 13 quiet ones — testable, so it and R1 share a Holm family.
    const ledger = () => [...Array.from({ length: 8 }, (_, i) => lr(i, true, true)), lr(8, false, true),
      ...Array.from({ length: 3 }, (_, i) => lr(10 + i, true, false)), ...Array.from({ length: 10 }, (_, i) => lr(20 + i, false, false))]
    const other = new CampaignState(join(home, 'campaigns', 'c7'))
    const w = (id, kind, fired) => ({ wave: 1, missionId: id, decision: { kind }, shadowDecisions: [{ rule: 'R1.no-progress', fired, elapsedFraction: 0.7 }] })
    for (const x of [...Array.from({ length: 6 }, (_, i) => w(`f${i}`, 'next', true)), w('fp', 'pass', true),
      w('q0', 'next', false), w('q1', 'budget', false), ...Array.from({ length: 5 }, (_, i) => w(`p${i}`, 'pass', false))]) other.appendWave(x)
    const state = freshState()
    const { io: fake } = io({ datasetsHome: () => home, readLedgerRows: ledger })
    await runWave(progressSpec, state, fake)
    const atVerdict = JSON.parse(readFileSync(join(home, 'datasets', 'rule-verdicts.json'), 'utf8'))
    expect(atVerdict.ledger.holmFamily).toBe(2)
    // The CLI reads every campaign under the dir, this one included once it is there.
    const mine = new CampaignState(join(home, 'campaigns', 'c8'))
    for (const x of state.waves()) mine.appendWave(x)
    const out = join(home, 'cli.json')
    expect(await verdictsMain(['--out', out, '--campaigns-dir', join(home, 'campaigns')], {
      readLedger: ledger, cyncoHome: () => { throw new Error('the real home must not be read') }, log: () => {} })).toBe(0)
    const byCli = JSON.parse(readFileSync(out, 'utf8'))
    expect(Object.keys(byCli.rules).sort()).toEqual(Object.keys(atVerdict.rules).sort())
    for (const id of Object.keys(atVerdict.rules)) {
      expect(byCli.rules[id].pAdjusted, id).toBe(atVerdict.rules[id].pAdjusted)
      expect(byCli.rules[id].verdict, id).toBe(atVerdict.rules[id].verdict)
    }
    expect(byCli.ledger.holmFamily).toBe(2)
  })

  it('an io without a probe takes no readings and prints no line; the record says why', async () => {
    const { seen, io: fake } = io({ progressProbe: undefined })
    const rec = await runWave(progressSpec, freshState(), fake)
    expect(rec.progress).toBeNull()
    expect(rec.progressNote).toBe('no progress probe on this runner io')
    expect(seen.entry).not.toMatch(/- Progress:/)
  })

  it('a wait that faults keeps the readings it took on the fault record', async () => {
    const { io: fake } = io({ waitForDriver: async ({ onTick }) => { onTick({ elapsedMs: 0, nowMs: Date.now() + 31 * MIN }); return { exited: false, timedOut: true } }, ...faultIo() })
    const rec = await runWave(progressSpec, freshState(), fake)
    expect(rec.decision.kind).toBe('fault')
    expect(rec.progress).toHaveLength(1)
    expect(rec.shadowDecisions).toHaveLength(1)
  })

  // Review M1: the tracker's gateMs is seeded from the start grade — the last
  // verdict's gate run, else the calibration's BASE run — so the 10 % interval
  // holds from the first tick. A 4 min gate lifts the 30 min cadence to 40 min:
  // the tick at 31 min takes no reading.
  it('seeds the cadence from the last grade\'s gate runtime, else the calibration\'s', async () => {
    const lastGradeState = freshState()
    lastGradeState.state.lastGrade = { gate: { fails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], passes: [], durationMs: 4 * MIN } }
    const { io: fakeA } = io({ waitForDriver: async ({ onTick }) => { onTick({ elapsedMs: 0, nowMs: Date.now() + 31 * MIN }); return { exited: true } } })
    const a = await runWave(progressSpec, lastGradeState, fakeA)
    expect(a.progress).toEqual([])
    expect(a.progressNote).toMatch(/gate 240 s → ≥ 40 min/)

    const calState = freshState()
    calState.state.calibration.baseGateMs = 4 * MIN
    const { io: fakeB } = io({ waitForDriver: async ({ onTick }) => { onTick({ elapsedMs: 0, nowMs: Date.now() + 31 * MIN }); return { exited: true } } })
    const b = await runWave(progressSpec, calState, fakeB)
    expect(b.progress).toEqual([])
    expect(b.progressNote).toMatch(/gate 240 s → ≥ 40 min/)
  })
})

// ── Phase 5 ruling 5: the outcome hindcast at VERDICT ───────────────────────

describe('the outcome hindcast at VERDICT', () => {
  const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
  // 12 held-out failures and 8 held-out successes, plus training rows the model never scored.
  const ledger = () => [
    ...Array.from({ length: 12 }, (_, i) => ({ missionId: `hf${i}`, outcome: 'failed', verified: false, mutationSweep: sweep })),
    ...Array.from({ length: 8 }, (_, i) => ({ missionId: `hs${i}`, outcome: 'landed', verified: true, mutationSweep: sweep })),
    ...Array.from({ length: 6 }, (_, i) => ({ missionId: `t${i}`, outcome: 'landed', verified: true, mutationSweep: sweep })),
  ]
  const exported = (home) => () => ({ n: 26, n32: 20, nHindsight: 26, paths: { dataset: 'd16', dataset32: 'd32', hindsight: 'dh', out: join(home, 'datasets', 'outcome-model.json') } })
  const io = (home, over = {}) => ({
    writeBrief: (p) => p,
    dispatch: async () => ({ missionId: 'c8-wave1-1' }),
    waitForDriver: async () => ({ exited: true }),
    readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 3600, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: true, identityGuard: { passed: true }, toolStats: {} }),
    commitsBetween: () => [],
    grade: async () => g(), checkIdentity: okIdentity,
    salvageOf: () => null,
    patchRow: () => {},
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    readLedgerRows: ledger,
    datasetsHome: () => home,
    exportOutcomeDataset: exported(home),
    ...over,
  })
  const verdictsIn = (home) => JSON.parse(readFileSync(join(home, 'datasets', 'rule-verdicts.json'), 'utf8'))
  // A model file as scripts/cynco-outcome-model.py writes it: gbt fires on 8
  // held-out failures and 2 held-out successes; lr on nothing.
  const writeModel = (path) => {
    mkdirSync(join(path, '..'), { recursive: true })
    const ids = [...Array.from({ length: 12 }, (_, i) => `hf${i}`), ...Array.from({ length: 8 }, (_, i) => `hs${i}`)]
    const gbtFired = new Set(['hf0', 'hf1', 'hf2', 'hf3', 'hf4', 'hf5', 'hf6', 'hf7', 'hs0', 'hs1'])
    const preds = (fired) => ids.map(missionId => ({ missionId, pFail: fired.has(missionId) ? 0.8 : 0.2 }))
    const m = (fired, auc) => ({ precision: null, recall: null, brier: 0.2, auc, predictions: preds(fired) })
    writeFileSync(path, JSON.stringify({ schema: 1, version: 3, trainedAt: 't', prefixTurns: 16, nTrain: 6, nHoldout: 20, baseRate: 0.6, features: ['a', 'b'], droppedFeatures: [],
      lengthFeature: null, models: { lr: m(new Set(), 0.5), gbt: m(gbtFired, 0.71) }, leakCheck: { lr: { aucPrefix: 0.5, aucHindsight: 0.6 }, gbt: { aucPrefix: 0.71, aucHindsight: 0.93 } },
      secondary: { refusal: 'TOO FEW: train 5 < 30 or holdout 19 < 8' } }))
  }

  it('a python that fails is a fault on the record and one UNMEASURED line — the verdict goes on without model rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hc-'))
    // A stale model from an earlier wave must NOT be read when this retrain failed.
    writeModel(join(home, 'datasets', 'outcome-model.json'))
    let entry = null
    const rec = await runWave(spec, freshState(), io(home, {
      runHindcast: () => ({ status: 1, stdout: '', stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'sklearn'\n", elapsedMs: 40, timedOut: false, fault: null }),
      appendLog: (t) => { entry = t },
    }))
    expect(rec.decision.kind).toBe('next')
    expect(rec.hindcast).toEqual({ fault: "exit 1: Traceback (most recent call last): | ModuleNotFoundError: No module named 'sklearn'" })
    // Phase 6 Task 4: the runner row R1.no-progress is always written — no
    // wave read past 50 % here, so it is UNMEASURED with no numbers.
    expect(rec.ruleVerdicts).toMatchObject({ version: 1, predictive: [], total: 1, rules: 0, modelRows: 0, runnerRows: 1 })
    expect(Object.keys(verdictsIn(home).rules)).toEqual(['R1.no-progress'])
    expect(entry).toMatch(/^- Scoreboard: .*\n- Outcome hindcast: UNMEASURED — exit 1: .*No module named 'sklearn'; R1\.no-progress precision null on 0 fired p\(Holm\) null UNMEASURED — no wave in scope \(no shadow decision at 50 % of its clock or later\)$/m)
  })

  it('TOO FEW (exit 2) and a spawn fault read the same way; a throw from the seam too', async () => {
    const tooFew = await runWave(spec, freshState(), io(mkdtempSync(join(tmpdir(), 'hc-')), { runHindcast: () => ({ status: 2, stdout: 'TOO FEW: train 12 < 30 or holdout 4 < 8\n', stderr: '', fault: null }) }))
    expect(tooFew.hindcast).toEqual({ fault: 'exit 2: TOO FEW: train 12 < 30 or holdout 4 < 8' })
    const faulted = await runWave(spec, freshState(), io(mkdtempSync(join(tmpdir(), 'hc-')), { runHindcast: () => ({ status: null, stdout: '', stderr: '', fault: { code: 'ENOENT', status: null, signal: null, elapsedMs: 3 } }) }))
    expect(faulted.hindcast).toEqual({ fault: 'the hindcast did not run (code ENOENT, status null, after 3 ms)' })
    const thrown = await runWave(spec, freshState(), io(mkdtempSync(join(tmpdir(), 'hc-')), { exportOutcomeDataset: () => { throw new Error('disk full') } }))
    expect(thrown.decision.kind).toBe('next')
    expect(thrown.hindcast).toEqual({ fault: 'disk full' })
    expect(thrown.ruleVerdicts).not.toBeNull()
  })

  it('no eligible mission: python is never spawned', async () => {
    const rec = await runWave(spec, freshState(), io(mkdtempSync(join(tmpdir(), 'hc-')), {
      exportOutcomeDataset: () => ({ n: 0, paths: {} }),
      runHindcast: () => { throw new Error('python must not be spawned for an empty dataset') },
    }))
    expect(rec.hindcast).toEqual({ fault: 'no eligible labeled mission at K = 16 turns — nothing to train on' })
  })

  // F165 review N2: the VERDICT path itself splits the rules that read the v2
  // homeostat streak (W5, I2) by signals version — proven here, at runWave,
  // not only on writeRuleVerdicts.
  it('at VERDICT, W5 is scored on v2 missions only with its v1 table kept apart; the ledger names the split', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hc-'))
    const turns = (v) => Array.from({ length: 20 }, () => (v === 2 ? { signalsVersion: 2 } : {}))
    const m = (id, ok, ruleIds, v) => ({ missionId: id, outcome: ok ? 'landed' : 'failed', verified: ok, mutationSweep: sweep, s5Decisions: [{ ruleIds }], turns: turns(v) })
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => m(`a${i}`, i % 2 === 0, ['W5'], 1)),
      ...Array.from({ length: 4 }, (_, i) => m(`b${i}`, false, ['W5'], 2)),
      ...Array.from({ length: 4 }, (_, i) => m(`c${i}`, true, [], 2)),
    ]
    const rec = await runWave(spec, freshState(), io(home, { readLedgerRows: () => rows, exportOutcomeDataset: () => ({ n: 0, paths: {} }) }))
    expect(rec.ruleVerdicts).not.toBeNull()
    const f = verdictsIn(home)
    expect(f.ledger.v2Rules).toEqual(['I2', 'W5'])
    expect(f.rules.W5).toMatchObject({ signals: 'v2', n: 4, failures: 4, precision: 1, scopeN: 8 })
    expect(f.rules.W5.v1).toMatchObject({ n: 6, failures: 3, precision: 0.5, scopeN: 6 })
  })

  it('at VERDICT, a v2 pool below the freeze minimum reads "v2 holdout not yet frozen" with the counts; python is not spawned', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hc-'))
    const manifestPath = join(home, 'frozen-eval.json')
    writeFileSync(manifestPath, JSON.stringify({ schema: 1, version: 1, seed: 1, frozenAt: 't', missionIds: ['hf0'] }))
    const { exportOutcomeDatasets } = await import('../cynco-hindcast.mjs')
    const rows = Array.from({ length: 5 }, (_, i) => ({ missionId: `v${i}`, outcome: i % 2 ? 'landed' : 'failed', verified: i % 2 === 1, mutationSweep: sweep,
      turns: Array.from({ length: 20 }, () => ({ signalsVersion: 2, toolSuccessRate: 1 })) }))
    const rec = await runWave(spec, freshState(), io(home, {
      readLedgerRows: () => rows,
      exportOutcomeDataset: (args) => exportOutcomeDatasets({ ...args, manifestPath }),
      runHindcast: () => { throw new Error('python must not be spawned before the v2 holdout is frozen') },
    }))
    expect(rec.hindcast).toMatchObject({ fault: 'v2 holdout not yet frozen (5 of 38 labeled; eligible by version: v2: 5)', signalsVersion: 2,
      rowsByVersion: { 2: 5 }, holdout: { frozen: false, eligible: 5, needed: 38 } })
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).schema).toBe(1)
  })

  it('a clean retrain puts M1.* into rule-verdicts.json through the rules\' test, and prints the line after the board', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hc-'))
    const seen = {}
    let entry = null
    const rec = await runWave(spec, freshState(), io(home, {
      exportOutcomeDataset: (args) => { seen.export = args; return exported(home)() },
      runHindcast: ({ paths }) => { seen.paths = paths; writeModel(paths.out); return { status: 0, stdout: 'ok', stderr: '', fault: null } },
      appendLog: (t) => { entry = t },
    }))
    expect(seen.export.home).toBe(home)
    expect(seen.export.rows).toHaveLength(26)
    expect(seen.paths.out).toBe(join(home, 'datasets', 'outcome-model.json'))
    const f = verdictsIn(home)
    expect(f.rules['M1.gbt']).toMatchObject({ source: 'model', scope: 'holdout', n: 10, failures: 8, precision: 0.8 })
    expect(f.rules['M1.lr']).toMatchObject({ source: 'model', n: 0, precision: null, verdict: 'TOO FEW — cannot tell' })
    expect(rec.hindcast).toMatchObject({ version: 3, prefixTurns: 16, nHoldout: 20, baseRate: 0.6, features: 2, lengthFeature: null,
      models: { gbt: { auc: 0.71 } }, secondary: { refusal: 'TOO FEW: train 5 < 30 or holdout 19 < 8' } })
    expect(rec.hindcast.ladder['M1.gbt']).toEqual(f.rules['M1.gbt'])
    expect(rec.ruleVerdicts.total).toBe(3)
    expect(entry).toMatch(/^- Scoreboard: .*\n- Outcome hindcast: v3 at K = 16 turns on 20 held-out missions \(base 60%\): M1\.gbt precision 80% \[\d+, \d+\] on 10 fired p\(Holm\) \d\.\d{3} [A-Z][A-Z ]+; M1\.lr precision null on 0 fired p\(Holm\) null TOO FEW; R1\.no-progress precision null on 0 fired p\(Holm\) null UNMEASURED — no wave in scope \(no shadow decision at 50 % of its clock or later\); leak check gbt AUC prefix 0\.71 \/ hindsight 0\.93, lr AUC prefix 0\.50 \/ hindsight 0\.60; K = 32 TOO FEW: train 5 < 30 or holdout 19 < 8$/m)
  })

  // Final review M1 (T5-M1): a writeRuleVerdicts that throws on the MODEL rows
  // must not leave last wave's file for the engine — the rules are rewritten
  // alone, and the hindcast says its ladder faulted.
  it('a verdict write that throws only on the model rows → the rules are written alone, ladderFault on the hindcast', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hc-'))
    // Last wave's file, holding a verdict this wave must replace.
    mkdirSync(join(home, 'datasets'), { recursive: true })
    writeFileSync(join(home, 'datasets', 'rule-verdicts.json'), JSON.stringify({ schema: 1, version: 7, at: 'stale', rules: { I3: { verdict: 'PREDICTIVE' } }, predictive: ['I3'], history: [] }))
    const calls = []
    let entry = null
    const rec = await runWave(spec, freshState(), io(home, {
      runHindcast: ({ paths }) => { writeModel(paths.out); return { status: 0, stdout: 'ok', stderr: '', fault: null } },
      writeRuleVerdicts: (args) => {
        calls.push(args.modelRows.length)
        if (args.modelRows.length) throw new Error('Holm over a NaN p')
        return realWriteRuleVerdicts(args)
      },
      appendLog: (t) => { entry = t },
    }))
    expect(rec.decision.kind).toBe('next')
    expect(calls).toEqual([2, 0])
    const f = verdictsIn(home)
    expect(f.at).not.toBe('stale')
    expect(Object.keys(f.rules).filter(id => id.startsWith('M1.'))).toEqual([])
    // The runner row does not depend on the hindcast: it is kept.
    expect(f.rules['R1.no-progress']).toMatchObject({ source: 'runner' })
    expect(f.predictive).toEqual([])
    expect(rec.ruleVerdicts).toMatchObject({ modelRowsSkipped: true, predictive: [] })
    expect(rec.hindcast.ladderFault).toBe('Holm over a NaN p')
    expect(rec.hindcast.ladder).toBeNull()
    expect(rec.hindcast.version).toBe(3)
    expect(entry).toMatch(/- Outcome hindcast: v3 at K = 16 turns .*LADDER NOT WRITTEN \(Holm over a NaN p\) — rules rewritten alone; R1\.no-progress precision null on 0 fired p\(Holm\) null UNMEASURED — no wave in scope \(no shadow decision at 50 % of its clock or later\); leak check/)
  })

  it('a throw with no model rows is the rules\' own: the outer catch logs it, the wave is not faulted', async () => {
    const calls = []
    const rec = await runWave(spec, freshState(), io(mkdtempSync(join(tmpdir(), 'hc-')), {
      runHindcast: () => ({ status: 1, stdout: '', stderr: 'boom', fault: null }),
      writeRuleVerdicts: (args) => { calls.push(args.modelRows.length); throw new Error('disk full') },
    }))
    expect(calls).toEqual([0])
    expect(rec.decision.kind).toBe('next')
    expect(rec.ruleVerdicts).toBeNull()
  })
})

describe('main --autopoiesis', () => {
  const BASE_SHA = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const withHome = async (home, fn) => {
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    try { return await fn() } finally { if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev }
  }
  const capture = async (fn) => {
    const out = []
    const orig = console.log
    console.log = (...a) => { out.push(a.join(' ')) }
    try { return { code: await fn(), out: out.join('\n') } } finally { console.log = orig }
  }

  it('prints the assessment over an existing campaign, dispatches nothing, writes nothing, exits 0', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const heldout = join(home, 'heldout', 'civkings-redesign', 'c8')
    mkdirSync(heldout, { recursive: true })
    for (const n of ['gate_c8.py', 'perturb_c8.py']) writeFileSync(join(heldout, n), '# instrument\n')
    const specPath = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json')
    writeFileSync(specPath, JSON.stringify({ ...spec, repo: '.', base: BASE_SHA, gate: join(heldout, 'gate_c8.py'), perturb: join(heldout, 'perturb_c8.py'),
      suiteBaseline: join(heldout, 'suite-baseline.json'), ideation: { enabled: false } }))
    const state = new CampaignState(join(home, 'campaigns', 'c8')).load()
    state.state.waveCount = 1; state.state.lastCommits = [{ sha: 'h', subject: 's' }]
    state.save()
    state.appendWave({ wave: 1, missionId: 'c8-wave1-1', gradedAt: 't1', identity: { intact: true, violated: [] }, s4: {} })
    const before = readFileSync(join(state.dir, 'state.json'), 'utf8')
    const dispatch = () => { throw new Error('--autopoiesis must not dispatch') }
    const { code, out } = await withHome(home, () => capture(() => main([specPath, '--autopoiesis'], {
      readLedgerRows: () => [{ missionId: 'c8-wave1-1', identityGuard: { passed: true } }], dispatch })))
    expect(code).toBe(0)
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    expect(json).toMatchObject({ isAutopoietic: false, criteria: { hasBoundary: true, boundarySelfProduced: false, internalProduction: true, organizationMaintained: true } })
    expect(json.network.unproduced).toContain('gate')
    expect(out).toMatch(/^- Autopoiesis: \d\/6 — missing boundarySelfProduced/m)
    expect(readFileSync(join(state.dir, 'state.json'), 'utf8')).toBe(before)
    expect(state.waves()).toHaveLength(1)
    expect(existsSync(join(state.dir, 'runner.lock'))).toBe(false)
  })

  it('the verb and the runner agree — configuration → seat from the retained store included', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    writeSeats(home, readSeats(home), { seat: 'gate-author', authority: 0.5, decidedAt: 't', campaign: 'c7' })
    const state = new CampaignState(join(home, 'campaigns', 'c8')).load()
    state.state.calibration = { gateSha256: calibrateIo.sha256(GATE), perturbSha256: calibrateIo.sha256(PERTURB), baseFails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], basePasses: [] }
    state.state.lastBase = '1d03308'; state.state.lastFails = ['C8.1a']
    const row = (missionId) => ({ missionId, exitReason: 'marker', durationS: 10, commitRange: { base: 'b', head: 'h' }, outcome: 'landed', markerSeen: true, identityGuard: { passed: true }, toolStats: {} })
    const rec = await runWave(spec, state, {
      writeBrief: (p) => p, dispatch: async () => ({ missionId: 'c8-wave1-1' }), waitForDriver: async () => ({ exited: true }),
      readRow: row, commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }], grade: async () => g(), checkIdentity: okIdentity,
      salvageOf: () => null, patchRow: () => {}, commit: () => ({ sha: 'v1' }), notify: async () => true, economics: () => [], appendLog: () => {},
      ...inertTriples, seatsHome: () => home,
    })
    expect(rec.autopoiesis.network.productions).toContainEqual(['configuration', 'seat'])
    const specPath = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json')
    writeFileSync(specPath, JSON.stringify({ ...spec, repo: '.', base: BASE_SHA, suiteBaseline: join(HELDOUT, 'suite-baseline.json') }))
    const { code, out } = await withHome(home, () => capture(() => main([specPath, '--autopoiesis'], { readLedgerRows: () => [row('c8-wave1-1')] })))
    expect(code).toBe(0)
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    expect(json.facts.seatAuthority).toBe(0.5)
    expect(json.network).toEqual(rec.autopoiesis.network)
    expect(json.criteria).toEqual(rec.autopoiesis.criteria)
  })

  it('refuses a campaign that has no state, and creates nothing', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const heldout = join(home, 'heldout', 'civkings-redesign', 'c8')
    mkdirSync(heldout, { recursive: true })
    for (const n of ['gate_c8.py', 'perturb_c8.py']) writeFileSync(join(heldout, n), '# instrument\n')
    const specPath = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json')
    writeFileSync(specPath, JSON.stringify({ ...spec, repo: '.', base: BASE_SHA, gate: join(heldout, 'gate_c8.py'), perturb: join(heldout, 'perturb_c8.py'),
      suiteBaseline: join(heldout, 'suite-baseline.json'), ideation: { enabled: false } }))
    const code = await withHome(home, () => main([specPath, '--autopoiesis'], { readLedgerRows: () => [] }))
    expect(code).toBe(2)
    expect(existsSync(join(home, 'campaigns'))).toBe(false)
  })
})
