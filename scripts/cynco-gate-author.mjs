// scripts/cynco-gate-author.mjs — the SECOND occupant of the supervisor seat.
//
//   bun scripts/cynco-gate-author.mjs --check <stagingDir> <baseDir>
//   bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c9.campaign.json --author c9
//   bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c9.campaign.json --approve-proposal gate/c9
//
// Today a human reads the roadmap line, audits the game at BASE, writes the
// gate triple by hand, calibrates it by hand and opens the campaign. This
// module is the machine half of that: `--author <id>` dispatches a
// fresh-context CynCo mission whose ONLY order is "write a gate triple plus a
// campaign draft that makes `--check` exit 0", `--check` is that mechanical
// acceptance test, a passing check raises the proposal `gate/<id>`, and
// `--approve-proposal gate/<id>` seals it.
//
// It deliberately does NOT import scripts/cynco-campaign.mjs. The runner
// imports this module (from inside its verb branches, lazily), so an import
// back would be an ESM cycle; everything this module needs from the runner —
// dispatch, the driver wait, the ledger read, the campaign lock, the env
// scrubber, the campaign-log append — arrives through the `io` argument, and
// `defaultAuthorIo` builds that io from helpers the runner hands over.
import { basename, join, dirname, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { cyncoHome } from '../engine/paths.js'
import { calibrate, archiveBase, defaultIo as calibrateDefaultIo } from './cynco-campaign-calibrate.mjs'
import { lintGate } from './cynco-gate-lint.mjs'
import { parseGateOutput } from './cynco-gate-parse.mjs'
import { loadCampaignSpec, checkIdentity } from './cynco-campaign-spec.mjs'
import { sidecarPath } from './cynco-contract.mjs'
import { loadRoadmap, lineFor, setLineStatus, saveRoadmap, ROADMAP_PATH } from './cynco-roadmap.mjs'
import { CampaignState } from './cynco-campaign-state.mjs'

// 4 h and 1200 iterations: the authoring mission writes four files and runs a
// check that costs two gate runs, so it is sized well below a wave's 8 h/2000.
export const AUTHOR_TIMEOUT_S = 14400
export const AUTHOR_ITERATIONS = 1200
// Spec ruling 2: what 0.5 buys is sealing without waiting for the supervisor's
// approval. 1.0 is never granted — the human keeps the binding seat.
export const GATE_AUTHOR_MAX_AUTHORITY = 0.5
export const AUTHOR_INVARIANTS = { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true }

const CIVKINGS_REPO = 'C:/Users/civer/civkings'
const HELDOUT_FAMILY = 'civkings-redesign'
const BRIEFS_DIR = 'docs/civkings-redesign-briefs'
// Runner-owned spec fields (spec §2c). The author never picks these: a gate
// author that chose its own wave budget or its own invariants would be
// choosing how hard the campaign it is grading may push.
const RUNNER_BUDGET = { hoursPerWave: 8, iterations: 2000, bashTimeoutMs: 1500000, waves: 8 }
const RUNNER_POSIWID = { sourceEditShare: 0.3, commitEvery: 60 }
const RUNNER_SWEEP = { max: 6 }

const norm = (p) => String(p).replace(/\\/g, '/')

/** `~/.cynco/authoring/<id>` — outside the repo and outside the sealed tree. */
export function stagingDirFor(id, home = cyncoHome()) {
  return `${norm(home)}/authoring/${id}`
}

/** `~/.cynco/heldout/civkings-redesign/<id>` — where the seal puts the triple. */
export function heldoutDirFor(id, home = cyncoHome()) {
  return `${norm(home)}/heldout/${HELDOUT_FAMILY}/${id}`
}

/** The read-only `git archive` of the roadmap line's BASE. */
export function baseDirFor(id) {
  return `C:/tmp/${id}_author_base`
}

/** The roadmap line immediately before `id`, or null when `id` is the first. */
export function previousLineId(roadmap, id) {
  const i = (roadmap?.lines ?? []).findIndex(l => l.id === id)
  return i > 0 ? roadmap.lines[i - 1].id : null
}

const homeOf = (io) => norm(io?.home ?? cyncoHome())

/**
 * calibrate() and lintGate() take their own io shapes. Rather than make the
 * authoring io pretend to be both, hand each of them the subset it wants,
 * falling back to the real filesystem for anything the caller did not fake.
 */
function calibrationIo(io) {
  const out = { ...calibrateDefaultIo }
  for (const k of ['run', 'exists', 'readFile', 'writeFile', 'sha256', 'freshDir']) if (io?.[k]) out[k] = io[k]
  return out
}

/** Instrument files, and nothing else: no suite baselines, no `__pycache__`. */
const INSTRUMENT_FILE = /^(?:gate|perturb|positive)_[A-Za-z0-9_-]+\.py$/

/**
 * The staging tree MIRRORS the sealed tree, one campaign directory per line,
 * and that is not a convenience.
 *
 * A sealed gate resolves the prior campaign's gate as a SIBLING:
 *   os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "c7", "gate_c7.py")
 * so gate_c8.py run from anywhere looks one directory up and across. Copying
 * the previous gate BESIDE the author's own file (what this used to do) put
 * gate_c8.py in `authoring/c9/`, where its own C8.9 line then searched
 * `authoring/c7/gate_c7.py`, found nothing, and failed — making the author's
 * C9.9 red at BASE for a reason that has nothing to do with the game, and
 * green again the moment the triple moved into the sealed tree. A gate whose
 * calibration and whose campaign disagree is the one thing Rule 11 exists to
 * catch, and it would have caught it in the wrong direction.
 *
 * So: every FINISHED campaign's instruments are mirrored as siblings of the
 * staging dir, overwritten on every run. They are sealed-by-location copies of
 * campaigns that are over; `<id>` itself is skipped, because that directory is
 * the author's own workspace and must never be overwritten from heldout.
 */
export function mirrorPriorCampaigns({ id, io }) {
  const home = homeOf(io)
  const family = `${home}/heldout/${HELDOUT_FAMILY}`
  const mirrored = []
  for (const dir of io.listDir(family)) {
    // `<x>.sealing-<ts>` is a half-written seal, not a campaign — a machine
    // that died between the copy and the rename leaves one, and mirroring it
    // would hand the author a directory of instruments nobody sealed.
    if (dir === id || dir.includes('.sealing-')) continue
    const src = `${family}/${dir}`
    for (const f of io.listDir(src)) {
      if (!INSTRUMENT_FILE.test(f)) continue
      io.copy(`${src}/${f}`, `${home}/authoring/${dir}/${f}`)
      mirrored.push(`${dir}/${f}`)
    }
  }
  return mirrored
}

/**
 * The staging dir (a git repo — the mission commits after each cut, and that
 * is its only backup), the read-only archive of the game at BASE, and the
 * mirrored sibling directories of every finished campaign.
 */
export function prepareStaging({ id, base, repo = CIVKINGS_REPO, io }) {
  const stagingDir = stagingDirFor(id, homeOf(io))
  const baseDir = baseDirFor(id)
  io.mkdir(stagingDir)
  if (!io.exists(`${stagingDir}/.git`)) {
    const init = io.run('git', ['init', stagingDir], { timeoutMs: 60_000 })
    if (init.status !== 0) throw new Error(`git init ${stagingDir} failed: ${String(init.stderr).trim()}`)
  }
  // A repo with no identity is FATAL, not cosmetic: the mission is ordered to
  // commit after each cut, `git commit` refuses without a user, and
  // dispatch-mission.sh runs `git rev-parse` under `set -e` in the same tree.
  // Pin a local one so the author's only backup cannot fail on configuration.
  io.run('git', ['-C', stagingDir, 'config', 'user.name', 'cynco-author'], { timeoutMs: 60_000 })
  io.run('git', ['-C', stagingDir, 'config', 'user.email', 'cynco@localhost'], { timeoutMs: 60_000 })
  const arch = archiveBase(repo, base, baseDir, calibrationIo(io))
  if (!arch.ok) throw new Error(arch.problems.join('; '))
  const mirrored = mirrorPriorCampaigns({ id, io })
  return { stagingDir, baseDir, mirrored }
}

/**
 * The previous campaign's gate as a STYLE exemplar: the first 40 lines of the
 * gate and the first 12 of its cheat stub, verbatim.
 *
 * Every line carrying the word the sealed tree is named for is dropped and the
 * path is never printed. The brief is a file a model reads; a gate author who
 * learns where gates live has learned the one thing the next campaign's worker
 * must not be able to ask it for.
 */
export function exemplarFor({ prevId, io }) {
  if (!prevId) return null
  const dir = heldoutDirFor(prevId, homeOf(io))
  const head = (path, n) => {
    if (!io.exists(path)) return null
    return io.readFile(path).split(/\r?\n/).slice(0, n).filter(l => !l.includes('heldout')).join('\n')
  }
  const gateHead = head(`${dir}/gate_${prevId}.py`, 40)
  const perturbHead = head(`${dir}/perturb_${prevId}.py`, 12)
  if (!gateHead && !perturbHead) return null
  return { gateHead: gateHead ?? '', perturbHead: perturbHead ?? '' }
}

/** The one command that decides whether the authored triple is a bar. */
export function checkCommand(stagingDir, baseDir) {
  return `bun scripts/cynco-gate-author.mjs --check ${JSON.stringify(norm(stagingDir))} ${JSON.stringify(norm(baseDir))}`
}

/**
 * The contract sidecar the driver picks up beside the brief. One assertion,
 * `role: 'keep-green'` — the same role the wave sidecar uses, because this IS
 * the mission's acceptance test and Task 6 finds it by role, not by index.
 */
export function authoringSidecar({ stagingDir, baseDir }) {
  return { assertions: [{ text: 'The staged gate triple passes lint and calibration.', command: checkCommand(stagingDir, baseDir), timeoutMs: 7_200_000, role: 'keep-green' }] }
}

const section = (heading, body) => `${heading}\n\n${body.replace(/\s+$/, '')}\n`

/**
 * The authoring order, deterministic and golden-tested.
 *
 * Nine sections in a fixed order; PREVIOUS CHECK OUTPUT appears only on a
 * resume, where it is the single most useful thing in the file — the last run
 * already discovered which of these rules it broke.
 */
export function authoringBrief({ line, id, prevId, baseDir, stagingDir, exemplar, previousCheck = null }) {
  const ID = id.toUpperCase()
  const N = String(id).replace(/^c/i, '')
  const P = `C${N}`
  const prev = prevId ?? 'cPREV'
  const staging = norm(stagingDir)
  const base = norm(baseDir)
  // Nothing written here may name the directory the sealed tree lives in —
  // not the exemplar, and not the previous run's check output, which is
  // machine-generated text that has already been through `--check`.
  const noSealedPath = (s) => String(s ?? '').split(/\r?\n/).filter(l => !l.includes('heldout')).join('\n')
  const out = []

  out.push(section(`MISSION ${ID}-AUTHOR — WRITE THE SEALED GATE FOR ${String(line.name).toUpperCase()}`,
`You are the supervisor seat, writing the BAR a later campaign will be graded
against. You do not write the game and you do not fix the game. You write four
files in ${staging} and you stop when the check command below exits 0.
(${Math.round(AUTHOR_TIMEOUT_S / 3600)} hours, ${AUTHOR_ITERATIONS} iterations.)`))

  out.push(section('THE ROADMAP LINE',
`  ${line.id} — ${line.name}
  ${line.bar}
  BASE ${line.base}`))

  out.push(section('THE GAME AT BASE',
`The game is Python (pygame). A read-only archive of the repository at BASE is
at

  ${base}

Run it from that directory. It is READ-ONLY: nothing you write there is graded,
nothing you change there survives, and the campaign worker will never see it.
Your own four files go in ${staging}.

Headless conventions (the gate runs with no display and no sound card):

  set SDL_VIDEODRIVER=dummy and SDL_AUDIODRIVER=dummy before importing pygame
  state = gilded.ui.app.new_app_state(seed=N)      # the whole game, one call
  a draw is: view.regions cleared, then view.draw(screen)
  a press is: view.handle_click(region.rect.center), then
              gilded.ui.app._apply_action(state, action)

Audit the game at BASE before you write a single check. Every line you write
must FAIL there, and it must fail because the feature is ABSENT — not because
your check crashed.`))

  out.push(section('WHAT TO WRITE',
`Four files, these exact names, in ${staging}:

  gate_${id}.py              the bar: one printed line per graded fact
  perturb_${id}.py           the cheat stub: a world that CLAIMS the feature
  positive_${id}.py          the Rule 14 shim: makes every graded fact true
  ${id}.campaign.draft.json  the campaign draft (see below)

gate_${id}.py:

  * Read the repository under test from the environment:
      REPO = os.environ.get("CYNCO_GATE_REPO") or r"C:\\Users\\civer\\civkings"
    A gate that hardcodes a path measures whatever directory it was started
    in, not the tree it was handed.
  * One helper, used for every graded fact:
      check(name, cond, detail)
    printing exactly
      <id>: PASS <detail>
      <id>: FAIL <detail>
    and appending to a FAILS list when cond is false.
  * Ids are ${P}.<k>[a-z].<slug> — ${P}.1a.slot-list, ${P}.3b.save-round-trips.
    Unique, and every one of them carries the ${P}. prefix.
  * At least 8 graded lines. Fewer than that is a spot check, not a bar: one
    lucky edit clears it.
  * The last line printed is the terminator the runner parses:
      GATE: PASS            when nothing failed
      GATE: MISS (<n> fails)  otherwise
  * ${P}.9 is the regression line. It runs the previous campaign's gate in a
    FRESH interpreter, and it resolves it as a SIBLING — this exact form, no
    other:
      prior = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "${prev}", "gate_${prev}.py")
      env = {k: v for k, v in os.environ.items() if k != "CYNCO_GATE_SKIP_PRIOR"}
      r = subprocess.run([sys.executable, prior], cwd=REPO, env=env,
                         capture_output=True, text=True, timeout=3600)
    The child env has CYNCO_GATE_SKIP_PRIOR STRIPPED, so the whole C1..${prev.toUpperCase()}
    chain runs behind it. The layout is identical in the sealed tree: your gate
    is sealed into its own directory beside ${prev}'s, exactly as it sits here,
    so a path that works now works after sealing and a path that works only now
    is a gate whose calibration and whose campaign disagree.
    Count the child's FAIL lines, echo them prefixed with "  [${prev}] ", and
      check("${P}.9", not prior_fails, f"{len(prior_fails)} prior-campaign regressions")
    Wrap the whole block in
      if not os.environ.get("CYNCO_GATE_SKIP_PRIOR"):
    so the calibration shims can turn the chain off instead of recursing.

perturb_${id}.py and positive_${id}.py:

  * Both run THE REAL GATE, never a copy of it:
      os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
      runpy.run_path(<gate path>, run_name="__main__")
    after installing whatever they install. A shim that reimplements the gate
    grades a second instrument nobody sealed.
  * perturb_${id}.py declares, in its header comment, which lines its lie
    flips and which lines must survive it:
      # EXPECT-FLIP: ${P}.1a ${P}.2a
      # MUST-FAIL: ${P}.1b ${P}.1c ${P}.3a
    EVERY line that FAILs at BASE must appear in one of the two lists, and
    MUST-FAIL must not be empty.

No network. Not urllib, not requests, not socket, not http.client, in any of
the three: a bar that depends on a remote is not a measurement of the repo, it
is a flake.`))

  out.push(section('THE RULES',
`Rule 11 — the BASE must MISS. Run the gate against ${base}
  before you believe anything: the terminator must be MISS, every line you
  wrote must fail there BY ABSENCE, and the run must print zero error lines
  (no Traceback, no "Error:"). A line that fails because your check crashed is
  a line that measures your check.

Rule 14 — the positive shim must make the gate PASS. positive_${id}.py
  satisfies every claim the CHEAPEST HONEST way and must print GATE: PASS with
  zero error lines. This is what proves the bar is reachable at all: a typo'd
  path or an assert that can never hold is caught here instead of after eight
  hours of a campaign wave.

Rule 15 — every line grades an OUTCOME, never a claim. Pixels on the drawn
  screen; drawn regions pressed at their centres and the change that follows;
  files on disk; values the running game returns. Never that a control merely
  exists, never that a function is defined, never that a name appears in a
  source file. "There is a Region with action {'zoom': 'parish'}" is not a
  line. "Pressing it changes the map on >= 5% of the content band's pixels"
  is.

Undisclosed seeds. The draft's measures name seed 7 — that is the seed the
  campaign worker will build and test against. The gate ALSO runs seed 11 and
  grades it the same way, and the draft never mentions seed 11. A worker who
  special-cases the disclosed seed fails the undisclosed one.

Classify every BASE failure. Each id that FAILs at BASE goes in EXPECT-FLIP
  (the cheat stub is expected to turn it green) or in MUST-FAIL (it is a
  discriminator and must stay red under the stub). MUST-FAIL must be
  non-empty: a stub nothing must survive proves nothing.`))

  out.push(section('THE DRAFT',
`${id}.campaign.draft.json — JSON, these fields and no others. The runner fills
in everything else (repo, base, the three instrument paths, the suite baseline,
the marker, budget, invariants, posiwid, sweep, prBase, ideation, author).

  title       one lower-case phrase, e.g. "ship shell"
  keepGreen   the command the worker runs before every commit. NAME THE FILES:
              no * and no ? anywhere in it (F146). e.g.
              "python -m pytest gilded/tests/test_${id}_saves.py -q"
  measures    the prose definition of HOW each line is measured, in enough
              detail that a worker can build to it without ever seeing the
              gate. Name seed 7. Never name a file called gate_${id}.py,
              perturb_${id}.py or positive_${id}.py — the campaign refuses a
              brief that names its own instrument.
  work        [ { id, title, gateIds: [...], text } ] — the cuts, in the order
              you would do them. Between them the gateIds must cover EVERY
              graded line except ${P}.9, and no id twice.
  allow       { newFiles: [...], edit: [...] } — repo-relative paths. An entry
              may not START with a glob.
  deny        [ ... ] — what the campaign must not touch.
  rules       [ ... ] — standing orders for the worker.
  assets      optional { root, text } when the work needs pre-staged files.`))

  // Belt and braces with exemplarFor: whatever route an exemplar arrives by,
  // the word the sealed tree is named for does not reach a model's brief.
  const gateHead = noSealedPath(exemplar?.gateHead), perturbHead = noSealedPath(exemplar?.perturbHead)
  const ex = gateHead || perturbHead
    ? `The previous campaign's gate, the first 40 lines — the house style, the
header a sealed gate carries, and the way it reaches the repository:

${gateHead}

and the first lines of its cheat stub, including the header format the
calibration parses:

${perturbHead}`
    : 'No previous campaign gate is available; follow WHAT TO WRITE exactly.'
  out.push(section('EXEMPLAR', ex))

  if (previousCheck) {
    out.push(section('PREVIOUS CHECK OUTPUT',
`The last authoring run left the triple in ${staging} and the check REFUSED it.
These are its words. Fix these before anything else; do not start over.

${noSealedPath(previousCheck)}`))
  }

  out.push(section('DONE WHEN',
`  ${checkCommand(staging, base)}

exits 0, run from ${staging}.

Commit in ${staging} after each cut — it is the only backup you have. When the
check is green, print, as the last thing you say:

  gate ${id} authored`))

  return out.join('\n')
}

/**
 * The mechanical acceptance test: static lint, then Rule 11 + Rule 14 against
 * the archived BASE. Every problem is a printed line, never a throw — the
 * author reads them and fixes them, and a stack trace teaches nothing.
 */
export async function checkStaged({ id, stagingDir, baseDir, io }) {
  const dir = norm(stagingDir)
  const paths = { gate: `${dir}/gate_${id}.py`, perturb: `${dir}/perturb_${id}.py`, positive: `${dir}/positive_${id}.py`, draft: `${dir}/${id}.campaign.draft.json` }
  const missing = Object.entries(paths).filter(([, p]) => !io.exists(p)).map(([, p]) => basename(p))
  if (missing.length) return { ok: false, problems: missing.map(f => `missing: ${f} was never written into the staging dir`), lineIds: [], calibration: null }
  if (!io.exists(baseDir)) return { ok: false, problems: [`missing: the BASE archive ${norm(baseDir)} does not exist — re-run --author to rebuild it`], lineIds: [], calibration: null }

  const lint = lintGate({ campaignId: id, gatePath: paths.gate, perturbPath: paths.perturb, positivePath: paths.positive, io: { readFile: io.readFile } })
  const spec = { id, gate: paths.gate, perturb: paths.perturb, positive: paths.positive, base: norm(baseDir), repo: null,
    suiteBaseline: `${dir}/suite_baseline_${id}.txt` }
  const calibration = await calibrate(spec, calibrationIo(io), { baseDir: norm(baseDir) })
  const problems = [...lint.problems, ...calibration.problems]
  return { ok: problems.length === 0, problems, lineIds: lint.lineIds, calibration }
}

/** The proposal a passing check raises. `evidence.problems` is empty by
 *  construction — a proposal is only ever raised from a clean check. */
export function gateProposal({ id, check, missionId, verified }) {
  return {
    type: 'Code',
    name: `gate/${id}`,
    description: `Seal the CynCo-authored gate triple for ${id} — ${check.lineIds.length} graded lines, BASE MISS, cheat stub honest, positive shim PASS.`,
    status: 'pending',
    evidence: { lineCount: check.lineIds.length, problems: [], missionId: missionId ?? null, verified: verified ?? null },
  }
}

function commitStaging(stagingDir, message, io) {
  const r = io.run('git', ['-C', norm(stagingDir), 'add', '-A'], { timeoutMs: 60_000 })
  if (r.status !== 0) { console.error(`[author] git add in ${norm(stagingDir)} failed: ${String(r.stderr).trim()}`); return }
  const c = io.run('git', ['-C', norm(stagingDir), 'commit', '-m', message], { timeoutMs: 60_000 })
  // "nothing to commit" is exit 1 and is not a fault: a resume that changed
  // nothing but the brief number still has a brief to dispatch.
  if (c.status !== 0 && !/nothing to commit/i.test(String(c.stdout) + String(c.stderr))) {
    console.error(`[author] git commit in ${norm(stagingDir)} failed: ${String(c.stderr).trim()}`)
  }
}

/**
 * `--author <id>`: one authoring mission, start to verdict.
 *
 * The model's own check is NOT trusted — the driver ran it, but the driver ran
 * it in a process the mission could have reached. The runner re-runs
 * `checkStaged` from here, and only that reading raises the proposal.
 */
export async function authorCampaign({ id, roadmap, state, io }) {
  const refusal = (why) => ({ ok: false, why, proposal: null, missionId: null, verified: null, check: null })
  const line = lineFor(roadmap, id)
  if (!line) return refusal(`the roadmap has no line "${id}"`)
  if (line.status !== 'open' && line.status !== 'authoring') {
    return refusal(`roadmap line ${id} is "${line.status}" — --author only opens a line that is "open" or "authoring"`)
  }
  const s = state.state
  s.authoring = s.authoring ?? {}
  const prevId = previousLineId(roadmap, id)
  const { stagingDir, baseDir } = prepareStaging({ id, base: line.base, repo: CIVKINGS_REPO, io })
  setLineStatus(roadmap, id, 'authoring')
  ;(io.saveRoadmap ?? saveRoadmap)(ROADMAP_PATH, roadmap)

  const prev = s.authoring[id] ?? {}
  const attempt = (prev.attempts ?? 0) + 1
  const briefFile = `${stagingDir}/brief-${attempt}.txt`
  const text = authoringBrief({ line, id, prevId, baseDir, stagingDir, exemplar: exemplarFor({ prevId, io }), previousCheck: prev.lastCheck?.output ?? null })
  io.writeFile(briefFile, text)
  io.writeFile(sidecarPath(briefFile), JSON.stringify(authoringSidecar({ stagingDir, baseDir }), null, 2) + '\n')
  commitStaging(stagingDir, `${id}-author: brief ${attempt}`, io)

  const pidFile = `C:/tmp/driver_${id}-author.pid`, driverLog = `C:/tmp/driver_${id}-author.log`
  const env = io.dispatchEnv(process.env, {
    LOCALCODE_MAX_ITERATIONS: String(AUTHOR_ITERATIONS),
    CYNCO_MISSION_INVARIANTS: JSON.stringify(AUTHOR_INVARIANTS),
    CYNCO_CAMPAIGN_ID: `${id}-author`,
    // Ruling 12: AWM promotion fires when a contract passes — and this one
    // will. Its learnings must land in a database the campaign worker never
    // opens, or the bar's author would be whispering to the subject.
    LOCALCODE_LEARNINGS_DB: `${stagingDir}/learnings.db`,
    // The acceptance test is not a pytest run of seconds: `--check` is three
    // gate invocations against the archived BASE plus, on the first green
    // check, the whole civkings suite for the baseline. The model's OWN Bash
    // tool caps at 120 s by default (Stage 11I lost five suite runs to that)
    // and the driver's check cap at 600 s; both would kill the very command
    // the mission is graded on.
    //
    // The two numbers are ONE number on purpose. The model is told to run the
    // check itself and the driver runs the same command to grade it; a Bash
    // cap below the check cap means the model's run dies where the driver's
    // survives, and the mission spends its budget chasing a timeout the grader
    // never sees. 7,200,000 ms is what the sidecar assertion allows.
    CYNCO_BASH_TIMEOUT_MS: '7200000',
    CYNCO_CHECK_TIMEOUT_MS: '7200000',
    CYNCO_SKIP_IDLE_ENGINE: '1',
    DRIVER_PID_FILE: pidFile,
    DRIVER_LOG: driverLog,
  })
  // Persist BEFORE the wall clock starts, the same discipline runWave keeps: a
  // runner that dies in the wait must not let the next invocation dispatch a
  // second authoring mission on top of the first.
  s.authoring[id] = { ...prev, stagingDir, baseDir, briefFile, attempts: attempt, dispatchedAt: io.now(), missionId: null, verified: null, fault: null }
  state.save()

  let missionId = null, verified = null, fault = null
  try {
    await io.dispatch({ briefFile, marker: `gate ${id} authored`, cwd: stagingDir, timeoutS: AUTHOR_TIMEOUT_S, checkCmd: checkCommand(stagingDir, baseDir), env })
    const waited = await io.waitForDriver({ pidFile, driverLog, timeoutMs: (AUTHOR_TIMEOUT_S + 3600) * 1000 })
    missionId = waited.exited ? (waited.missionId ?? io.missionIdFrom?.(driverLog) ?? null) : null
    const row = missionId ? io.readRow(missionId) : null
    verified = row ? (row.verified ?? null) : null
    if (!row) {
      fault = waited.exited ? 'driver exited without a ledger row'
        : waited.pidUnseen ? `driver pid ${waited.pidUnseen} was already invisible on the first probe — the PID handoff is broken and the mission may still be running unwatched (see ${driverLog})`
          : 'driver did not exit within the wall clock'
    }
  } catch (e) {
    fault = `dispatch or wait failed: ${e?.message ?? e}`
    console.error(`[author] ${id}: ${e?.stack ?? e}`)
  }

  const check = await checkStaged({ id, stagingDir, baseDir, io })
  const lastCheck = { at: io.now(), ok: check.ok, problems: check.problems, lineCount: check.lineIds.length,
    output: check.ok ? `PASS — ${check.lineIds.length} graded lines` : check.problems.join('\n') }
  s.authoring[id] = { ...s.authoring[id], missionId, verified, lastCheck, fault }

  let proposal = null
  // §4: a dispatch fault, or a mission whose own check never produced a
  // verdict, is not evidence either way. The triple may well be green — but
  // nothing here knows whether it was the mission that wrote it.
  if (check.ok && !fault && verified !== null) {
    proposal = gateProposal({ id, check, missionId, verified })
    s.proposals = s.proposals ?? []
    if (!s.proposals.some(p => p.name === proposal.name && p.status === 'pending')) s.proposals.push({ ...proposal, proposedAt: io.now() })
    setLineStatus(roadmap, id, 'proposed')
    ;(io.saveRoadmap ?? saveRoadmap)(ROADMAP_PATH, roadmap)
  }
  state.save()
  const why = proposal ? null : fault ?? (check.ok ? `the mission produced no verified check result` : `--check refused the staged triple (${check.problems.length} problem(s))`)
  return { ok: Boolean(proposal), why, proposal, missionId, verified, check }
}

/**
 * The draft (author-owned fields) plus the runner-owned fields, as one spec.
 *
 * Throws on anything the author got wrong, BEFORE a single byte reaches
 * `docs/` or the sealed tree: a half-seal is worse than a refusal.
 */
export const DRAFT_KEYS = ['title', 'keepGreen', 'measures', 'work', 'allow', 'deny', 'rules', 'assets']

export function draftToSpec({ id, draft, line, paths, authorMissionId = null, lineIds = [] }) {
  // An unknown key is either a runner-owned field the author tried to set
  // (its own budget, its own invariants, its own `base`) or a typo of one of
  // these eight. Both are silent today — the spread below simply ignores it —
  // and both are exactly the kind of thing whose absence is only noticed a
  // campaign later. Name them and refuse.
  const unknown = Object.keys(draft ?? {}).filter(k => !DRAFT_KEYS.includes(k))
  if (unknown.length) throw new Error(`draft has ${unknown.length} field(s) the author does not own: ${unknown.join(', ')} — the draft carries only ${DRAFT_KEYS.join(', ')}`)
  const need = (k) => { const v = draft?.[k]; if (v === undefined || v === null || v === '') throw new Error(`draft is missing "${k}"`); return v }
  const title = need('title'), keepGreen = need('keepGreen'), measures = need('measures')
  if (/[*?]/.test(String(keepGreen))) throw new Error('draft keepGreen contains a wildcard — the check must name files (F146)')
  const work = draft?.work
  if (!Array.isArray(work) || work.length === 0) throw new Error('draft work must be a non-empty array of cuts')
  for (const w of work) {
    for (const k of ['id', 'title', 'gateIds', 'text']) if (w?.[k] === undefined) throw new Error(`draft work item is missing "${k}"`)
    if (!Array.isArray(w.gateIds) || w.gateIds.length === 0) throw new Error(`draft work item ${w.id} has no gateIds`)
  }
  if (!Array.isArray(draft?.allow?.newFiles) || !Array.isArray(draft?.allow?.edit)) throw new Error('draft allow.newFiles and allow.edit must be arrays')
  for (const k of ['deny', 'rules']) if (!Array.isArray(draft?.[k])) throw new Error(`draft ${k} must be an array`)
  // Coverage: every graded line but the regression line belongs to exactly one
  // cut. A line no work item claims is a line the brief never asks for.
  const regression = `C${String(id).replace(/^c/i, '')}.9`.toLowerCase()
  const claimed = new Set(work.flatMap(w => w.gateIds))
  const uncovered = lineIds.filter(x => x.toLowerCase() !== regression && !x.toLowerCase().startsWith(regression + '.') && !claimed.has(x))
  if (uncovered.length) throw new Error(`draft work[] gateIds do not cover ${uncovered.length} graded line(s): ${uncovered.join(' ')}`)
  // And the other direction. A work item claiming an id the gate never prints
  // reads, in the wave brief, as an order to fix a line that cannot fail — and
  // `loadCampaignSpec` would accept it, because nothing there has ever seen
  // the gate. The lint ids are the only list that has.
  if (lineIds.length) {
    const phantom = [...claimed].filter(g => !lineIds.includes(g))
    if (phantom.length) throw new Error(`draft work[] gateIds name ${phantom.length} line(s) the gate does not grade: ${phantom.join(' ')}`)
  }

  return {
    id,
    title,
    repo: CIVKINGS_REPO,
    base: line.base,
    gate: paths.gate,
    perturb: paths.perturb,
    positive: paths.positive,
    suiteBaseline: paths.suiteBaseline,
    marker: `stage ${id} complete`,
    keepGreen,
    budget: { ...RUNNER_BUDGET },
    invariants: { ...AUTHOR_INVARIANTS },
    posiwid: { ...RUNNER_POSIWID },
    sweep: { ...RUNNER_SWEEP },
    prBase: 'main',
    allow: { newFiles: [...draft.allow.newFiles], edit: [...draft.allow.edit] },
    deny: [...draft.deny],
    ...(draft.assets ? { assets: draft.assets } : {}),
    measures,
    work,
    rules: [...draft.rules],
    ideation: { enabled: true },
    author: 'cynco',
    authorMissionId: authorMissionId ?? null,
  }
}

/**
 * The seal: the copy into the sealed tree, the campaign json, the identity
 * check, the campaign-log entry and the roadmap move.
 *
 * EVERY check runs before ANY write. A refused seal used to be a dead end: the
 * proposal decision had already been recorded (so there was nothing left to
 * approve), and the triple had already been copied into `heldout/<id>` (so the
 * retry hit the different-sha guard against a directory this verb had written
 * itself). Now the order is: prove it, stage the copy in a temp directory
 * beside the real one, and only then make it visible under its real name. The
 * decision is recorded by the CALLER, after this returns ok.
 */
export async function sealGate({ id, state, roadmap, io }) {
  const a = state.state.authoring?.[id]
  if (!a?.stagingDir) return { ok: false, problems: [`nothing staged for ${id} — run --author ${id} first`] }
  const stagingDir = norm(a.stagingDir), baseDir = norm(a.baseDir ?? baseDirFor(id))
  const heldout = heldoutDirFor(id, homeOf(io))
  const staged = { gate: `${stagingDir}/gate_${id}.py`, perturb: `${stagingDir}/perturb_${id}.py`, positive: `${stagingDir}/positive_${id}.py` }
  const draftPath = `${stagingDir}/${id}.campaign.draft.json`

  // ── every refusal, before a single byte is written ──────────────────────
  const missing = [...Object.values(staged), draftPath].filter(p => !io.exists(p)).map(p => basename(p))
  if (missing.length) return { ok: false, problems: missing.map(f => `missing: ${f} is not in the staging dir`) }

  // Rule 11 again, at seal time: the triple on disk NOW is the triple being
  // sealed, and the check the mission passed was run against whatever was
  // there when it ran.
  const check = await checkStaged({ id, stagingDir, baseDir, io })
  if (!check.ok) return { ok: false, problems: check.problems, check }

  const sealedGate = `${heldout}/gate_${id}.py`
  if (io.exists(sealedGate) && io.sha256(sealedGate) !== io.sha256(staged.gate)) {
    return { ok: false, problems: [`${heldout} already holds a gate_${id}.py with a different sha256 — a sealed gate is never overwritten; delete it by hand if that is really what you mean`], check }
  }

  let draft
  try { draft = JSON.parse(io.readFile(draftPath)) }
  catch (e) { return { ok: false, problems: [`${id}.campaign.draft.json is not valid JSON — ${e.message}`], check } }

  const line = lineFor(roadmap, id)
  if (!line) return { ok: false, problems: [`the roadmap has no line "${id}"`], check }
  const base7 = String(line.base).slice(0, 7)
  const paths = { gate: sealedGate, perturb: `${heldout}/perturb_${id}.py`, positive: `${heldout}/positive_${id}.py`,
    suiteBaseline: `${heldout}/suite_baseline_${base7}.txt` }
  let spec
  try { spec = draftToSpec({ id, draft, line, paths, authorMissionId: a.missionId ?? null, lineIds: check.lineIds }) }
  catch (e) { return { ok: false, problems: [e.message], check } }

  // S5 identity on the spec that WOULD be written. The spec must carry the
  // sealed paths (`underHeldout` is half of what identity means), but those
  // files do not exist yet — so the existence question is answered against the
  // STAGED copies, which are byte-identical to what the copy below will put
  // there. Substituting in the io rather than in the spec keeps both halves
  // honest.
  const stagedFor = { [paths.gate]: staged.gate, [paths.perturb]: staged.perturb, [paths.positive]: staged.positive }
  const identity = checkIdentity(spec, {
    exists: (p) => io.exists(stagedFor[norm(p)] ?? p),
    readFile: (p) => io.readFile(stagedFor[norm(p)] ?? p),
    gitHasCommit: io.gitHasCommit ?? ((repo, sha) => spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' }).status === 0),
  })
  if (!identity.ok) return { ok: false, problems: identity.problems, check }

  // The loader is the runner's own door, and it only opens for a file. Try it
  // on a throwaway beside the BASE archive — nothing under docs/ or heldout/
  // exists yet, and a spec that trips it must not be the reason one does.
  const specPath = `${BRIEFS_DIR}/${id}.campaign.json`
  const specText = JSON.stringify(spec, null, 2) + '\n'
  const trialPath = `C:/tmp/${id}_seal_check.campaign.json`
  io.writeFile(trialPath, specText)
  // `finally` on both paths: the trial is scaffolding, and a stale
  // `c9_seal_check.campaign.json` left beside the BASE archive is a file that
  // looks like a campaign spec and is not one.
  try { (io.loadSpec ?? loadCampaignSpec)(trialPath) }
  catch (e) { return { ok: false, problems: [`the spec ${id}.campaign.json would not load: ${e.message}`], check } }
  finally { io.remove(trialPath) }

  // ── nothing above wrote anything visible; from here it is all commit ────
  //
  // The triple lands in a sibling temp directory first and is RENAMED into
  // place, so a copy that dies halfway leaves `heldout/<id>` either absent or
  // whole — never three files where one is truncated. A reseal (the sha guard
  // above already proved the gate is identical) copies in place instead: the
  // directory holds a suite baseline the campaign measured, and a rename would
  // take it with it.
  const sealedAt = io.now()
  const tmpDir = `${homeOf(io)}/heldout/${HELDOUT_FAMILY}/${id}.sealing-${sealedAt.replace(/[^0-9]/g, '')}`
  io.mkdir(tmpDir)
  let moved = false
  try {
    for (const k of ['gate', 'perturb', 'positive']) io.copy(staged[k], `${tmpDir}/${basename(paths[k])}`)
    if (io.exists(heldout)) {
      for (const k of ['gate', 'perturb', 'positive']) io.copy(`${tmpDir}/${basename(paths[k])}`, paths[k])
    } else {
      io.rename(tmpDir, heldout)
      moved = true
    }
  } finally {
    // The reseal branch leaves it behind on purpose; a copy that died halfway
    // leaves it behind by accident. Neither may survive: the sealed tree is
    // enumerated by directory name (mirrorPriorCampaigns, and a human reading
    // it), and `c9.sealing-20260923…` beside `c9` reads as a second campaign.
    if (!moved) io.removeDir(tmpDir)
  }

  io.writeFile(specPath, specText)

  const shas = { gateSha256: io.sha256(paths.gate), perturbSha256: io.sha256(paths.perturb), positiveSha256: io.sha256(paths.positive) }
  state.state.authoring[id] = { ...a, sealedAt, specPath, ...shas }
  setLineStatus(roadmap, id, 'sealed')
  ;(io.saveRoadmap ?? saveRoadmap)(ROADMAP_PATH, roadmap)
  state.save()

  io.appendLog(sealEntry({ id, line, spec, check, sealedAt, shas, missionId: a.missionId ?? null, verified: a.verified ?? null }))
  return { ok: true, problems: [], specPath, heldout, check, sealedAt, ...shas }
}

/**
 * The terminator a run actually printed, read back out of its captured tail.
 *
 * Through the real parser, not a regex over the tail. A gate's output carries
 * the prior campaign's terminator too, echoed by the `C<N>.9` block and
 * indented (`  [c8] GATE: MISS (4 fails)`) — which comes FIRST, so a first-match
 * regex printed the previous campaign's verdict in this campaign's log entry.
 * parseGateOutput is anchored, skips the `  [` echoes, and keeps the last
 * terminator it sees, which is the gate's own.
 */
function printedTerminator(tail, fallback) {
  const parsed = parseGateOutput(tail)
  if (!parsed.terminator) return fallback
  if (parsed.terminator === 'PASS') return 'GATE: PASS'
  return parsed.failCount === null ? 'GATE: MISS' : `GATE: MISS (${parsed.failCount} fails)`
}

/**
 * The campaign-log entry: the heading, then five paragraphs of fact and no
 * prose beyond them.
 *
 * All THREE sha256s, not just the gate's. The perturb is what makes the
 * calibration a judgement and the positive shim is what makes it reachable;
 * a reseal that moved either of them changes what every later reading means,
 * and the log is the only place a human goes looking for what was sealed.
 */
export function sealEntry({ id, line, spec, check, sealedAt, shas, missionId, verified }) {
  const cal = check.calibration ?? {}
  const baseFails = cal.baseFails ?? [], perturbFails = cal.perturbFails ?? []
  const pertIds = new Set(perturbFails.map(f => f.id))
  const flipped = baseFails.map(f => f.id).filter(x => !pertIds.has(x))
  const baseTerm = printedTerminator(cal.baseOutputTail, `GATE: MISS (${baseFails.length} fails)`)
  const positiveTerm = printedTerminator(cal.positiveOutputTail, `GATE: ${cal.positive?.terminator ?? 'PASS'}`)
  return [
    `## Campaign ${id.toUpperCase()} — ${line.name} (authored by CynCo, sealed ${sealedAt.slice(0, 10)}, BASE ${String(spec.base).slice(0, 7)}, gate_${id}.py sha256 ${shas.gateSha256})`,
    ``,
    `Roadmap line: ${line.bar}`,
    ``,
    `The gate grades ${check.lineIds.length} line(s): ${check.lineIds.join(', ')}.`,
    ``,
    `Authoring mission: ${missionId ?? 'none'} (verified ${verified === null || verified === undefined ? 'null' : verified}).`,
    ``,
    `Sealed sha256: gate_${id}.py ${shas.gateSha256}, perturb_${id}.py ${shas.perturbSha256}, positive_${id}.py ${shas.positiveSha256}.`,
    ``,
    `Calibration: BASE printed ${baseTerm} — ${baseFails.length} fail(s) by absence, zero error lines; the cheat stub flips ${flipped.length ? flipped.join(', ') : 'nothing'} and leaves ${perturbFails.length} discriminator(s) red; the positive shim printed ${positiveTerm}.`,
    ``,
  ].join('\n')
}

/**
 * The io the runner builds and hands over. `helpers` are the runner's own
 * functions — passed in rather than imported, because importing them would
 * close the cycle this module exists on the other side of.
 */
export function defaultAuthorIo(helpers = {}) {
  return {
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    run: (cmd, args, { cwd, env, timeoutMs, shell } = {}) => {
      const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' }
    },
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s, 'utf8') },
    copy: (src, dst) => { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst) },
    // An absent directory is an empty one here: the sealed tree has no prior
    // campaigns on a fresh machine, and that is not an error to mirror from.
    listDir: (p) => { try { return readdirSync(p) } catch { return [] } },
    rename: (src, dst) => { mkdirSync(dirname(dst), { recursive: true }); renameSync(src, dst) },
    // `force` on both: removing what is already gone is the success case here,
    // and every caller is a cleanup path that must not throw over it.
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    remove: (p) => rmSync(p, { force: true }),
    sha256: (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16),
    freshDir: calibrateDefaultIo.freshDir,
    now: () => new Date().toISOString(),
    loadRoadmap: () => loadRoadmap(ROADMAP_PATH),
    saveRoadmap: (p, r) => saveRoadmap(p, r),
    loadSpec: (p) => loadCampaignSpec(p),
    stateFor: (id) => new CampaignState(join(cyncoHome(), 'campaigns', id)).load(),
    appendLog: helpers.appendLog ?? (() => { throw new Error('io.appendLog was not supplied by the runner') }),
    dispatch: helpers.dispatchRaw ?? (async () => { throw new Error('io.dispatch was not supplied by the runner — run --author through scripts/cynco-campaign.mjs') }),
    waitForDriver: helpers.waitForDriver ?? (async () => { throw new Error('io.waitForDriver was not supplied by the runner') }),
    missionIdFrom: helpers.missionIdFrom ?? (() => null),
    readRow: helpers.readRow ?? (() => null),
    dispatchEnv: helpers.dispatchEnv ?? ((base, extra) => ({ ...base, ...extra })),
    takeLock: helpers.takeLock ?? (() => ({ ok: true, path: null, pid: process.pid })),
    releaseLock: helpers.releaseLock ?? (() => {}),
  }
}

/**
 * The CLI. Returns an exit code; it never calls process.exit, so the runner
 * can route a verb into it and still own the process.
 */
export async function authorMain(argv, io = defaultAuthorIo()) {
  const flag = (n) => argv.indexOf(n)
  if (flag('--check') !== -1) {
    const i = flag('--check')
    const stagingDir = argv[i + 1], baseDir = argv[i + 2]
    if (!stagingDir || !baseDir || stagingDir.startsWith('--') || baseDir.startsWith('--')) {
      console.error('usage: bun scripts/cynco-gate-author.mjs --check <stagingDir> <baseDir>')
      return 2
    }
    const id = basename(norm(stagingDir))
    const check = await checkStaged({ id, stagingDir, baseDir, io })
    if (check.ok) { console.log(`[check] ${id}: PASS — ${check.lineIds.length} graded lines, BASE MISS, cheat stub honest, positive shim PASS`); return 0 }
    console.error(`[check] ${id}: REFUSED — ${check.problems.length} problem(s)`)
    for (const p of check.problems) console.error(`  ${p}`)
    return 1
  }
  if (flag('--author') !== -1) {
    const id = argv[flag('--author') + 1]
    if (!id || id.startsWith('--')) { console.error('usage: bun scripts/cynco-campaign.mjs <id>.campaign.json --author <id>'); return 2 }
    const roadmap = (io.loadRoadmap ?? (() => loadRoadmap(ROADMAP_PATH)))()
    const line = lineFor(roadmap, id)
    if (!line) { console.error(`[author] the roadmap has no line "${id}"`); return 2 }
    const state = (io.stateFor ?? defaultAuthorIo().stateFor)(id)
    // One runner per campaign, the wave runner's rule: two authoring missions
    // on one GPU is the same collision as two waves.
    const lock = io.takeLock(state.dir)
    if (!lock.ok) { console.error(`[author] another runner holds ${lock.path} (pid ${lock.pid}) — one runner per campaign`); return 2 }
    try {
      const r = await authorCampaign({ id, roadmap, state, io })
      if (r.ok) { console.log(`[author] ${id}: proposal ${r.proposal.name} raised (${r.check.lineIds.length} graded lines) — review the triple, then --approve-proposal ${r.proposal.name}`); return 0 }
      console.error(`[author] ${id}: no proposal — ${r.why}`)
      for (const p of r.check?.problems ?? []) console.error(`  ${p}`)
      return 1
    } finally { io.releaseLock(state.dir) }
  }
  console.error('usage: bun scripts/cynco-gate-author.mjs --check <stagingDir> <baseDir>')
  return 2
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  authorMain(process.argv.slice(2)).then(c => process.exit(c)).catch(e => { console.error(`[author] ${e?.stack ?? e}`); process.exit(1) })
}
