// scripts/cynco-smoke-campaign.mjs
// The smoke campaign (Phase 4 Task 6): a real, one-wave campaign against the
// tiny calc repo (C:/tmp/phase2-smoke) for the live autopoiesis proof. It lays
// out a temp CYNCO_HOME exactly as the runner expects it — the sealed triple
// under heldout/, a fresh campaigns/s1/, the spec under smoke/ — and prints the
// spec path. It does NOT archive the BASE: the runner does that at CALIBRATE.
//
//   CYNCO_HOME=C:/tmp/cynco-home-s1/.cynco \
//     bun scripts/cynco-smoke-campaign.mjs --write --repo C:/tmp/phase2-smoke --base <sha> [--home <dir>] \
//       [--common-from ~/.cynco/heldout/common]
//
// The wave grader runs `<CYNCO_HOME>/heldout/common/g_suite_no_regression.py`
// (SUITE_GATE in cynco-campaign-grade.mjs). A fresh temp home has none, so the
// grade would fault. `--common-from <dir>` copies that one script from `<dir>`
// (normally the real ~/.cynco/heldout/common — READ only) into the temp home;
// without it, stage the copy by hand before the run.
//
// The home MUST end in `/.cynco`: checkIdentity seals instruments by the path
// shape `/.cynco/heldout/`, and `heldoutDirFor` puts them at
// `<home>/heldout/...`. So the caller passes `C:/tmp/cynco-home-s1/.cynco` as
// CYNCO_HOME (not `C:/tmp/cynco-home-s1`), and the runner, the engine and this
// generator then all agree on one directory.
//
// The marker check (Phase 7 ruling 3, review I3) is a MECHANICAL PROOF of the
// driver's retry loop, not a measurement of the work. The spec's markerCheck is
// `<home>/smoke/marker_check_once.py`, written here (under the temp home, never
// under heldout): the driver's first check FAILS on purpose (`marker-check-once:
// first call fails on purpose`) and leaves a stamp beside itself; every later
// call PASSES. `markerRetryMinS: 60` lets the one-hour wave reach the retry, so
// one smoke run walks FAIL → note → second turn → PASS end to end. The sealed
// gate and the suite gate still grade the work, after the driver, as always.
//
// Final review I1: the marker check reaches the driver on its own channel
// (CYNCO_MARKER_CHECK), never as the engine's contract assertion — the
// check-cmd stays `keepGreen` — and the fixture fails only for
// CYNCO_CHECK_ORDINAL=1, which only the driver sets, so nothing else (the
// model's ContractAssertPass, a stray run) can spend the stamp.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUITE_GATE_FILE } from './cynco-campaign-grade.mjs'
import { runSync, faultSummary } from './cynco-spawn.mjs'
import { WORKER_INVARIANTS, heldoutDirFor } from './cynco-gate-author.mjs'

export const SMOKE_ID = 's1'
const FIXTURES = fileURLToPath(new URL('./__tests__/fixtures/gates/smoke/', import.meta.url))
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')

const MEASURES = `HOW THE BAR MEASURES — build to these definitions exactly

  The bar reads the files of the repo at your commit; nothing is imported or
  run except the parsing of calc.py and test_calc.py.

  S1.1 SHIP NOTES. SHIP.md exists with at least 3 non-empty lines.
  S1.2 VERSION FILE. VERSION exists and, stripped, is MAJOR.MINOR.PATCH
       (three dot-separated integers, e.g. 0.1.0 — nothing else in the file).
  S1.3 CHANGELOG. CHANGELOG.md exists and contains the exact VERSION string.
  S1.4 LICENSE. LICENSE exists with at least 10 lines (a real licence text).
  S1.5 MODULE DOCSTRING. calc.py opens with a module docstring: a string
       literal as the first statement of the file (a function docstring does
       not count — total() already has one).
  S1.6 A TEST FOR THE DOCSTRING. test_calc.py defines a test function whose name
       starts with test_docstring, and it checks that total() is documented.
  S1.7 MAIN GUARD. calc.py contains the line  if __name__ == "__main__":
  S1.8 SHIP NOTES NAME THE VERSION. SHIP.md contains the exact VERSION string.

  Every line is graded independently; the existing tests in test_calc.py must
  stay green.
`

/** The marker-check fixture's file name, written under `<home>/smoke/`. */
export const MARKER_CHECK_ONCE = 'marker_check_once.py'
/** Its stamp, beside it: present = the first call has happened. */
export const MARKER_CHECK_STAMP = 'marker_check_once.stamp'

/**
 * The fixture: FAILS on the driver's first check (CYNCO_CHECK_ORDINAL=1, no
 * stamp yet — and writes the stamp), PASSES on every other call, including any
 * call without the ordinal. A mechanical proof of the driver's retry loop — see
 * the header.
 */
export const MARKER_CHECK_ONCE_PY = `# marker_check_once.py — the s1 smoke's marker check (Phase 7 ruling 3).
# A MECHANICAL proof of the driver's marker-check retry loop, not a
# measurement of the work: the driver's first check fails on purpose and
# leaves a stamp beside this file; every later call passes. Two locks keep the
# failure the driver's: the stamp (spent once), and CYNCO_CHECK_ORDINAL, which
# only the driver sets — a call without it (anyone else's) passes and leaves
# the stamp alone, and only ordinal 1 can fail. Written by
# scripts/cynco-smoke-campaign.mjs; the stamp is removed on every --write.
import os
import sys

ordinal = os.environ.get("CYNCO_CHECK_ORDINAL")
if ordinal is None:
    print("marker-check-once: not the driver (no CYNCO_CHECK_ORDINAL) — passes, the stamp is left alone")
    sys.exit(0)
stamp = os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(MARKER_CHECK_STAMP)})
if ordinal == "1" and not os.path.exists(stamp):
    with open(stamp, "w", encoding="utf-8") as f:
        f.write("first call made\\n")
    print("marker-check-once: first call fails on purpose")
    sys.exit(1)
print("marker-check-once: a later call passes")
sys.exit(0)
`

/** The campaign spec for `repo` at `base`, with its instruments under `heldout` and the smoke's own files under `smokeDir`. */
export function smokeSpec({ repo, base, heldout, smokeDir }) {
  return {
    id: SMOKE_ID,
    title: 'smoke: ship calc 0.1.0',
    repo,
    base,
    gate: `${heldout}/gate_${SMOKE_ID}.py`,
    perturb: `${heldout}/perturb_${SMOKE_ID}.py`,
    positive: `${heldout}/positive_${SMOKE_ID}.py`,
    suiteBaseline: `${heldout}/suite_baseline_${base.slice(0, 7)}.txt`,
    marker: 'smoke s1 complete',
    keepGreen: 'python -m pytest -q test_calc.py',
    // Phase 7 ruling 3 / review I3: the marker check defaults to the suite
    // gate; the smoke names its own fixture — fails once, then passes — and
    // lowers the retry floor so its one-hour wave can reach the retry at all.
    markerCheck: `python ${smokeDir}/${MARKER_CHECK_ONCE}`,
    markerRetryMinS: 60,
    budget: { hoursPerWave: 1, iterations: 300, bashTimeoutMs: 600000, waves: 1 },
    // The smoke gate runs in seconds (calc.py is tiny), so the mid-wave
    // progress probe (Phase 6 Task 3) reads every 20 s here — the runner's
    // 30 min default would never fire inside this wave's 1 h clock.
    progress: { everyMs: 20_000 },
    invariants: { ...WORKER_INVARIANTS },
    posiwid: { sourceEditShare: 0.3, commitEvery: 60 },
    sweep: { max: 2 },
    prBase: 'main',
    allow: { newFiles: ['SHIP.md', 'VERSION', 'CHANGELOG.md', 'LICENSE'], edit: ['calc.py', 'test_calc.py'] },
    deny: [],
    measures: MEASURES,
    work: [
      {
        id: 'ship-files',
        title: 'SHIP FILES',
        gateIds: ['S1.1.ship-notes', 'S1.2.version-file', 'S1.3.changelog', 'S1.4.license', 'S1.8.ship-mentions-version'],
        text: 'Write VERSION (0.1.0), SHIP.md (at least 3 lines, naming the version),\n'
          + '   CHANGELOG.md (an entry for the version) and LICENSE (a full licence text,\n'
          + '   at least 10 lines). Commit after each file.',
      },
      {
        id: 'code-hygiene',
        title: 'CODE HYGIENE',
        gateIds: ['S1.5.module-docstring', 'S1.6.tests-cover-total-docstring', 'S1.7.main-guard'],
        text: 'Give calc.py a module docstring and a main guard, and add a\n'
          + '   test_docstring_* test to test_calc.py asserting total() is documented;\n'
          + '   python -m pytest -q test_calc.py stays green.',
      },
    ],
    rules: [],
    ideation: { enabled: false },
    author: 'human',
  }
}

/** `rev` (HEAD, a sha, an abbreviation) in `repo` as its full commit sha; throws naming the failure. */
export function commitOf(repo, rev) {
  const r = runSync('git', ['-C', repo, 'rev-parse', '--verify', `${rev}^{commit}`], { cwd: process.cwd(), env: {}, timeoutMs: 60_000, retryImpossibleTimeout: true })
  if (r.fault) throw new Error(`git -C ${repo} rev-parse ${rev} did not run (${faultSummary(r.fault)})`)
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(String(r.stdout).trim())) {
    throw new Error(`git -C ${repo} rev-parse ${rev} failed: ${String(r.stderr).trim() || String(r.stdout).trim()}`)
  }
  return String(r.stdout).trim()
}

/**
 * Lay out the smoke campaign in `home` (a CYNCO_HOME) and return the spec path.
 * Writes ONLY under `home`, and refuses the real `~/.cynco` — the smoke run must
 * never share state with a live campaign.
 *
 * `base` is REQUIRED and the repo's HEAD must BE it (F163, final review T7-M1):
 * the runner calibrates at `spec.base` while the dispatch starts the mission
 * from the repo's HEAD, and a reused smoke repo whose HEAD already carried the
 * shipped work PASSed a wave that fixed nothing. The generator refuses, naming
 * both shas, instead of writing a spec the runner would then refuse to
 * dispatch. `commit` is the test seam (`commitOf`).
 */
// One spelling of the suite gate's filename: the grader's (cynco-campaign-grade.mjs).
export { SUITE_GATE_FILE }

/**
 * F161. The engine resolves its llama-server (`<home>/bin-brain`, `<home>/bin`),
 * its GGUF (`<home>/models/<model>/<model_file>`) and its profiles under
 * `cyncoHome()`, so an engine dispatched under a temp home finds none of them
 * and reaches for GitHub — the live proof's first dispatch died there. The
 * assets are not state: the temp home must point at the real ones, by path,
 * never by junction (a junction under a tree someone later `rm -rf`s deletes
 * the real models). The two env keys below are the engine's explicit-path
 * overrides (`engine/config.ts`), and the campaign spec carries them as `env`
 * so the runner's dispatch hands them to the engine.
 *
 * The model is read off `<runtimeFrom>/profiles/default.yaml` — the profile
 * the engine boots with — from its `model:` and `model_file:` keys.
 */
export function runtimeEnvFrom(runtimeFrom, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const r = norm(resolve(runtimeFrom))
  const binary = ['bin-brain/llama-server.exe', 'bin/llama-server.exe', 'bin-brain/llama-server', 'bin/llama-server'].map(p => `${r}/${p}`).find(exists)
  if (!binary) throw new Error(`--runtime-from: no llama-server under ${r}/bin-brain or ${r}/bin`)
  const profile = `${r}/profiles/default.yaml`
  if (!exists(profile)) throw new Error(`--runtime-from: ${profile} does not exist — the model is read off its model:/model_file: keys`)
  const yaml = read(profile)
  const key = (k) => { const m = new RegExp(`^${k}:[ \\t]*([^\\n#]+)`, 'm').exec(yaml); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null }
  const model = key('model')
  const modelFile = key('model_file')
  if (!model || !modelFile) throw new Error(`--runtime-from: ${profile} lacks model: or model_file:`)
  const modelPath = `${r}/models/${model.split(':')[0]}/${modelFile}`
  if (!exists(modelPath)) throw new Error(`--runtime-from: ${modelPath} does not exist`)
  return { LOCALCODE_LLAMA_SERVER: binary, LOCALCODE_MODEL_PATH: modelPath }
}

export function writeSmokeCampaign({ home, repo, base, commonFrom, runtimeFrom, commit = commitOf } = {}) {
  if (!home) throw new Error('writeSmokeCampaign: no home — pass --home or set CYNCO_HOME')
  if (!repo) throw new Error('writeSmokeCampaign: no repo — pass --repo')
  if (!base) throw new Error('writeSmokeCampaign: no base — pass --base <sha>, the commit the fixture is calibrated at; the repo\'s HEAD must be it (F163)')
  const h = norm(resolve(home))
  if (h.toLowerCase() === norm(resolve(homedir(), '.cynco')).toLowerCase()) {
    throw new Error(`refusing to write into the real ${h} — point CYNCO_HOME at a temp dir ending in /.cynco`)
  }
  if (!/\/\.cynco$/.test(h)) {
    throw new Error(`home ${h} must end in /.cynco — checkIdentity seals instruments by the /.cynco/heldout/ path shape (e.g. C:/tmp/cynco-home-s1/.cynco)`)
  }
  const r = norm(resolve(repo))
  const sha = commit(r, base)
  const head = commit(r, 'HEAD')
  if (head !== sha) {
    throw new Error(`repo HEAD ${head} is not --base ${base}${sha !== base ? ` (${sha})` : ''} — calibration and dispatch must look at one commit (Rule 11, F163): `
      + `git -C ${r} checkout --detach ${base} (a throwaway checkout), then write the campaign`)
  }

  const heldout = heldoutDirFor(SMOKE_ID, h)
  mkdirSync(heldout, { recursive: true })
  for (const f of [`gate_${SMOKE_ID}.py`, `perturb_${SMOKE_ID}.py`, `positive_${SMOKE_ID}.py`]) copyFileSync(`${FIXTURES}${f}`, `${heldout}/${f}`)

  if (commonFrom) {
    const src = `${norm(resolve(commonFrom))}/${SUITE_GATE_FILE}`
    if (!existsSync(src)) throw new Error(`--common-from: ${src} does not exist — the wave grader needs the suite gate`)
    mkdirSync(`${h}/heldout/common`, { recursive: true })
    copyFileSync(src, `${h}/heldout/common/${SUITE_GATE_FILE}`)
  }

  let env = null
  if (runtimeFrom) {
    env = runtimeEnvFrom(runtimeFrom)
    // The profiles are small yaml and the engine boots from `default.yaml`
    // (context length, sampler, template): copied, so the smoke engine runs
    // the operator's profile and not the bundled fallback.
    const profiles = `${norm(resolve(runtimeFrom))}/profiles`
    mkdirSync(`${h}/profiles`, { recursive: true })
    for (const f of readdirSync(profiles).filter(n => n.endsWith('.yaml'))) copyFileSync(`${profiles}/${f}`, `${h}/profiles/${f}`)
  }

  const campaignDir = `${h}/campaigns/${SMOKE_ID}`
  rmSync(campaignDir, { recursive: true, force: true })
  mkdirSync(campaignDir, { recursive: true })

  const smokeDir = `${h}/smoke`
  mkdirSync(smokeDir, { recursive: true })
  writeFileSync(`${smokeDir}/${MARKER_CHECK_ONCE}`, MARKER_CHECK_ONCE_PY, 'utf8')
  // A stamp from an earlier run would make the first call pass and the retry
  // loop go unexercised.
  rmSync(`${smokeDir}/${MARKER_CHECK_STAMP}`, { force: true })
  const specPath = `${smokeDir}/${SMOKE_ID}.campaign.json`
  const spec = smokeSpec({ repo: r, base: sha, heldout, smokeDir })
  if (env) spec.env = env
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8')
  return specPath
}

function parseArgs(argv) {
  const out = { write: false, repo: null, home: process.env.CYNCO_HOME || null, commonFrom: null, runtimeFrom: null, base: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') out.write = true
    else if (a === '--common-from') out.commonFrom = argv[++i]
    else if (a === '--runtime-from') out.runtimeFrom = argv[++i]
    // The BASE the fixture was calibrated against — REQUIRED, and the repo's
    // HEAD must be it (F163): a repo that has already shipped one wave passes
    // every line at HEAD, and a mission dispatched from there fixes nothing.
    else if (a === '--base') { out.base = argv[++i]; if (!out.base || out.base.startsWith('--')) throw new Error('--base needs a commit sha') }
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--home') out.home = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args.write) throw new Error('usage: bun scripts/cynco-smoke-campaign.mjs --write --repo <path> --base <sha; the repo HEAD must be it> [--home <dir ending in /.cynco>] [--common-from <dir holding g_suite_no_regression.py>] [--runtime-from <real ~/.cynco: llama-server, models, profiles>]')
    console.log(writeSmokeCampaign({ home: args.home, repo: args.repo, base: args.base, commonFrom: args.commonFrom, runtimeFrom: args.runtimeFrom }))
  } catch (e) {
    console.error(`[smoke] ${e.message}`)
    process.exit(1)
  }
}
