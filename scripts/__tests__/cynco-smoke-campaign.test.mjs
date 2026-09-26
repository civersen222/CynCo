// The smoke campaign fixture (Phase 4 Task 6): a real one-wave campaign for the
// live proof. These tests run the REAL python against a temp clone of the
// smoke repo — the triple has to be genuinely runnable, not a stand-in — and
// never touch C:/tmp/phase2-smoke itself or the live ~/.cynco.
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeSmokeCampaign, runtimeEnvFrom, SMOKE_ID } from '../cynco-smoke-campaign.mjs'
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
      gate: `${heldout}/gate_s1.py`, perturb: `${heldout}/perturb_s1.py`, positive: `${heldout}/positive_s1.py`,
      budget: { hoursPerWave: 1, iterations: 300, bashTimeoutMs: 600000, waves: 1 },
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
    writeSmokeCampaign({ home: h, repo })
    writeFileSync(join(h, 'campaigns', SMOKE_ID, 'state.json'), '{}')
    writeSmokeCampaign({ home: h, repo })
    expect(readdirSync(join(h, 'campaigns', SMOKE_ID))).toEqual([])
  })

  it('refuses a home that would fail checkIdentity, and the real ~/.cynco', () => {
    const notCynco = mkdtempSync(join(tmpdir(), 's1-plain-')).replace(/\\/g, '/')
    expect(() => writeSmokeCampaign({ home: notCynco, repo })).toThrow(/must end in \/\.cynco/)
    expect(() => writeSmokeCampaign({ home: join(homedir(), '.cynco'), repo })).toThrow(/refusing to write into the real/)
    expect(() => writeSmokeCampaign({ home: tempHome(), repo: join(tmpdir(), 'no-such-repo-s1') })).toThrow(/rev-parse/)
  })

  it('CLI: --write --repo --home prints the spec path', () => {
    const h = tempHome()
    const r = spawnSync('bun', ['scripts/cynco-smoke-campaign.mjs', '--write', '--repo', repo, '--home', h], { cwd: ROOT, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`${h}/smoke/s1.campaign.json`)
    expect(existsSync(r.stdout.trim())).toBe(true)
  }, 60_000)
})

// The wave grader reads the suite gate from <CYNCO_HOME>/heldout/common; a
// fresh temp home has none. `--common-from` stages that one file. No smoke
// repo needed: an explicit base skips the rev-parse.
describe('smoke campaign --common-from', () => {
  const base = 'a'.repeat(40)
  it('copies g_suite_no_regression.py into <home>/heldout/common, and only that file', () => {
    const src = mkdtempSync(join(tmpdir(), 's1-common-')).replace(/\\/g, '/')
    writeFileSync(join(src, 'g_suite_no_regression.py'), 'print("suite")\n')
    writeFileSync(join(src, 'suite_baseline.txt'), 'not copied\n')
    const h = tempHome()
    writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base, commonFrom: src })
    expect(readdirSync(join(h, 'heldout', 'common'))).toEqual(['g_suite_no_regression.py'])
    expect(readFileSync(join(h, 'heldout', 'common', 'g_suite_no_regression.py'), 'utf8')).toBe('print("suite")\n')
  })

  it('refuses a --common-from dir without the suite gate, and stages nothing without the flag', () => {
    const empty = mkdtempSync(join(tmpdir(), 's1-common-empty-'))
    expect(() => writeSmokeCampaign({ home: tempHome(), repo: 'C:/tmp/any-repo', base, commonFrom: empty })).toThrow(/does not exist/)
    const h = tempHome()
    writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base })
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
    const specPath = writeSmokeCampaign({ home: h, repo: 'C:/tmp/any-repo', base, runtimeFrom: r })
    const spec = JSON.parse(readFileSync(specPath, 'utf8'))
    expect(spec.env).toEqual({ LOCALCODE_LLAMA_SERVER: `${r}/bin-brain/llama-server.exe`, LOCALCODE_MODEL_PATH: `${r}/models/qwen3.8-27b-nvfp4/Q.gguf` })
    expect(readdirSync(join(h, 'profiles')).sort()).toEqual(['default.yaml', 'other.yaml'])
    expect(loadCampaignSpec(specPath).env).toEqual(spec.env)
    expect(existsSync(join(h, 'models'))).toBe(false)
    expect(existsSync(join(h, 'bin'))).toBe(false)
    const plain = JSON.parse(readFileSync(writeSmokeCampaign({ home: tempHome(), repo: 'C:/tmp/any-repo', base }), 'utf8'))
    expect(plain.env).toBeUndefined()
  })
})
