// The smoke campaign fixture (Phase 4 Task 6): a real one-wave campaign for the
// live proof. These tests run the REAL python against a temp clone of the
// smoke repo — the triple has to be genuinely runnable, not a stand-in — and
// never touch C:/tmp/phase2-smoke itself or the live ~/.cynco.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeSmokeCampaign, runtimeEnvFrom, SMOKE_ID, MARKER_CHECK_ONCE, MARKER_CHECK_STAMP, MARKER_CHECK_ONCE_PY } from '../cynco-smoke-campaign.mjs'
import { loadCampaignSpec, checkIdentity } from '../cynco-campaign-spec.mjs'
import { calibrate, archiveBase } from '../cynco-campaign-calibrate.mjs'
import { parseGateOutput } from '../cynco-gate-parse.mjs'

const SMOKE_REPO = 'C:/tmp/phase2-smoke'
const HAS_SMOKE = existsSync(join(SMOKE_REPO, '.git'))
if (!HAS_SMOKE) console.warn(`[cynco-smoke-campaign.test] SKIPPED: the smoke repo ${SMOKE_REPO} is absent — recreate it to run these tests`)

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GRADED = ['S1.1', 'S1.2', 'S1.3', 'S1.4', 'S1.5', 'S1.6', 'S1.7', 'S1.8']
const FULL_IDS = ['S1.1.ship-notes', 'S1.2.version-file', 'S1.3.changelog', 'S1.4.license', 'S1.5.module-docstring',
  'S1.6.tests-cover-total-docstring', 'S1.7.main-guard', 'S1.8.ship-mentions-version']
const short =(id) => id.split('.').slice(0, 2).join('.')
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' })

/** A fresh clone of the smoke repo in a temp dir — the original is only read. */
function cloneSmoke() {
  const dest = join(mkdtempSync(join(tmpdir(), 's1-repo-')), 'repo')
  const r = git(['clone', '--quiet', SMOKE_REPO, dest])
  if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr}`)
  return dest.replace(/\\/g, '/')
}
const tempHome = () => join(mkdtempSync(join(tmpdir(), 's1-home-')), '.cynco').replace(/\\/g, '/')

// The fixture's BASE is a pinned commit, not the smoke repo's HEAD: the live
// proof's mission ships the very files the gate grades, so after one real wave
// HEAD passes every line and "BASE misses all 8" would be false of HEAD while
// still true of the commit the fixture was calibrated against.
const SMOKE_BASE = '1b00179cdd81fe95ccb0ea0c09ecc85be1f8080f'

describe.skipIf(!HAS_SMOKE)(`smoke campaign s1 (needs ${SMOKE_REPO})`, () => {
  let repo, home, specPath, spec
  beforeAll(() => {
    repo = cloneSmoke()
    if (git(['cat-file', '-e', `${SMOKE_BASE}^{commit}`], repo).status !== 0) throw new Error(`${SMOKE_REPO} lacks the fixture BASE ${SMOKE_BASE}`)
    // F163 / T7-M1: the generator refuses unless the repo's HEAD IS the base,
    // so the temp clone is checked out there (the original is never touched).
    if (git(['checkout', '--quiet', '--detach', SMOKE_BASE], repo).status !== 0) throw new Error(`could not check out ${SMOKE_BASE} in the temp clone`)
    home = tempHome()
    specPath = writeSmokeCampaign({ home, repo, base: SMOKE_BASE })
    spec = loadCampaignSpec(specPath)
  })

  it('writes the triple under heldout, a fresh campaigns/s1 and the spec under smoke/', () => {
    const heldout = `${home}/heldout/civkings-redesign/${SMOKE_ID}`
    for (const f of ['gate_s1.py', 'perturb_s1.py', 'positive_s1.py']) expect(existsSync(join(heldout, f)), f).toBe(true)
    expect(readdirSync(join(home, 'campaigns', SMOKE_ID))).toEqual([])
    expect(specPath.replace(/\\/g, '/')).toBe(`${home}/smoke/s1.campaign.json`)
    const head = SMOKE_BASE
    expect(spec).toMatchObject({
      id: 's1', repo, base: head, author: 'human', marker: 'smoke s1 complete',
      keepGreen: 'python -m pytest -q test_calc.py',
      // Phase 7 ruling 3 / review I3: the smoke's own fails-once fixture, and a
      // retry floor its one-hour wave can reach.
      markerCheck: `python ${home}/smoke/marker_check_once.py`,
      markerRetryMinS: 60,
      gate: `${heldout}/gate_s1.py`, perturb: `${heldout}/perturb_s1.py`, positive: `${heldout}/positive_s1.py`,
      budget: { hoursPerWave: 1, iterations: 300, bashTimeoutMs: 600000, waves: 1 },
      progress: { everyMs: 20_000 },
      invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
      posiwid: { sourceEditShare: 0.3, commitEvery: 60 },
      sweep: { max: 2 }, prBase: 'main',
      allow: { newFiles: ['SHIP.md', 'VERSION', 'CHANGELOG.md', 'LICENSE'], edit: ['calc.py', 'test_calc.py'] },
      deny: [], ideation: { enabled: false },
    })
    expect(spec.suiteBaseline).toBe(`${heldout}/suite_baseline_${head.slice(0, 7)}.txt`)
    // Every graded line is claimed by exactly one work item (loadCampaignSpec
    // already refuses a duplicate), and nothing else is. FULL ids: the brief
    // (cynco-brief.mjs) picks work items by exact membership in the failing set.
    expect(spec.work.flatMap(w => w.gateIds).sort()).toEqual(FULL_IDS)
  })

  // Review I3: a mechanical proof of the driver's retry loop — the first call
  // FAILS on purpose, every later one PASSES — written under the temp home,
  // never under heldout, and re-armed (stamp removed) by every --write.
  it('writes the fails-once marker check under <home>/smoke, never under heldout, and re-arms it on every write', () => {
    const script = `${home}/smoke/${MARKER_CHECK_ONCE}`
    const stamp = `${home}/smoke/${MARKER_CHECK_STAMP}`
    expect(readFileSync(script, 'utf8')).toBe(MARKER_CHECK_ONCE_PY)
    expect(script).not.toMatch(/heldout/)
    expect(existsSync(stamp)).toBe(false)
    const first = spawnSync('python', [script], { encoding: 'utf8' })
    expect(first.status).toBe(1)
    expect(first.stdout).toContain('marker-check-once: first call fails on purpose')
    expect(existsSync(stamp)).toBe(true)
    for (let i = 0; i < 2; i++) {
      const later = spawnSync('python', [script], { encoding: 'utf8' })
      expect(later.status).toBe(0)
      expect(later.stdout).toContain('marker-check-once: a later call passes')
    }
    writeSmokeCampaign({ home, repo, base: SMOKE_BASE })
    expect(existsSync(stamp)).toBe(false)
    expect(spawnSync('python', [script], { encoding: 'utf8' }).status).toBe(1)
    rmSync(stamp, { force: true })
  })

  it('passes loadCampaignSpec and checkIdentity (instruments sealed, base a real commit, no leak)', () => {
    const id = checkIdentity(spec)
    expect(id.problems).toEqual([])
    expect(id.ok).toBe(true)
  })

  it('calibrates with the real python: BASE misses all 8 by absence, the stub flips only S1.7, the positive shim PASSes', async () => {
    const baseDir = join(mkdtempSync(join(tmpdir(), 's1-base-')), 'base').replace(/\\/g, '/')
    const arch = archiveBase(repo, spec.base, baseDir)
    expect(arch.problems).toEqual([])
    const r = await calibrate(spec, undefined, { baseDir })
    expect(r.harnessFault).toBe(false)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)

    const base = parseGateOutput(r.baseOutputTail)
    expect(base.terminator).toBe('MISS')
    expect(base.failCount).toBe(8)
    expect(base.errors).toEqual([])
    expect(r.baseFails.map(f => short(f.id))).toEqual(GRADED)
    // Absence, not breakage: every BASE fail names what is missing.
    for (const f of r.baseFails) expect(f.line, f.id).toMatch(/absent|no test_docstring|no valid VERSION/)
    expect(r.basePasses.map(p => p.id)).toEqual(['S1.9'])

    const pert = parseGateOutput(r.perturbOutputTail)
    expect(pert.errors).toEqual([])
    expect(r.perturbFails.map(f => short(f.id))).toEqual(GRADED.filter(id => id !== 'S1.7'))

    expect(r.positive.terminator).toBe('PASS')
    expect(r.positive.errors).toEqual([])
    expect(r.positive.fails).toEqual([])

    // Neither shim wrote into the BASE it was handed.
    for (const f of ['SHIP.md', 'VERSION', 'CHANGELOG.md', 'LICENSE']) expect(existsSync(join(baseDir, f)), f).toBe(false)
    expect(readFileSync(join(baseDir, 'calc.py'), 'utf8')).not.toContain('__main__')
  }, 180_000)

  it('rewrites campaigns/s1 fresh on a second write', () => {
    const h = tempHome()
    writeSmokeCampaign({ home: h, repo, base: SMOKE_BASE })
    writeFileSync(join(h, 'campaigns', SMOKE_ID, 'state.json'), '{}')
    writeSmokeCampaign({ home: h, repo, base: SMOKE_BASE })
    expect(readdirSync(join(h, 'campaigns', SMOKE_ID))).toEqual([])
  })

  it('refuses a home that would fail checkIdentity, and the real ~/.cynco', () => {
    const notCynco = mkdtempSync(join(tmpdir(), 's1-plain-')).replace(/\\/g, '/')
    expect(() => writeSmokeCampaign({ home: notCynco, repo, base: SMOKE_BASE })).toThrow(/must end in \/\.cynco/)
    expect(() => writeSmokeCampaign({ home: join(homedir(), '.cynco'), repo, base: SMOKE_BASE })).toThrow(/refusing to write into the real/)
    expect(() => writeSmokeCampaign({ home: tempHome(), repo: join(tmpdir(), 'no-such-repo-s1'), base: SMOKE_BASE })).toThrow(/rev-parse/)
  })

})

// F163 / final review T7-M1: the real git read of HEAD against --base. Phase 6
// fix wave (P-SMOKE): these build their OWN throwaway repo — one commit as the
// base, a second on top — so they never depend on where C:/tmp/phase2-smoke's
// HEAD happens to be (a live smoke moves it; a reset puts it back).
describe('smoke campaign --base against a real repo HEAD (F163, T7-M1; own throwaway repo)', () => {
  let root, moved, at, base, head
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 's1-headcheck-'))
    moved = join(root, 'moved').replace(/\\/g, '/')
    mkdirSync(moved)
    const run = (args, cwd) => { const r = git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], cwd); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
    run(['init', '-q'], moved)
    writeFileSync(join(moved, 'calc.py'), 'X = 1\n')
    run(['add', 'calc.py'], moved); run(['commit', '-q', '-m', 'base'], moved)
    base = run(['rev-parse', 'HEAD'], moved)
    writeFileSync(join(moved, 'SHIP.md'), 'shipped\n')
    run(['add', 'SHIP.md'], moved); run(['commit', '-q', '-m', 'wave'], moved)
    head = run(['rev-parse', 'HEAD'], moved)
    // A second checkout whose HEAD IS the base.
    at = join(root, 'at').replace(/\\/g, '/')
    run(['clone', '--quiet', moved, at], root)
    run(['checkout', '--quiet', '--detach', base], at)
  })
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('refuses when the repo HEAD is not --base, naming both shas, and writes nothing', () => {
    expect(head).not.toBe(base)
    const h = tempHome()
    expect(() => writeSmokeCampaign({ home: h, repo: moved, base })).toThrow(`repo HEAD ${head} is not --base ${base}`)
    expect(existsSync(h)).toBe(false)
    // An abbreviated --base that names HEAD's own commit is the same commit.
    const spec = JSON.parse(readFileSync(writeSmokeCampaign({ home: tempHome(), repo: at, base: base.slice(0, 7) }), 'utf8'))
    expect(spec.base).toBe(base)
  })

  it('CLI: --write --repo --base --home prints the spec path; without --base, or off HEAD, it refuses', () => {
    const h = tempHome()
    const r = spawnSync('bun', ['scripts/cynco-smoke-campaign.mjs', '--write', '--repo', at, '--base', base, '--home', h], { cwd: ROOT, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`${h}/smoke/s1.campaign.json`)
    expect(existsSync(r.stdout.trim())).toBe(true)
    const noBase = spawnSync('bun', ['scripts/cynco-smoke-campaign.mjs', '--write', '--repo', at, '--home', tempHome()], { cwd: ROOT, encoding: 'utf8' })
    expect(noBase.status).toBe(1)
    expect(noBase.stderr).toMatch(/no base — pass --base <sha>/)
    const off = spawnSync('bun', ['scripts/cynco-smoke-campaign.mjs', '--write', '--repo', moved, '--base', base, '--home', tempHome()], { cwd: ROOT, encoding: 'utf8' })
    expect(off.status).toBe(1)
    expect(off.stderr).toMatch(new RegExp(`repo HEAD ${head} is not --base ${base}`))
  }, 60_000)
})

// No smoke repo needed: the seam stands in for git.
describe('smoke campaign --base is required and must be the repo HEAD (F163, T7-M1)', () => {
  const base = 'b'.repeat(40)
  it('no base is refused before anything is written', () => {
    const h = tempHome()
    expect(() => writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', commit: () => base })).toThrow(/no base — pass --base <sha>/)
    expect(existsSync(h)).toBe(false)
  })
  it('HEAD elsewhere is refused naming both shas (and the resolved base when it was abbreviated)', () => {
    const h = tempHome()
    const commit = (repo, rev) => (rev === 'HEAD' ? 'c'.repeat(40) : base)
    expect(() => writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base: 'bbbbbbb', commit }))
      .toThrow(`repo HEAD ${'c'.repeat(40)} is not --base bbbbbbb (${base})`)
    expect(existsSync(h)).toBe(false)
  })
})

// The wave grader reads the suite gate from <CYNCO_HOME>/heldout/common; a
// fresh temp home has none. `--common-from` stages that one file. No smoke
// repo needed: the `commit` seam stands in for git.
describe('smoke campaign --common-from', () => {
  const base = 'a'.repeat(40)
  it('copies g_suite_no_regression.py into <home>/heldout/common, and only that file', () => {
    const src = mkdtempSync(join(tmpdir(), 's1-common-')).replace(/\\/g, '/')
    writeFileSync(join(src, 'g_suite_no_regression.py'), 'print("suite")\n')
    writeFileSync(join(src, 'suite_baseline.txt'), 'not copied\n')
    const h = tempHome()
    writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base, commit: () => base, commonFrom: src })
    expect(readdirSync(join(h, 'heldout', 'common'))).toEqual(['g_suite_no_regression.py'])
    expect(readFileSync(join(h, 'heldout', 'common', 'g_suite_no_regression.py'), 'utf8')).toBe('print("suite")\n')
  })

  it('refuses a --common-from dir without the suite gate, and stages nothing without the flag', () => {
    const empty = mkdtempSync(join(tmpdir(), 's1-common-empty-'))
    expect(() => writeSmokeCampaign({ home: tempHome(), repo: 'C:/tmp/any-repo', base, commit: () => base, commonFrom: empty })).toThrow(/does not exist/)
    const h = tempHome()
    writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base, commit: () => base })
    expect(existsSync(join(h, 'heldout', 'common'))).toBe(false)
  })
})

// F161: an engine under a temp CYNCO_HOME has no llama-server, no GGUF and no
// profile — it reached for GitHub and the live proof's dispatch died. The
// generator points the temp home at the real assets BY PATH (the two engine
// overrides, carried on the spec as `env`) and copies the small profiles.
// Never a junction: the real models dir must never sit under a tree that
// gets removed.
describe('smoke campaign --runtime-from (F161)', () => {
  const base = 'a'.repeat(40)
  const fakeRuntime = ({ brain = true, model = 'qwen3.8-27b-nvfp4', file = 'Q.gguf', profile = null } = {}) => {
    const r = mkdtempSync(join(tmpdir(), 's1-runtime-')).replace(/\\/g, '/')
    mkdirSync(join(r, brain ? 'bin-brain' : 'bin'), { recursive: true })
    writeFileSync(join(r, brain ? 'bin-brain' : 'bin', 'llama-server.exe'), 'MZ')
    mkdirSync(join(r, 'models', model), { recursive: true })
    writeFileSync(join(r, 'models', model, file), 'GGUF')
    mkdirSync(join(r, 'profiles'), { recursive: true })
    writeFileSync(join(r, 'profiles', 'default.yaml'), profile ?? `name: default\nmodel: ${model}\nmodel_file: ${file} # the file\ncontext_length: 131072\n`)
    writeFileSync(join(r, 'profiles', 'other.yaml'), 'name: other\nmodel: x\n')
    writeFileSync(join(r, 'profiles', 'notes.txt'), 'not a profile\n')
    return r
  }

  it('names the brain build over the stock one and the profile\'s GGUF, as the engine\'s two explicit-path overrides', () => {
    const r = fakeRuntime()
    expect(runtimeEnvFrom(r)).toEqual({ LOCALCODE_LLAMA_SERVER: `${r}/bin-brain/llama-server.exe`, LOCALCODE_MODEL_PATH: `${r}/models/qwen3.8-27b-nvfp4/Q.gguf` })
    const stock = fakeRuntime({ brain: false })
    expect(runtimeEnvFrom(stock).LOCALCODE_LLAMA_SERVER).toBe(`${stock}/bin/llama-server.exe`)
  })

  it('strips an Ollama-style tag from model: and refuses a runtime without a binary, a profile, the model keys, or the GGUF', () => {
    const tagged = fakeRuntime({ model: 'qwen3.8', profile: 'model: qwen3.8:latest\nmodel_file: Q.gguf\n' })
    expect(runtimeEnvFrom(tagged).LOCALCODE_MODEL_PATH).toBe(`${tagged}/models/qwen3.8/Q.gguf`)
    const noBin = mkdtempSync(join(tmpdir(), 's1-runtime-nobin-'))
    expect(() => runtimeEnvFrom(noBin)).toThrow(/no llama-server/)
    const noProfile = fakeRuntime(); rmSync(join(noProfile, 'profiles'), { recursive: true })
    expect(() => runtimeEnvFrom(noProfile)).toThrow(/default\.yaml does not exist/)
    expect(() => runtimeEnvFrom(fakeRuntime({ profile: 'name: default\n' }))).toThrow(/lacks model/)
    expect(() => runtimeEnvFrom(fakeRuntime({ profile: 'model: qwen3.8-27b-nvfp4\nmodel_file: missing.gguf\n' }))).toThrow(/missing\.gguf does not exist/)
  })

  it('writes the env onto the spec, copies only the yaml profiles, and the spec still loads', () => {
    const r = fakeRuntime()
    const h = tempHome()
    const specPath = writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base, commit: () => base, runtimeFrom: r })
    const spec = JSON.parse(readFileSync(specPath, 'utf8'))
    expect(spec.env).toEqual({ LOCALCODE_LLAMA_SERVER: `${r}/bin-brain/llama-server.exe`, LOCALCODE_MODEL_PATH: `${r}/models/qwen3.8-27b-nvfp4/Q.gguf` })
    expect(readdirSync(join(h, 'profiles')).sort()).toEqual(['default.yaml', 'other.yaml'])
    expect(loadCampaignSpec(specPath).env).toEqual(spec.env)
    expect(existsSync(join(h, 'models'))).toBe(false)
    expect(existsSync(join(h, 'bin'))).toBe(false)
    const plain = JSON.parse(readFileSync(writeSmokeCampaign({ home: tempHome(), repo: 'C:/tmp/any-repo', base, commit: () => base }), 'utf8'))
    expect(plain.env).toBeUndefined()
  })
})
