// F242: "the integrity check stops a campaign when a protected file changes (fake protected folder)",
// the owner's acceptance line, end to end through runWave with the REAL engine/integrity.ts over fake
// folders (06-acceptance-records.md, test T4). The runner's unit cases with a fake integrity io are
// slice S7's (cynco-campaign.test.mjs) and are not repeated here.
//
// Every folder is under one temp root per case; the guard folder, the fake home and the models folder
// are passed to the integrity functions as arguments; the pager is a spy. No dispatch is started: the
// io's `dispatch` plays dispatch-mission.sh and its watcher (it takes the baseline for a fresh run id,
// runs the "mission" the case supplies, settles the run as the watcher does, and returns the run id),
// and the integrity io has every seam production's has (`refusal` with the models record, `early`,
// `halt`, `settled`, `settleWaitMs`, `sleep`). Nothing in this file calls fetch.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, runWave, defaultIo } from '../cynco-campaign.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { defaultIo as calibrateIo } from '../cynco-campaign-calibrate.mjs'
import { checkModelsRecord, clearHalt, compareRun, haltRefusal, hashModels, openBaselines, protectedRoots, settleRun, takeBaseline, tripHalt } from '../../engine/integrity.js'
import { mintRunId } from '../../engine/containment.js'

const roots = []
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d }
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

// ─── The rig, copied from cynco-campaign.test.mjs (lines 35-40, 66-93 and 130); no shared module ───
const HELDOUT = join(temp('inst-'), '.cynco', 'heldout', 'c8')
mkdirSync(HELDOUT, { recursive: true })
const standIn = (src, name) => { const p = join(HELDOUT, name); copyFileSync(fileURLToPath(new URL(src, import.meta.url)), p); return p }
const GATE = standIn('../cynco-campaign-grade.mjs', 'gate_c8.py')
const PERTURB = standIn('../cynco-campaign-spec.mjs', 'perturb_c8.py')
const okIdentity = () => ({ ok: true, problems: [] })
const spec = { id: 'c8', title: 't', repo: 'C:/repo', base: '1d03308', marker: 'stage c8 complete', keepGreen: 'python -m pytest a.py -q',
  gate: GATE, perturb: PERTURB,
  budget: { hoursPerWave: 1, iterations: 100, bashTimeoutMs: 1000, waves: 3 }, invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, allow: { newFiles: ['gilded/ui/portraits.py', 'gilded/assets/portraits/**'], edit: ['gilded/ui/atlas_view.py', 'gilded/ui/registry.py (legend rows only)'] },
  deny: [], measures: 'M', work: [{ id: 1, title: 'W', gateIds: ['C8.1a'], text: 't' }], rules: [], ideation: { enabled: false } }
const g = (over = {}) => ({ sha: 'h', verified: false, gate: { terminator: 'MISS', fails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], passes: [], failCount: 1, errors: [], harnessFault: null, exit: 1, priorRegressions: 0 }, suite: { exit: 0, regressions: [], repairs: [], harnessFault: null }, sweep: { kind: 'derived', killed: 1, total: 1, survived: [] }, posiwid: { verdict: 'Consistent', divergence: 0, dominantObserved: 'inspect' }, ...over })
const freshState = (dir) => {
  const state = new CampaignState(join(dir, 'c8')).load()
  state.state.calibration = { gateSha256: calibrateIo.sha256(GATE), perturbSha256: calibrateIo.sha256(PERTURB), baseFails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], basePasses: [] }
  state.state.lastBase = '1d03308'; state.state.lastFails = ['C8.1a']
  return state
}
const inertTriples = {
  exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} } }),
  analyseDenials: () => null,
  exportGateLines: () => ({ rows: [], summary: null }),
  exportGateOutcomes: () => ({ rows: [], outPath: null }),
  readLedgerRows: () => [],
}
const faultIo = () => ({ readLedgerRows: () => [], datasetsHome: () => temp('ds-faultio-'), economics: () => null })
// No case falls through to defaultIo's ledger walk, its home, or its integrity seam (which reads the real guard folder).
const ledgerWalks = []
defaultIo.readLedgerRows = () => { ledgerWalks.push(expect.getState().currentTestName); return [] }
afterEach(() => expect(ledgerWalks.splice(0), 'fell through to the real ledger walk').toEqual([]))
defaultIo.datasetsHome = () => temp('ds-campaign-integrity-')
defaultIo.exportGateLines = () => ({ rows: [], summary: null })
defaultIo.exportGateOutcomes = () => ({ rows: [], outPath: null })
defaultIo.integrity = { refusal: () => { throw new Error('defaultIo.integrity was reached') }, early: async () => { throw new Error('defaultIo.integrity was reached') }, halt: async () => { throw new Error('defaultIo.integrity was reached') } }

let fetchCalls = 0
const realFetch = globalThis.fetch
beforeAll(() => { globalThis.fetch = async (...a) => { fetchCalls++; throw new Error(`fetch was called: ${String(a[0])}`) } })
afterAll(() => {
  globalThis.fetch = realFetch
  expect(fetchCalls, 'something in this file called fetch').toBe(0)
})

// ─── One world per case: a fake home, the guard, the models folder, a repository ─────────────
async function world({ pagerAnswer = true } = {}) {
  const root = temp('cynco-camp-integ-')
  const home = join(root, 'home')
  const cynco = join(home, '.cynco')
  const guard = join(root, 'guard')
  const models = join(root, 'models')
  const repo = join(root, 'repo')
  const put = (p, text = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text) }
  put(join(cynco, 'profiles', 'default.yaml'), 'name: default\n')
  put(join(cynco, 'heldout', 'c1', 'gate.py'), "print('gate')\n")
  mkdirSync(join(cynco, 'campaigns'), { recursive: true })
  mkdirSync(join(cynco, 'authoring'), { recursive: true })
  put(join(home, '.ssh', 'known_hosts'), '\n')
  put(join(home, '.a', 'x'))
  for (const n of ['1', '2', '3', '4']) put(join(home, '.b', n))
  put(join(models, 'm1', 'model.gguf'), 'GGUF')
  mkdirSync(guard)
  mkdirSync(repo)
  const pages = []
  const page = async (p) => { pages.push(p); return pagerAnswer }
  // The models hash record, taken once, as `bun scripts/cynco-guard.mjs hash-models` takes it.
  await hashModels({ root: models, guard })
  // The same seams as defaultIo.integrity in scripts/cynco-campaign.mjs, over the fake folders.
  const integrity = {
    refusal: () => haltRefusal(guard, home) ?? checkModelsRecord({ root: models, guard }),
    // confirmMs 0: the confirming second walk is taken at once (the default waits 2 s).
    early: (runId) => compareRun(runId, { by: 'campaign', page, guard, confirmMs: 0 }),
    halt: (what) => tripHalt({ ...what, guard, page }),
    settled: (runId) => !openBaselines(guard).some(b => b.runId === runId),
    settleWaitMs: 0,
    sleep: async () => {},
  }
  return { root, home, cynco, guard, models, repo, pages, page, integrity, stateDir: join(root, 'state') }
}

function waveIo(w, mission, over = {}, { settleInDispatch = true } = {}) {
  const seen = { patched: [], graded: 0, wrote: 0, dispatched: 0, runIds: [], settles: [] }
  const io = {
    writeBrief: (p) => { seen.wrote++; return p },
    dispatch: async () => {
      // dispatch-mission.sh's pre-step, then the mission. The baseline is the integrity layer's own.
      const runId = mintRunId('dispatch')
      takeBaseline({ runId, cwd: w.repo, by: 'dispatch', guard: w.guard, home: w.home, roots: protectedRoots({ home: w.home, cynco: w.cynco, models: w.models }), checkModels: false })
      seen.dispatched++
      seen.runIds.push(runId)
      await mission(w)
      // The dispatch watcher's settling compare once the engine is gone: the authority (rule 9). It
      // closes the baseline, and on a change writes the latch and pages by itself.
      if (settleInDispatch) seen.settles.push(await settleRun(runId, { by: 'dispatch', page: w.page, guard: w.guard, confirmMs: 0 }))
      return { driverLog: join(w.root, 'driver.log'), runId }
    },
    waitForDriver: async () => ({ exited: true, missionId: `c8-wave${seen.dispatched}-1` }),
    readRow: (missionId) => ({ missionId, exitReason: 'timeout', durationS: 100, commitRange: { base: '1d03308', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: { total: 10, commits: 1, byClass: { sourceEdit: 2, fileWrite: 0, inspect: 8 }, byName: {} } }),
    commitsBetween: () => [{ sha: 'h', subject: 'C8 commit 1' }],
    grade: async () => { seen.graded++; return g() }, checkIdentity: okIdentity,
    salvageOf: () => null,
    ideate: async () => ({ ideation: null }),
    patchRow: (missionId, fields) => { seen.patched.push({ missionId, fields }) },
    commit: () => ({ sha: 'v1' }),
    notify: async () => true,
    economics: () => [],
    appendLog: () => {},
    ...inertTriples,
    ...faultIo(),
    integrity: w.integrity,
    ...over,
  }
  return { io, seen }
}

const destroyGate = async (w) => { unlinkSync(join(w.cynco, 'heldout', 'c1', 'gate.py')) }
const nothing = async () => {}

describe('decide reads the integrity summary on the row (T4 case 1)', () => {
  const passing = g({ verified: true, gate: { ...g().gate, terminator: 'PASS', fails: [], exit: 0 } })
  const st = { waveCount: 1, consecutiveNoProgress: 0, lastFails: null }
  const changed = { changed: true, changeCount: 1, firstClass: 'FROZEN', firstRoot: 'C:/x/.cynco/heldout', latchPath: 'C:/g/HALT.json' }
  it('a PASS grade with a changed row is the integrity fault', () => {
    const d = decide({ grade: passing, state: st, spec, commitsLanded: 3, row: { integrity: changed } })
    expect(d.kind).toBe('fault')
    expect(d.why).toMatch(/integrity/)
  })
  it('it is the integrity fault also when the invariants were rejected', () => {
    const d = decide({ grade: passing, state: st, spec, commitsLanded: 3, row: { integrity: changed, invariantsRejected: true } })
    expect(d.kind).toBe('fault')
    expect(d.why).toMatch(/^integrity/)
  })
  it('a row without the field, or unchanged, decides as before', () => {
    expect(decide({ grade: passing, state: st, spec, commitsLanded: 3, row: {} }).kind).toBe('pass')
    expect(decide({ grade: passing, state: st, spec, commitsLanded: 3, row: { integrity: { changed: false } } }).kind).toBe('pass')
  })
})

describe('the integrity check stops a campaign (T4 cases 2 to 7, the real integrity layer over fake folders)', () => {
  it('2. a wave whose mission deletes a held-out gate is a fault, latched and paged once, and not graded', async () => {
    const w = await world()
    const state = freshState(w.stateDir)
    const { io, seen } = waveIo(w, destroyGate)
    const rec = await runWave(spec, state, io)
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/^integrity: /)
    // The watcher's settle found it and closed the baseline; the runner waited for it (`settled`) and read its record.
    expect(seen.settles).toHaveLength(1)
    expect(seen.settles[0].changed).toBe(true)
    expect(openBaselines(w.guard).map(b => b.runId)).not.toContain(seen.runIds[0])
    const latch = join(w.guard, 'HALT.json')
    expect(existsSync(latch)).toBe(true)
    expect(readFileSync(latch, 'utf8').replace(/\\\\/g, '/')).toMatch(/heldout\/c1\/gate\.py/)
    expect(w.pages.length).toBe(1)
    expect(w.pages[0].priority).toBe(5)
    expect(seen.graded).toBe(0)
    expect(rec.missionId).toBe('c8-wave1-1')
    expect(seen.patched).toHaveLength(1)
    expect(seen.patched[0].missionId).toBe('c8-wave1-1')
    const fields = seen.patched[0].fields.integrity
    expect(Object.keys(fields).sort()).toEqual(['changeCount', 'changed', 'firstClass', 'firstRoot', 'latchPath'])
    expect(fields.changed).toBe(true)
    expect(Object.values(fields).some(v => Array.isArray(v)), 'the row carries no list of paths').toBe(false)

    // 3. The next wave under the latch: a stop, no brief written, nothing dispatched, no wave spent.
    const spent = state.state.waveCount
    const wrote = seen.wrote
    const rec2 = await runWave(spec, state, io)
    expect(rec2.decision.kind).toBe('stop')
    expect(rec2.decision.why).toContain(haltRefusal(w.guard, w.home))
    expect(seen.dispatched).toBe(1)
    expect(seen.wrote).toBe(wrote)
    expect(state.state.waveCount).toBe(spent)

    // 6. The owner clears the latch at a terminal: the faulted wave keeps its mission id and its patched row, and a new wave dispatches again.
    clearHalt(w.guard, { by: 'the owner, in a test', terminal: { isTTY: true }, typed: 'CLEAR' })
    expect(existsSync(latch)).toBe(false)
    const faulted = state.waves().find(r => r.decision?.kind === 'fault')
    expect(faulted.missionId).toBe('c8-wave1-1')
    const { io: io3, seen: seen3 } = waveIo(w, nothing)
    const rec3 = await runWave(spec, state, io3)
    expect(seen3.dispatched).toBe(1)
    expect(rec3.decision.kind).not.toBe('fault')
    expect(rec3.decision.kind).not.toBe('stop')
  })

  it('4. the runner writing into a frozen folder BETWEEN waves trips nothing: each dispatch takes its own baseline', async () => {
    const w = await world()
    const state = freshState(w.stateDir)
    const { io, seen } = waveIo(w, nothing)
    const rec1 = await runWave(spec, state, io)
    expect(rec1.decision.kind).toBe('next')
    // Between waves 1 and 2: the runner writes a profile. A baseline taken at campaign start would see it; the dispatch's does not.
    writeFileSync(join(w.cynco, 'profiles', 'written-between-waves.yaml'), 'name: x\n')
    const rec2 = await runWave(spec, state, io)
    expect(rec2.decision.kind).toBe('next')
    expect(seen.dispatched).toBe(2)
    expect(seen.graded).toBe(2)
    expect(existsSync(join(w.guard, 'HALT.json'))).toBe(false)
    expect(w.pages).toEqual([])
    expect(rec2.integrity).toEqual({ changed: false, changeCount: 0, firstClass: null, firstRoot: null, latchPath: null })
  })

  it('5. the latch does not depend on the page: with the pager failing, the latch stands and one page waits in unsent/', async () => {
    const w = await world({ pagerAnswer: false })
    const state = freshState(w.stateDir)
    const { io, seen } = waveIo(w, destroyGate)
    const rec = await runWave(spec, state, io)
    expect(rec.decision.kind).toBe('fault')
    expect(existsSync(join(w.guard, 'HALT.json'))).toBe(true)
    expect(seen.graded).toBe(0)
    const unsent = readdirSync(join(w.guard, 'unsent')).filter(n => n.endsWith('.json'))
    expect(unsent).toHaveLength(1)
  })

  it('7. a models folder that no longer matches its hash record stops the next wave before anything is written or dispatched', async () => {
    const w = await world()
    const state = freshState(w.stateDir)
    writeFileSync(join(w.models, 'm1', 'model.gguf'), 'GGUF, rewritten')
    const { io, seen } = waveIo(w, nothing)
    const spent = state.state.waveCount
    const rec = await runWave(spec, state, io)
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toContain(checkModelsRecord({ root: w.models, guard: w.guard }))
    expect(rec.decision.why).toMatch(/models folder differs from its hash record/)
    expect(seen.wrote).toBe(0)
    expect(seen.dispatched).toBe(0)
    expect(state.state.waveCount).toBe(spent)
  })

  it('8. a watcher that never settles within the bound leaves an engine not confirmed dead: the latch, and no grade', async () => {
    const w = await world()
    const state = freshState(w.stateDir)
    const { io, seen } = waveIo(w, nothing, {}, { settleInDispatch: false })
    const rec = await runWave(spec, state, io)
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toMatch(/had not compared run/)
    expect(existsSync(join(w.guard, 'HALT.json'))).toBe(true)
    expect(seen.graded).toBe(0)
  })
})
