// The runner reads a campaign's home from its spec (scripts/cynco-campaign-home.mjs):
// a campaign on another repository writes its briefs and log into its own
// folder and commits neither, its roadmap is its own (or none), and its suite
// gate runs its own pytest target (or none). A spec with no home keys behaves
// exactly as the CivKings campaigns always have. Every path here is a temp dir;
// the live docs/civkings-redesign-briefs is never written.
import { describe, it, expect, afterEach } from 'vitest'
import { runWave, dirtyOutsideCampaign, suiteGateCommand, suiteGateRefusal, waveDispatch, waveContext, decide, fileInCheckout, recordSpecPath, SUITE_GATE_ENV_KEYS } from '../cynco-campaign.mjs'
import { generateBrief } from '../cynco-brief.mjs'
import { runSuiteGate, runGate } from '../cynco-campaign-grade.mjs'
import { verdictEntry } from '../cynco-campaign-verdict.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { defaultIo as calibrateIo, calibrate } from '../cynco-campaign-calibrate.mjs'
import { gateInterpreter } from '../cynco-gate-parse.mjs'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d }
const fwd = (p) => p.replace(/\\/g, '/')

const HELDOUT = join(mkdtempSync(join(tmpdir(), 'inst-home-')), '.cynco', 'heldout', 'partynight', 't3')
mkdirSync(HELDOUT, { recursive: true })
const standIn = (src, name) => { const p = join(HELDOUT, name); copyFileSync(fileURLToPath(new URL(src, import.meta.url)), p); return p }
const GATE = standIn('../cynco-campaign-grade.mjs', 'gate_t3.py')
const PERTURB = standIn('../cynco-campaign-spec.mjs', 'perturb_t3.py')

const specFor = (over = {}) => ({ id: 't3', title: 't', repo: 'C:/Users/civer/casino', base: '293dc1c', marker: 'stage t3 complete', keepGreen: 'npx vitest run packages/engine/src/poker/persona.test.ts',
  gate: GATE, perturb: PERTURB, suiteBaseline: join(HELDOUT, 'suite.txt'),
  budget: { hoursPerWave: 1, iterations: 100, bashTimeoutMs: 1000, waves: 3 }, invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, allow: { newFiles: ['packages/engine/src/poker/persona.ts'], edit: [] },
  deny: [], measures: 'M', work: [{ id: 1, title: 'W', gateIds: ['T3.1a'], text: 't' }], rules: [], ideation: { enabled: false }, ...over })

const freshState = (id) => {
  const state = new CampaignState(join(tempDir('camp-home-'), id)).load()
  state.state.calibration = { gateSha256: calibrateIo.sha256(GATE), perturbSha256: calibrateIo.sha256(PERTURB), baseFails: [{ id: 'T3.1a', line: 'T3.1a: FAIL x' }], basePasses: [] }
  state.state.lastBase = '293dc1c'; state.state.lastFails = ['T3.1a']
  return state
}
const miss = { sha: 'h', verified: false, gate: { terminator: 'MISS', fails: [{ id: 'T3.1a', line: 'T3.1a: FAIL x' }], passes: [], failCount: 1, errors: [], harnessFault: null, exit: 1, priorRegressions: 0 }, suite: { exit: 0, regressions: [], repairs: [], harnessFault: null }, sweep: null, posiwid: { verdict: 'Consistent', divergence: 0, dominantObserved: 'inspect' } }

const ioFor = (seen) => ({
  writeBrief: (path) => { seen.brief = fwd(path); return path },
  dispatch: async () => ({ missionId: 'm1' }),
  waitForDriver: async () => ({ exited: true }),
  readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 100, commitRange: { base: '293dc1c', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: { total: 10, commits: 1, byClass: { sourceEdit: 2, fileWrite: 0, inspect: 8 }, byName: {} } }),
  commitsBetween: () => [{ sha: 'h', subject: 'T3 commit 1' }],
  grade: async () => miss, checkIdentity: () => ({ ok: true, problems: [] }),
  salvageOf: () => null, ideate: async () => ({ ideation: null }),
  patchRow: () => {}, commit: (args) => { seen.committed = args.files; return { sha: 'v1' } },
  notify: async () => true, economics: () => [], appendLog: (text, logPath) => { seen.logPath = logPath === undefined ? undefined : fwd(logPath) },
  exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} } }), analyseDenials: () => null,
  exportGateLines: () => ({ rows: [], summary: null }), exportGateOutcomes: () => ({ rows: [], outPath: null }),
  readLedgerRows: () => [], datasetsHome: () => tempDir('ds-home-'),
})

describe('runWave reads the campaign home from the spec', () => {
  it('writes the brief into a declared briefsDir and appends to its log, committing neither when they live outside the checkout', async () => {
    const briefs = fwd(tempDir('pn-briefs-'))
    const seen = {}
    const rec = await runWave(specFor({ briefsDir: briefs }), freshState('t3'), ioFor(seen))
    expect(rec.decision.kind).toBe('next')
    expect(seen.brief).toBe(`${briefs}/t3-wave1.txt`)
    expect(seen.logPath).toBe(`${briefs}/campaign-log.md`)
    // Nothing of the campaign's own folder reaches the localcode commit; only
    // the ledger shards a wave touched could (none in a test's fake wave).
    expect((seen.committed ?? []).filter(f => !f.startsWith('benchmark/cynco-ledger/'))).toEqual([])
  })

  it('a spec with no home keys still writes into docs/civkings-redesign-briefs and commits its brief, sidecar and log there', async () => {
    const seen = {}
    await runWave(specFor({ id: 'c99' }), freshState('c99'), ioFor(seen))
    const docs = fwd(resolve('docs/civkings-redesign-briefs'))
    expect(seen.brief).toBe(`${docs}/c99-wave1.txt`)
    expect(seen.logPath).toBe('docs/civkings-redesign-briefs/campaign-log.md')
    expect(seen.committed).toEqual(expect.arrayContaining(['docs/civkings-redesign-briefs/campaign-log.md', 'docs/civkings-redesign-briefs/c99-wave1.txt', 'docs/civkings-redesign-briefs/c99-wave1.contract.json']))
  })
})

describe('fileInCheckout', () => {
  it('is a checkout-relative pathspec inside the checkout and nothing outside it', () => {
    expect(fileInCheckout('docs/civkings-redesign-briefs/campaign-log.md')).toEqual(['docs/civkings-redesign-briefs/campaign-log.md'])
    expect(fileInCheckout(resolve('docs/x.md'))).toEqual(['docs/x.md'])
    expect(fileInCheckout(join(tmpdir(), 'elsewhere', 'log.md'))).toEqual([])
    expect(fileInCheckout('.')).toEqual([])
  })
})

describe('dirtyOutsideCampaign follows the spec\'s briefs folder', () => {
  const lines = ['?? docs/civkings-redesign-briefs/t3-wave1.txt', '?? benchmark/cynco-ledger/missions.0004.jsonl', ' M engine/main.ts']
  it('exempts this campaign\'s untracked briefs in the CivKings folder when the spec names no briefsDir', () => {
    expect(dirtyOutsideCampaign(lines, specFor())).toEqual([' M engine/main.ts'])
  })
  it('exempts nothing in the CivKings folder for a campaign whose briefs live elsewhere', () => {
    expect(dirtyOutsideCampaign(lines, specFor({ briefsDir: fwd(tempDir('pn-dirty-')) }))).toEqual(['?? docs/civkings-redesign-briefs/t3-wave1.txt', ' M engine/main.ts'])
  })
  it('escapes the folder and id it builds the pattern from', () => {
    expect(dirtyOutsideCampaign(['?? docs/aXb/t3-wave1.txt'], specFor({ briefsDir: 'docs/a.b' }))).toEqual(['?? docs/aXb/t3-wave1.txt'])
    expect(dirtyOutsideCampaign(['?? docs/a.b/t3-wave1.txt'], specFor({ briefsDir: 'docs/a.b' }))).toEqual([])
  })
})

describe('the suite gate runs the spec\'s pytest target', () => {
  it('leaves a CivKings command exactly as it was', () => {
    expect(suiteGateCommand(specFor())).not.toMatch(/CHK_SUITE_TARGET/)
    expect(suiteGateCommand(specFor({ suiteTarget: 'gilded/tests' }))).not.toMatch(/CHK_SUITE_TARGET/)
  })
  it('names a non-default target in the command, and never in the engine\'s env', () => {
    const cmd = suiteGateCommand(specFor({ suiteTarget: 'tests' }))
    expect(cmd).toMatch(/ CHK_SUITE_TARGET=tests python "/)
    expect(SUITE_GATE_ENV_KEYS).toContain('CHK_SUITE_TARGET')
    const { env } = waveDispatch(specFor({ suiteTarget: 'tests' }), { briefFile: 'b', invariants: {}, timeoutS: 1, pidFile: 'p', driverLog: 'l' }, { CHK_SUITE_TARGET: 'leak', PATH: 'x' })
    expect(env.CHK_SUITE_TARGET).toBeUndefined()
    expect(env.CYNCO_MARKER_CHECK).toBe(cmd)
  })
  it('has no suite gate for a repository with no pytest suite: its markerCheck is the check', () => {
    const spec = specFor({ suiteTarget: null, markerCheck: 'npx vitest run' })
    expect(() => suiteGateCommand(spec)).toThrow(/suiteTarget is null/)
    expect(suiteGateRefusal(spec)).toBeNull()
    expect(waveDispatch(spec, { briefFile: 'b', invariants: {}, timeoutS: 1, pidFile: 'p', driverLog: 'l' }, {}).env.CYNCO_MARKER_CHECK).toBe('npx vitest run')
  })
  it('runSuiteGate: skipped with no suite, the target in the env when not the default', () => {
    const calls = []
    const io = { run: (cmd, args, opts) => { calls.push(opts.env); return { status: 0, stdout: 'g_suite: PASS', stderr: '' } } }
    const skipped = runSuiteGate(specFor({ suiteTarget: null, markerCheck: 'npx vitest run' }), io)
    expect(skipped).toMatchObject({ exit: 0, regressions: [], harnessFault: null })
    expect(skipped.skipped).toMatch(/no pytest suite/)
    expect(calls).toEqual([])
    runSuiteGate(specFor(), io)
    runSuiteGate(specFor({ suiteTarget: 'tests' }), io)
    expect(calls[0].CHK_SUITE_TARGET).toBeUndefined()
    expect(calls[1].CHK_SUITE_TARGET).toBe('tests')
  })
  it('a skipped suite is said as not run in the decision and the verdict, never as a PASS', () => {
    const grade = { ...miss, verified: true, gate: { ...miss.gate, terminator: 'PASS', fails: [], exit: 0 }, suite: { exit: 0, skipped: 'no pytest suite in this repository (spec suiteTarget null)', regressions: [], repairs: [], harnessFault: null } }
    const d = decide({ grade, state: { lastFails: [] }, spec: specFor(), commitsLanded: 1, row: {} })
    expect(d.kind).toBe('pass')
    expect(d.why).toMatch(/suite gate not run \(no pytest suite\)/)
    expect(d.why).not.toMatch(/suite gate PASS/)
    const entry = verdictEntry({ spec: specFor(), wave: 1, row: { missionId: 'm1', exitReason: 'marker', durationS: 1, toolStats: {} }, grade, decision: d })
    expect(entry).toMatch(/- Suite gate not run: no pytest suite in this repository/)
  })
})

describe('a sealed gate runs under the interpreter its file names', () => {
  it('node for .mjs/.cjs/.js (the casino\'s gate_t1.mjs), python for everything else (every CivKings gate)', () => {
    expect(gateInterpreter('C:/Users/civer/.cynco/heldout/partynight/t1/gate_t1.mjs')).toBe('node')
    expect(gateInterpreter('x/perturb.CJS')).toBe('node')
    expect(gateInterpreter('x/positive.js')).toBe('node')
    expect(gateInterpreter('C:/Users/civer/.cynco/heldout/civkings-redesign/c11/gate_c11.py')).toBe('python')
    expect(gateInterpreter('x/gate')).toBe('python')
  })
  it('calibration and grading launch each instrument with it', async () => {
    const seen = []
    const io = {
      run: (cmd, args) => { seen.push(`${cmd} ${args[0].split('/').pop()}`); return { status: 1, stdout: 'GATE: MISS (1 fail)\nT3.1a: FAIL x\n', stderr: '' } },
      exists: () => true, readFile: () => '# EXPECT-FLIP:\n# MUST-FAIL: T3.1a\n', writeFile: () => {}, sha256: () => 'sha', freshDir: () => {},
    }
    const spec = specFor({ gate: '/h/.cynco/heldout/partynight/t3/gate_t3.mjs', perturb: '/h/.cynco/heldout/partynight/t3/perturb_t3.mjs', positive: '/h/.cynco/heldout/partynight/t3/positive_t3.py', suiteTarget: null, markerCheck: 'npx vitest run' })
    await calibrate(spec, io, { baseDir: '/tmp/base' })
    expect(seen).toEqual(['node gate_t3.mjs', 'node perturb_t3.mjs', 'python positive_t3.py'])
    seen.length = 0
    runGate(spec, io, { repo: '/tmp/repo' })
    expect(seen).toEqual(['node gate_t3.mjs'])
  })
})

describe('the brief says what the gate grades in the campaign\'s own terms', () => {
  const brief = (spec) => generateBrief(spec, waveContext(spec, freshState(spec.id).state, { salvageOf: () => null }))
  it('a CivKings-family campaign keeps the game\'s sentence; another family gets a neutral one', () => {
    expect(brief(specFor({ id: 'c99' }))).toContain('values the game returns; never a claim')
    const casino = brief(specFor({ heldoutFamily: 'partynight' }))
    expect(casino).toContain('the gate grades what the code does, as HOW THE GATE MEASURES defines it; never a claim')
    expect(casino).not.toMatch(/pixels|the game returns/)
  })
})

describe('recordSpecPath', () => {
  it('puts the absolute forward-slash spec path on the state, and save() persists it', () => {
    const state = freshState('t3')
    expect(recordSpecPath(state.state, 'docs/civkings-redesign-briefs/c11.campaign.json')).toBe(fwd(resolve('docs/civkings-redesign-briefs/c11.campaign.json')))
    state.save()
    expect(JSON.parse(readFileSync(state.statePath, 'utf8')).specPath).toBe(fwd(resolve('docs/civkings-redesign-briefs/c11.campaign.json')))
  })
  it('main records it right after the state loads', () => {
    const src = readFileSync(fileURLToPath(new URL('../cynco-campaign.mjs', import.meta.url)), 'utf8')
    expect(src).toMatch(/new CampaignState\(join\(cyncoHome\(\), 'campaigns', spec\.id\)\)\.load\(\)\s+recordSpecPath\(state\.state, specPath\)/)
  })
})
