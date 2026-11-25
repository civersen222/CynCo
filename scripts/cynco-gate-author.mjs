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
import { basename, join, dirname, resolve, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFile } from 'node:child_process'
import { cyncoHome } from '../engine/paths.js'
import { ownedExec, ownProcessTree } from '../engine/processTree.js'
import { harnessAudit } from '../engine/audit/toolAudit.js'
import { MISSION_FIXED_RULE_LINES, SCRATCH_PHRASE } from '../engine/missionRule.js'
import { harnessGitEnv, isHarnessRefused } from '../engine/harnessGit.js'
import { frozenWriteRefusal } from '../engine/integrity.js'
import { calibrate, archiveBase, defaultIo as calibrateDefaultIo } from './cynco-campaign-calibrate.mjs'
import { runSync, faultSummary } from './cynco-spawn.mjs'
import { lintGate } from './cynco-gate-lint.mjs'
import { parseGateOutput } from './cynco-gate-parse.mjs'
import { loadCampaignSpec, checkIdentity } from './cynco-campaign-spec.mjs'
import { CIVKINGS_HOME } from './cynco-campaign-home.mjs'
import { sidecarPath } from './cynco-contract.mjs'
import { loadRoadmap, lineFor, nextOpenLine, setLineStatus, saveRoadmap, ROADMAP_PATH } from './cynco-roadmap.mjs'
import { CampaignState } from './cynco-campaign-state.mjs'
import { GATE_AUTHOR_MIN_LINES, GATE_AUTHOR_HELD_FLOOR } from './cynco-signal-validation.mjs'
import { readCampaigns } from './cynco-triples.mjs'
import { seatAuthority } from './cynco-proposals.mjs'

/** The twin of `dispatchLeftNothingRunning` in scripts/cynco-campaign.mjs (this module does not import the
 *  runner): dispatch-mission.sh exits non-zero only with its trap armed or before it started anything. */
const DISPATCH_LEFT_NOTHING_RUNNING = /^dispatch failed \(exit \d+\)/

// 4 h and 1200 iterations: the authoring mission writes four files and runs a
// check that costs two gate runs, so it is sized well below a wave's 8 h/2000.
export const AUTHOR_TIMEOUT_S = 14400
// A RESUME is a smaller job than an authoring, and the evidence says so: attempts
// 4 and 5 each burned four hours with three of the four files already finished,
// and attempt 5 spent 436 of 449 tool calls inspecting. A resume opens a staged
// triple, a brief naming exactly what the check refuses, and now a listing of the
// modules that exist; two hours is the bound on how long that is worth. Reached
// from attempt 2 onward.
export const AUTHOR_RESUME_TIMEOUT_S = 7200
export const AUTHOR_ITERATIONS = 1200

/** The wall clock this attempt gets: a fresh authoring's, or a resume's. */
export const authorTimeoutFor = (attempts) => (Number(attempts) >= 2 ? AUTHOR_RESUME_TIMEOUT_S : AUTHOR_TIMEOUT_S)
// The same 7,200,000 ms the sidecar assertion and the model's Bash tool get:
// the re-check is the identical command, so it gets the identical cap.
export const CHECK_SUBPROCESS_TIMEOUT_MS = 7_200_000
// Spec ruling 2: what 0.5 buys is sealing without waiting for the supervisor's
// approval. 1.0 is never granted — the human keeps the binding seat.
export const GATE_AUTHOR_MAX_AUTHORITY = 0.5
// `editGapCap` is three times a wave's 40, and the reason is the shape of the
// work: the authoring mission is three parts audit to one part writing, because
// it may not touch the game and cannot write a line until it knows what is
// absent. At 40 the live C9 run spent iterations arguing with the cap —
// `maxCallsWithoutSourceEdit 194`, 67 tool errors in 474 calls, and the model
// resorting to Grep because "Read is gated behind an edit". The commit gap is
// unchanged: committing after each cut is an order, not a side effect of editing.
export const AUTHOR_INVARIANTS = { editGapCap: 120, commitGapCap: 150, revertBan: true, codeIndexFirst: true }
// The invariants a WORKER wave of the sealed campaign runs under — c8's values,
// the measured ones. `AUTHOR_INVARIANTS` above is the authoring mission's own
// envelope and nothing else: its edit gap is tripled for an audit-shaped job,
// and a sealed spec that inherited it would let every wave of the campaign
// being graded push three times as long without an edit as the measured cap
// allows (review I1). `draftToSpec` writes these; the author never picks them.
export const WORKER_INVARIANTS = { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true }

// The bar the seat has to clear to earn that 0.5. Defined in
// `scripts/cynco-signal-validation.mjs` beside `DENIAL_MIN` — every threshold
// this project decides on lives in that one file (spec ruling 3) — and
// re-exported here so `gateAuthorPromotion` below and the `--gate-lines` table
// are reading one number each and not two. The dependency only runs this way:
// signal-validation must stay loadable under plain node, and this module
// reaches the bun-only grade chain through `calibrate`.
export { GATE_AUTHOR_MIN_LINES, GATE_AUTHOR_HELD_FLOOR }

// The gate author writes CivKings gates: its brief teaches the `gilded`
// package map and the CivKings exemplar gates, and its roadmap is CivKings'.
// So its home is the CivKings home, named once in scripts/cynco-campaign-home.mjs
// (the same defaults every spec without home keys gets), never spelled again
// here. A campaign on another repository brings a hand-written sealed gate.
const CIVKINGS_REPO = CIVKINGS_HOME.repo
const HELDOUT_FAMILY = CIVKINGS_HOME.heldoutFamily
const BRIEFS_DIR = CIVKINGS_HOME.briefsDir
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
    const init = io.run('git', ['init', stagingDir], { timeoutMs: 60_000, env: harnessGitEnv({}) })
    if (init.status !== 0) throw new Error(`git init ${stagingDir} failed: ${String(init.stderr).trim()}`)
  }
  // A repo with no identity is FATAL, not cosmetic: the mission is ordered to
  // commit after each cut, `git commit` refuses without a user, and
  // dispatch-mission.sh runs `git rev-parse` under `set -e` in the same tree.
  // Pin a local one so the author's only backup cannot fail on configuration.
  io.run('git', ['-C', stagingDir, 'config', 'user.name', 'cynco-author'], { timeoutMs: 60_000, env: harnessGitEnv({}) })
  io.run('git', ['-C', stagingDir, 'config', 'user.email', 'cynco@localhost'], { timeoutMs: 60_000, env: harnessGitEnv({}) })
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

/**
 * The one command that decides whether the authored triple is a bar.
 *
 * The script is named by ABSOLUTE path (F153). The brief tells the author to
 * run this from the staging dir, and the driver runs it in the mission cwd —
 * neither has a `scripts/` beside it, so a relative path made the acceptance
 * test unrunnable and the contract unfulfillable.
 */
export const SELF_SCRIPT = norm(fileURLToPath(new URL('./cynco-gate-author.mjs', import.meta.url)))

export function checkCommand(stagingDir, baseDir, selfScript = SELF_SCRIPT) {
  return `bun ${JSON.stringify(selfScript)} --check ${JSON.stringify(norm(stagingDir))} ${JSON.stringify(norm(baseDir))}`
}

/**
 * The inverse of `checkCommand` (decision sheet item 25): `{ stagingDir, baseDir }` when `command` is
 * exactly what `checkCommand` builds for `selfScript`, null for anything else (another script, a third
 * argument, a `;`, a backslash spelling, a relative folder). Exact by construction: the parts read are
 * built back with `checkCommand` and must give the same text, so the two cannot drift. The script is
 * this checkout's by `samePathText` (wave 19b, check A-R4: a runner started from a `c:\` spelling and a
 * driver loaded through Git Bash's `C:` name the same file), and the text is rebuilt with the command's
 * own spelling of it; the driver starts its own `SELF_SCRIPT` whatever the command spelled.
 */
export function parseCheckCommand(command, selfScript = SELF_SCRIPT) {
  const q = '("(?:[^"\\\\]|\\\\.)*")'
  const m = new RegExp(`^bun ${q} --check ${q} ${q}$`).exec(String(command ?? ''))
  if (!m) return null
  let parts
  try { parts = [m[1], m[2], m[3]].map(s => JSON.parse(s)) } catch { return null }
  const [script, stagingDir, baseDir] = parts
  if (script.includes('\\') || script.endsWith('/') || !samePathText(script, selfScript) || !stagingDir || !baseDir) return null
  if (!isAbsolute(stagingDir) || !isAbsolute(baseDir) || /[\0\r\n]/.test(script + stagingDir + baseDir)) return null
  if (checkCommand(stagingDir, baseDir, script) !== command) return null
  return { stagingDir, baseDir }
}

/**
 * Decision sheet item 25 (the owner, 2026-11-24: "Driver runs outside box"). The one mark of the
 * authoring dispatch, set only by `authorCampaign` below. A Bun at low integrity cannot load a module
 * from a folder not labelled low, so the acceptance check cannot start inside the box; with this mark
 * the mission driver runs it itself, at its own integrity, as a harness process. The dispatch reads it
 * and takes it out of its own environment, so only the driver is handed it, and the driver deletes it
 * from its own before it starts anything; every tool child drops it with the other `LOCALCODE_MISSION_*`
 * keys (`toolEnv`). Every other dispatch has no mark, and its check runs in the box as before.
 */
export const AUTHOR_CHECK_MARK = 'LOCALCODE_MISSION_AUTHOR_CHECK'

const samePathText = (a, b) => {
  const f = (p) => norm(p).replace(/\/+$/, '')
  return process.platform === 'win32' ? f(a).toLowerCase() === f(b).toLowerCase() : f(a) === f(b)
}

/**
 * What the driver does with the check of the dispatch it was handed (item 25). `{ kind: 'none' }`
 * without the mark: the check runs in the box, as before. `{ kind: 'run', stagingDir, baseDir }` with
 * the mark and the exact `checkCommand` of this checkout for the driver's own mission folder. Anything
 * else under the mark is `{ kind: 'refused', why }`, and the driver starts nothing.
 */
export function authorCheckPlan({ mark, checkCmd, markerCheck, probeCmd, cwd, selfScript = SELF_SCRIPT }) {
  if (mark === undefined || mark === null || mark === '') return { kind: 'none' }
  const refused = (why) => ({ kind: 'refused', why: `the authoring dispatch's mark (${AUTHOR_CHECK_MARK}) ${why}, so nothing is run outside the box` })
  if (mark !== '1') return refused(`is ${JSON.stringify(mark)}, not "1"`)
  if (markerCheck) return refused('came with a marker check on its own channel (CYNCO_MARKER_CHECK), which the gate-authoring script never sets')
  if (probeCmd) return refused('came with a probe command, which the gate-authoring script never sets')
  const parsed = parseCheckCommand(checkCmd, selfScript)
  if (!parsed) return refused(`came with a check command that is not the one this checkout's ${basename(selfScript)} builds (${JSON.stringify(String(checkCmd ?? ''))})`)
  if (!cwd || !samePathText(parsed.stagingDir, cwd)) return refused(`came with a check command for another mission folder (${parsed.stagingDir}, not ${norm(cwd ?? '')})`)
  return { kind: 'run', stagingDir: parsed.stagingDir, baseDir: parsed.baseDir }
}

/** How often the driver's own run of the check asks the integrity latch (plan P6 item 6). */
export const AUTHOR_CHECK_LATCH_POLL_MS = 30_000

/**
 * The acceptance check, run by the mission driver as a harness process (item 25): this checkout's
 * own script, by argument vector (no shell), with Bun's `--no-install`, from the checkout (so no
 * `bunfig.toml` or `.env` the mission wrote is read), its process tree owned from its start
 * (`ownedExec`), under the cap, and with the latch asked every `pollMs`: a latch, or a guard folder
 * that became unusable, ends the tree. What the check starts is unchanged: its gate runs go into the
 * box (calibration's own sandbox around the BASE archive) and are recorded (`authorRunOpts`).
 *
 * The result has `runCheckAsync`'s shape (`scripts/cynco-verify.mjs`). The check is asked for its
 * `--json` verdict (wave 19b, check A-R5): `verified` is true only for exit 0 with its `PASS` line and a
 * verdict that says ok, and false only for exit 1 with its `REFUSED` line and a verdict that does not;
 * an exit 0 or 1 without both is a harness fault ("the check ended without its verdict"), because a
 * tree ended from outside also exits 1 on Windows. A check that was cut (the cap, the latch, an
 * overrun), that could not start, or that refused its own arguments (exit 2) is null with a
 * `harnessFault`: "did not run", never failed or passed. `integrity` carries the guard's state when
 * the latch or an unusable guard ended it, or was seen while the check ended by itself (wave 19c). `audit` is `{ handle, src }`: the start is written before
 * anything starts, and a start that cannot be written starts nothing.
 *
 * A correct triple ends as a correct triple (wave 19b, check A-F1): the check runs while this run's
 * integrity baseline is open, so calibration may not write the suite baseline (the held-out folder is
 * frozen) and says so as its only problem. That is no failure of the triple and no note to the model:
 * `verified` stays null, `baselineOwed` is true, and `harnessFault` says what was shown and that the
 * authoring runner's check after the run takes the baseline and gives the verdict (`authorCampaign`
 * waits for the run's settle first). The JSON line is not kept in `output`, so a note never carries it.
 */
export async function runAuthorCheck({ stagingDir, baseDir, timeoutMs, ordinal = null, latch = () => null, audit = null }, hooks = {}) {
  const t0 = Date.now()
  const selfScript = hooks.selfScript ?? SELF_SCRIPT
  const bun = hooks.bun !== undefined ? hooks.bun : (process.versions?.bun ? process.execPath : null)
  const args = ['--no-install', selfScript, '--check', norm(stagingDir), norm(baseDir), '--json']
  const cwd = norm(dirname(dirname(selfScript)))
  const notRun = (why, extra = {}) => {
    const output = `[check] HARNESS FAULT: ${why}`
    return { verified: null, exitCode: null, timedOut: false, spawnFailed: true, harnessFault: why, durationMs: Date.now() - t0, outputTail: output, output, integrity: null, ...extra }
  }
  const poll = latchPoll(latch, hooks.pollMs)
  const before = poll.ask()
  if (before) return notRun(`${guardWords(before)} before the check started; nothing was run`, { integrity: before })
  if (!bun) return notRun('the driver is not running under Bun, so the check was not started')
  const started = audit ? audit.handle.start({ src: audit.src, command: [bun, ...args].join(' '), cwd }) : null
  if (started && !started.ok) return notRun(`[tool-audit] not run: ${started.reason}`)
  const env = { ...process.env, ...(ordinal !== null ? { CYNCO_CHECK_ORDINAL: String(ordinal) } : {}) }
  delete env[AUTHOR_CHECK_MARK]
  poll.start()
  let end
  try {
    end = await (hooks.ownedExec ?? ownedExec)(
      // Spelled as a call of execFile so the wiring guard's scan counts it (SPAWN_SITES).
      (cb) => {
        const o = { cwd, env, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        return hooks.execFile ? hooks.execFile(bun, args, o, cb) : execFile(bun, args, o, cb)
      },
      { capMs: timeoutMs, own: hooks.own ?? ownProcessTree, signal: poll.signal, ...(hooks.graceMs !== undefined ? { graceMs: hooks.graceMs } : {}) })
  } catch (e) {
    poll.stop()
    const r = notRun(`the check could not be started (${e?.code ?? e?.message ?? e})`)
    if (started?.ok) audit.handle.end(started.call, { isError: true, exitCode: null, ms: r.durationMs, output: r.output })
    return r
  }
  poll.stop()
  const cutBy = poll.cutBy()
  const durationMs = Date.now() - t0
  const code = typeof end.err?.code === 'number' ? end.err.code : (end.err ? null : 0)
  let harnessFault = null
  if (end.stopped && cutBy) harnessFault = latchCutWords(cutBy)
  else if (end.timedOut) harnessFault = `timed out after ${timeoutMs}ms`
  else if (end.overran) harnessFault = 'the check printed more than the driver keeps, so its process tree was ended'
  else if (code === null) harnessFault = `the check could not be started (${end.err?.code ?? end.err?.message ?? 'no exit code'})`
  else if (code === 2) harnessFault = 'the check refused its own arguments (exit 2)'
  else if (code !== 0 && code !== 1) harnessFault = `the check ended with exit ${code}, which it never gives for a verdict`
  const said = checkVerdictOf(`${end.stdout ?? ''}${end.stderr ?? ''}`, basename(norm(stagingDir)))
  let baselineOwed = false
  if (!harnessFault) {
    const wanted = code === 0 ? 'PASS' : 'REFUSED'
    if (said.headline !== wanted || !said.verdict || said.verdict.ok !== (code === 0)) {
      harnessFault = `the check ended with exit ${code} without its verdict (its "[check] <id>: ${wanted}" line and a ${CHECK_JSON_MARKER.trim()} line that agrees), so it is not read as ${code === 0 ? 'passed' : 'failed'}`
    } else if (code === 1 && said.verdict.problems.length > 0 && said.verdict.problems.every(p => String(p).startsWith(BASELINE_NOT_WRITTEN))) {
      baselineOwed = true
      harnessFault = BASELINE_OWED
    }
  }
  const output = said.text + (harnessFault ? `\n[check] HARNESS FAULT: ${harnessFault}` : '')
  if (started?.ok) audit.handle.end(started.call, { isError: code !== 0, exitCode: code, ms: durationMs, output })
  return {
    verified: harnessFault ? null : code === 0, exitCode: code, timedOut: Boolean(end.timedOut), spawnFailed: code === null && !end.timedOut && !end.stopped,
    // Wave 19c (check CB-A-2): the latch the poll saw is carried even when the check ended by itself in the same window.
    harnessFault, durationMs, outputTail: output.slice(-2000), output, integrity: cutBy ?? null, baselineOwed,
  }
}

/** Calibration's own words when the held-out folder is frozen (`scripts/cynco-campaign-calibrate.mjs`). */
export const BASELINE_NOT_WRITTEN = 'suite baseline not written: '

/** What the driver says of a check whose only problem is the frozen suite baseline (check A-F1). */
export const BASELINE_OWED = 'not a failure: the triple passed its lint and every gate run; its only problem is that the suite baseline '
  + 'was not written while this run\'s integrity baseline is open (the held-out folder is frozen), which the model cannot fix. '
  + 'Still owed: the authoring runner\'s check after the run, once the run has settled, takes the suite baseline and gives the verdict'

/**
 * What a `--check` run said (wave 19b): `headline` is PASS or REFUSED from its own `[check] <id>: ...`
 * line at a line's start, `verdict` the last `--json` line read whole (`{ ok, problems }`) or null, and
 * `text` the output with every JSON line taken out (the tails are for the runner, never for a note).
 */
export function checkVerdictOf(out, id) {
  const lines = String(out ?? '').split(/\r?\n/)
  const head = new RegExp(`^\\[check\\] ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (PASS|REFUSED)(?: |$)`)
  const headline = lines.map(l => head.exec(l)?.[1]).find(Boolean) ?? null
  const json = lines.filter(l => l.startsWith(CHECK_JSON_MARKER))
  let verdict = null
  if (json.length) {
    try {
      const v = JSON.parse(json[json.length - 1].slice(CHECK_JSON_MARKER.length))
      if (v && typeof v.ok === 'boolean' && Array.isArray(v.problems)) verdict = { ok: v.ok, problems: v.problems }
    } catch { verdict = null }
  }
  return { headline, verdict, text: lines.filter(l => !l.startsWith(CHECK_JSON_MARKER)).join('\n') }
}

export function guardWords(s) {
  return s.state === 'unusable' ? `the integrity guard became unusable (${s.summary})` : `the integrity latch was set (${s.summary})`
}

/** The harness fault of a check whose tree the latch poll ended. */
export function latchCutWords(s) {
  return `${guardWords(s)} while the check ran: its process tree was ended and the check did not run to its end`
}

/**
 * The latch asked while a check runs (plan P6 item 6), shared by the driver's own run of the authoring check
 * and its in-box marker check (wave 19b). `ask()` is the guard's state when it is not clear, else null; a latch
 * that throws is a guard that cannot be asked (check A-R7), never an uncaught throw in a timer. `start()` asks
 * every `pollMs`; the first state that is not clear is kept (`cutBy()`) and aborts `signal`, which the caller
 * hands the check's spawn so its tree is ended. `stop()` ends the asking.
 */
export function latchPoll(latch, pollMs = AUTHOR_CHECK_LATCH_POLL_MS) {
  const stopper = new AbortController()
  let cutBy = null
  let timer = null
  const ask = () => {
    let s
    try { s = latch() } catch (e) { s = { state: 'unusable', summary: `the latch could not be asked (${e?.message ?? e})` } }
    return s && s.state && s.state !== 'clear' ? s : null
  }
  return {
    ask,
    signal: stopper.signal,
    cutBy: () => cutBy,
    start: () => { timer = setInterval(() => { const s = ask(); if (s && !cutBy) { cutBy = s; stopper.abort() } }, pollMs ?? AUTHOR_CHECK_LATCH_POLL_MS) },
    stop: () => { if (timer) clearInterval(timer); timer = null },
  }
}

/**
 * The options of a run the authoring io starts (plan P6 item 7): a contained run (the check's gate,
 * perturb, positive and baseline runs) is recorded in the tool-call audit with src 'gate' and the run id
 * of its own containment, as calibration's own io records it; until wave 19 the authoring io's `run`
 * replaced calibration's and none of them was recorded.
 */
export function authorRunOpts(opts = {}) {
  return opts.contained ? { ...opts, audit: { forRun: (run) => harnessAudit({ run }), src: 'gate' } } : opts
}

/**
 * The relative specifiers a module's STATIC imports and re-exports name —
 * `import … from './x.mjs'`, `export … from './x.mjs'`, `import './x.mjs'`.
 * Dynamic `import()` is deliberately not followed: it is not what `--check`
 * loads on the path the acceptance test runs.
 */
export function staticRelativeImports(src) {
  const out = new Set()
  const re = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g
  for (const m of String(src).matchAll(re)) out.add(m[1])
  return [...out]
}

/**
 * Review I4: the acceptance test's own code — `cynco-gate-author.mjs` and every
 * module it statically imports from `scripts/`, transitively (lint, parse,
 * calibrate, grade, spawn, …). Derived from the source, never listed by hand,
 * so a new import joins the closure without anyone remembering to add it.
 *
 * From a `scripts/` module two kinds of import are followed: same-directory
 * ones (`./x.mjs`) and `../engine/…` ones. `--check` statically loads engine
 * modules whose top-level code runs in the subprocess — `engine/paths.ts`,
 * `engine/bridge/contractAutoCreate.ts`, `engine/tools/contractVerify.ts` (and
 * through them `tools/contract`, `tools/shellInfo`, `training/gitFacts`), and
 * `engine/cybernetics-core` — and a mission that edited one of them could
 * forge the check's verdict. So they are in the closure (Phase 4 closed the
 * Phase 3 residual that stopped the walk at `scripts/`). An engine module's own
 * relative imports are followed anywhere under the repo root. A `.js`
 * specifier whose file does not exist resolves to the `.ts`, then the `.tsx`,
 * beside it (the engine is TypeScript imported by its emitted name); any path
 * through `node_modules` is skipped — third-party code is pinned by the
 * lockfile, not by this hash. Every followed path, from either branch, must
 * stay under the repo root.
 *
 * LIMIT: only static relative `import …` / `export … from` / `import '…'` are
 * followed (`staticRelativeImports`). Dynamic `import()`, `require()`, and
 * bare or package specifiers are not; none occur in the engine files the
 * closure reaches today (checked when the engine walk landed), so a new one
 * would sit outside the hash until this walk learns it.
 */
export function harnessClosure(entry = SELF_SCRIPT, readFile = (p) => readFileSync(p, 'utf8'), exists = existsSync) {
  const scriptsDir = norm(dirname(entry))
  const repoRoot = norm(dirname(scriptsDir))
  const seen = new Set()
  const queue = [norm(entry)]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const fromScripts = dirname(file) === scriptsDir
    for (const spec of staticRelativeImports(readFile(file))) {
      const raw = norm(resolve(dirname(file), spec))
      if (raw.split('/').includes('node_modules')) continue
      // Both branches are bounded to the repo root: `../engine/../../x.mjs`
      // starts with `../engine/` and still lands outside it.
      if (!raw.startsWith(repoRoot + '/')) continue
      if (fromScripts && dirname(raw) !== scriptsDir && !spec.startsWith('../engine/')) continue
      const target = resolveModuleFile(raw, exists)
      if (target) queue.push(target)
    }
  }
  return [...seen].sort()
}

/**
 * The file a specifier names, or null when none exists: the path itself when
 * it carries a module extension (for `.js`, else the `.ts` then `.tsx` beside
 * it); an extensionless specifier (`'../types'`, which `engine/cybernetics-core`
 * uses throughout) resolves the way bun does — `.ts`, `.tsx`, `.js`, `.mjs`,
 * then the directory's `index.ts` / `index.tsx` / `index.js`. A bare directory
 * path is never returned: it is not a module and cannot be read.
 */
function resolveModuleFile(target, exists) {
  const candidates = /\.(?:[cm]?js|[cm]?ts|tsx|json)$/.test(target)
    ? [target, ...(target.endsWith('.js') ? [target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx'] : [])]
    : ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map(ext => target + ext)
  return candidates.find(c => exists(c)) ?? null
}

/**
 * The key a closure file is fingerprinted under: its bare name inside
 * `scripts/` (the names every stored fingerprint already uses), its
 * repo-relative path anywhere else — `engine/tools/contract.ts` and a
 * `scripts/contract.mjs` must never collide on a basename.
 */
export function harnessFileKey(file, entry = SELF_SCRIPT) {
  const scriptsDir = norm(dirname(entry))
  const f = norm(file)
  if (dirname(f) === scriptsDir) return basename(f)
  return f.slice(norm(dirname(scriptsDir)).length + 1)
}

/**
 * One fingerprint of the harness closure: a sha256 per file (keyed by
 * `harnessFileKey`) and one over the lot. Taken at dispatch and stored on
 * `state.authoring[id]`; re-taken before the runner believes the check.
 */
export function harnessFingerprint(entry = SELF_SCRIPT, readBytes = (p) => readFileSync(p)) {
  const files = {}
  for (const f of harnessClosure(entry)) files[harnessFileKey(f, entry)] = createHash('sha256').update(readBytes(f)).digest('hex')
  const sha256 = createHash('sha256').update(Object.keys(files).sort().map(k => `${k} ${files[k]}\n`).join('')).digest('hex')
  return { sha256, files }
}

/** The closure files that differ between two fingerprints — changed, added or removed. */
export function harnessDirtyFiles(recorded, current) {
  if (!recorded || !current || recorded.sha256 === current.sha256) return []
  const a = recorded.files ?? {}, b = current.files ?? {}
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort()
}

/**
 * The well-formed `{ file, line, problem }` entries of a check's `at` list —
 * it crosses a process boundary as JSON, so anything else is dropped rather
 * than printed as `at undefined:NaN` in a brief.
 */
export function atEntries(at) {
  if (!Array.isArray(at)) return []
  return at.filter(a => a && typeof a.file === 'string' && Number.isInteger(a.line) && a.line > 0 && typeof a.problem === 'string')
    .map(({ file, line, problem }) => ({ file, line, problem }))
}

/** The marker the `--check` CLI prints its machine-readable verdict behind. */
export const CHECK_JSON_MARKER = '[check-json] '

/**
 * The AUTHORITATIVE re-check, run as a SUBPROCESS (F155).
 *
 * `authorCampaign` used to call `checkStaged` in-process after
 * `io.waitForDriver` returned, and that is where the live C9 authoring run got
 * eleven problems out of a triple with two: the runner's previous spawn was four
 * hours earlier, and bun's stale `spawnSync` deadline killed the first gate run
 * in milliseconds. A fresh process cannot carry a stale deadline into its first
 * spawn, and the `--check` CLI path is the one that read this triple correctly
 * four times in a row — from the driver, and by hand from two different cwds.
 *
 * The verdict comes from the exit code; the detail comes from the JSON line the
 * CLI prints. A missing JSON line is not fatal: the exit code still decides, and
 * the captured output is carried as the problem text so nothing is silently lost.
 */
export async function checkStagedViaSubprocess({ id, stagingDir, baseDir, io, timeoutMs = CHECK_SUBPROCESS_TIMEOUT_MS, harness = null }) {
  // Review I4: the subprocess runs the harness's OWN code — this file and its
  // `scripts/` imports — and none of that is sealed. A mission with Bash could
  // rewrite `compareCalibration` so this very check prints PASS. `harness` is
  // the fingerprint taken at dispatch; if the closure has changed since, the
  // instrument is not the one the mission was dispatched under and its reading
  // is not evidence. Nothing is run: the triple is UNGRADED (`kind: 'fault'`),
  // and the files that moved are named so the operator can see who moved them.
  if (harness) {
    const dirty = harnessDirtyFiles(harness, (io.harnessHash ?? harnessFingerprint)())
    if (dirty.length) {
      return { ok: false, problems: [`harness dirty: ${dirty.join(', ')} — the acceptance test's own code changed since dispatch; the triple was not graded`],
        lineIds: [], tails: null, calibration: null, fault: null, harnessDirty: true, harnessDirtyFiles: dirty }
    }
  }
  // `--json` asks for the tails; the brief's DONE WHEN command deliberately does
  // not, so the model's own runs stay short. `--no-install` (wave 19b): Bun never
  // fetches a package by itself.
  const args = ['--no-install', SELF_SCRIPT, '--check', norm(stagingDir), norm(baseDir), '--json']
  const r = io.run('bun', args, { timeoutMs, retryImpossibleTimeout: true })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.fault) {
    return { ok: false, problems: [`harness fault: the re-check subprocess did not run (${faultSummary(r.fault)}) — the triple was not graded`],
      lineIds: [], tails: null, calibration: null, fault: r.fault }
  }
  if (r.timedOut) {
    return { ok: false, problems: [`the re-check subprocess timed out after ${timeoutMs} ms — the triple was not graded`],
      lineIds: [], tails: null, calibration: null, fault: null }
  }
  const line = out.split(/\r?\n/).reverse().find(l => l.includes(CHECK_JSON_MARKER))
  let parsed = null
  if (line) {
    try { parsed = JSON.parse(line.slice(line.indexOf(CHECK_JSON_MARKER) + CHECK_JSON_MARKER.length)) } catch { parsed = null }
  }
  if (parsed) {
    return { ok: r.status === 0 && parsed.ok === true, problems: Array.isArray(parsed.problems) ? parsed.problems : [],
      at: atEntries(parsed.at),
      lineIds: Array.isArray(parsed.lineIds) ? parsed.lineIds : [], tails: parsed.tails ?? null, calibration: null, fault: null }
  }
  const ok = r.status === 0
  return { ok, problems: ok ? [] : [`the re-check subprocess exited ${r.status ?? 'null'} without a ${CHECK_JSON_MARKER.trim()} verdict; its output was:\n${out.trim().slice(-4000)}`],
    lineIds: [], tails: null, calibration: null, fault: null }
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
 * What the BASE archive actually contains, LISTED — never named from memory.
 *
 * The live C9 authoring run failed four times in a row on one thing: the positive
 * shim imported `gilded.ui.views`, a module that does not exist. The model's own
 * audit named the problem correctly at least four times and it wrote the import
 * again each time, including on the attempt whose brief showed it the traceback.
 * Telling it the module is absent evidently does not stick; showing it the set of
 * modules that are present is a different instrument, and it is free — the tree
 * is on disk and `io.listDir` can read it.
 *
 * Nothing here is authored. Every name comes from `listDir`, so the map cannot
 * be wrong about the tree in the way a hand-written list would eventually be, and
 * a module the tree does not have can never appear in it.
 */
export function readPackageMap({ baseDir, io }) {
  const base = norm(baseDir)
  const pys = (dir) => (io.listDir(dir) ?? []).filter(n => n.endsWith('.py')).sort()
  const root = `${base}/gilded`
  const rootPys = pys(root)
  if (rootPys.length === 0) return null
  // A subpackage is a directory holding at least one .py — `assets/` is data and
  // `__pycache__/` is noise, and neither is something a shim can import.
  const subpackages = (io.listDir(root) ?? [])
    .filter(n => !n.endsWith('.py') && n !== '__pycache__')
    .filter(n => pys(`${root}/${n}`).length > 0)
    .sort()
  return { root: rootPys, ui: pys(`${root}/ui`), subpackages }
}

/** The PACKAGE MAP subsection, or an empty string when the tree could not be read. */
export function packageMapText(map) {
  if (!map || !map.root?.length) return ''
  const wrap = (names) => {
    const lines = []
    let cur = '   '
    for (const n of names) {
      if (cur.length + n.length + 1 > 76) { lines.push(cur); cur = '   ' }
      cur += ` ${n}`
    }
    if (cur.trim()) lines.push(cur)
    return lines.join('\n')
  }
  const out = ['PACKAGE MAP (listed from the BASE archive — these modules exist; nothing else under gilded/ui does)', '',
    '  gilded/', wrap(map.root)]
  if (map.subpackages?.length) out.push('', '  gilded/ subpackages:', wrap(map.subpackages.map(s => `${s}/`)))
  if (map.ui?.length) out.push('', '  gilded/ui/', wrap(map.ui))
  out.push('', 'There is no `gilded.ui.views`. Import only modules named here; a shim that',
    'imports a module absent from this map cannot pass.')
  return out.join('\n')
}

/**
 * The authoring order, deterministic and golden-tested.
 *
 * Nine sections in a fixed order; PREVIOUS CHECK OUTPUT appears only on a
 * resume, where it is the single most useful thing in the file — the last run
 * already discovered which of these rules it broke.
 */
export function authoringBrief({ line, id, prevId, baseDir, stagingDir, exemplar, previousCheck = null, restoreNote = null, packageMap = null, timeoutS = AUTHOR_TIMEOUT_S, supervisorNote = null }) {
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
(${Math.round(timeoutS / 3600)} hours, ${AUTHOR_ITERATIONS} iterations.)`))

  out.push(section('THE ROADMAP LINE',
`  ${line.id} — ${line.name}
  ${line.bar}
  BASE ${line.base}`))

  out.push(section('THE GAME AT BASE',
`The game is Python (pygame). A read-only archive of the repository at BASE is
at

  ${base}

Your files never move there: you hand that path to your gate through the
CYNCO_GATE_REPO variable described below. It is READ-ONLY: nothing you write
there is graded, nothing you change there survives, and the campaign worker
will never see it.
Your own four files go in ${staging}.

Headless conventions (the gate runs with no display and no sound card):

  set SDL_VIDEODRIVER=dummy and SDL_AUDIODRIVER=dummy before importing pygame
  state = gilded.ui.app.new_app_state(seed=N)      # the whole game, one call
  a draw is: view.regions cleared, then view.draw(screen)
  a press is: view.handle_click(region.rect.center), then
              gilded.ui.app._apply_action(state, action)

Audit the game at BASE before you write a single check. Every line you write
must FAIL there, and it must fail because the feature is ABSENT — not because
your check crashed.

${packageMapText(packageMap)}`))

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
    in, not the tree it was handed. Import the game through that variable —
    \`sys.path.insert(0, REPO)\` immediately after the REPO line, exactly as the
    example gate quoted at the end of this brief does. Run your own gate from
    the staging dir with that variable set, never by cd-ing into the BASE
    archive:
      CYNCO_GATE_REPO=${base} python gate_${id}.py
    Your Bash tool runs under powershell.exe, so in practice that is
      $env:CYNCO_GATE_REPO='${base}'; python gate_${id}.py
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
`Fixed rule — ${MISSION_FIXED_RULE_LINES[0]}

Fixed rule — ${MISSION_FIXED_RULE_LINES[1]}

Where this brief says scratch folder it means ${SCRATCH_PHRASE}.

Rule 11 — the BASE must MISS. Run the gate against ${base}
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
              brief that names its own instrument. Where the gate runs the
              game in folders it makes for itself (a temporary working
              directory, empty stand-ins for the user's folders, a new
              cache), say that the grader makes them and throws them away,
              name the variable or call that points the program at each, and
              never word them as a state for the worker to produce: a
              worker's own clean start is new empty folders inside its
              scratch folder, never an existing folder emptied (F242).
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

  if (previousCheck || restoreNote) {
    const body = []
    if (restoreNote) body.push(noSealedPath(restoreNote))
    if (previousCheck) {
      body.push(
`The last authoring run left the triple in ${staging} and the check REFUSED it.
These are its words, from the PREVIOUS run. The harness runs the check again
when your turn ends (DONE WHEN, below) and tells you where the triple stands
then. Fix what it reports; do not start over.

${noSealedPath(previousCheck)}`)
    }
    out.push(section('PREVIOUS CHECK OUTPUT', body.join('\n\n')))
  }

  // Right after the check output, and deliberately so: the check says the triple
  // is a bar, and this says a person read it and disagreed. A green check is not
  // an answer to any line below.
  if (supervisorNote) {
    out.push(section('SUPERVISOR REVIEW — the seal was refused; every line below must be fixed before the check can count',
`A supervisor read the staged triple and REFUSED to seal it. The mechanical check
may already pass — it did when this was written — and that is not the question.
The question is whether the gate MEASURES the roadmap line. These are the
supervisor's words, one problem per line; treat each as an order.

${noSealedPath(supervisorNote)}

When you are done, the check must still exit 0 AND every line above must be
addressed. Re-read THE ROADMAP LINE before you start: this is a re-authoring of
what the gate means, not a repair of the shim.`))
  }

  out.push(section('DONE WHEN',
`  ${checkCommand(staging, base)}

This is the acceptance check, and the harness runs it, not you: when your turn
ends it runs this exact command outside your mission and, if it fails, sends
you its failures once. Running it from inside the mission is refused. It exits
0 only when the lint finds no problems AND Rule 11 holds at BASE (terminator
MISS, every line failing by absence, zero error lines) AND Rule 14 holds
(positive_${id}.py prints GATE: PASS with zero error lines) AND the perturb's
EXPECT-FLIP / MUST-FAIL header matches what the stub actually does. Any other
exit code prints the problems; fix those and end your turn again.

Commit in ${staging} after each cut — it is the only backup you have. When you
believe the triple passes, commit it with this in the commit message, then say
it as the last thing you say, and end your turn:

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
  const paths = stagedPaths(id, dir)
  const missing = Object.entries(paths).filter(([, p]) => !io.exists(p)).map(([, p]) => basename(p))
  if (missing.length) return { ok: false, problems: missing.map(f => `missing: ${f} was never written into the staging dir`), lineIds: [], calibration: null }
  if (!io.exists(baseDir)) return { ok: false, problems: [`missing: the BASE archive ${norm(baseDir)} does not exist — re-run --author to rebuild it`], lineIds: [], calibration: null }

  const lint = lintGate({ campaignId: id, gatePath: paths.gate, perturbPath: paths.perturb, positivePath: paths.positive, io: { readFile: io.readFile } })
  const spec = { id, gate: paths.gate, perturb: paths.perturb, positive: paths.positive, base: norm(baseDir), repo: null,
    suiteBaseline: `${dir}/suite_baseline_${id}.txt` }
  const calibration = await calibrate(spec, calibrationIo(io), { baseDir: norm(baseDir) })
  const problems = [...lint.problems, ...calibration.problems]
  // `at`: the lint problems that name a line (Phase 4 residual) — the resume
  // brief prints a FILE:LINE under each. Calibration problems name their file
  // but read no single line, so they carry none.
  return { ok: problems.length === 0, problems, at: lint.at ?? [], lineIds: lint.lineIds, calibration }
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

/**
 * The SEAT's authority, not one campaign's.
 *
 * The two ends of the ladder live in different state files, and that is not an
 * accident of layout: the promotion is approved into the RUNNING campaign's
 * state (`~/.cynco/campaigns/c8/state.json`, where the evidence was gathered),
 * while the auto-approve branch below runs inside the campaign being AUTHORED
 * (`.../c9/state.json`, which is fresh). Reading only the local state, an
 * earned 0.5 would never reach a single seal.
 *
 * Controller ruling: the gate-author seat is one seat across every campaign, so
 * its authority is the HIGHEST approved anywhere.
 *
 * Phase 4: the per-seat retained-configuration store
 * (`<home>/retained/seats.json`, scripts/cynco-proposals.mjs) is now where an
 * approval lands, so the reading is the max of the store and every campaign's
 * state — the campaign states still hold every approval made before the store
 * existed. The store's home defaults to the directory the campaigns dir sits
 * in (`~/.cynco/campaigns` → `~/.cynco`); `seatsHome` overrides it.
 *
 * The cost is stated rather than hidden: a `gate-author/gate` REJECTED in one
 * campaign does not pull down a higher value approved in another, nor the
 * store's. The owner's lever for that is to lower the approved value where it
 * was approved (and in the store).
 */
export function gateAuthorAuthorityAcrossCampaigns(campaignsDir = join(cyncoHome(), 'campaigns'), { seatsHome = dirname(campaignsDir) } = {}) {
  let max = seatAuthority(seatsHome, 'gate-author')
  for (const { state } of readCampaigns(campaignsDir)) {
    const v = state?.gateAuthorAuthority
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v
  }
  return max
}

/**
 * Ruling 11: the promotion the gate-line evidence earns, or null.
 *
 * Same shape and the same discipline as the ideation promotion
 * (`promotionProposal` in scripts/cynco-ideation.mjs): a data-shaped Parameter
 * proposal the owner approves, never an authority the seat grants itself. What
 * it buys is `authorCampaign`'s auto-approve branch below — sealing without
 * waiting for the supervisor — and it is bounded at 0.5 forever.
 *
 * Three bars, all of them over TERMINAL gate lines (scripts/cynco-gate-lines.mjs):
 *
 *   1. at least `GATE_AUTHOR_MIN_LINES` CynCo lines have finished a campaign,
 *   2. the Wilson lower bound on their held rate is at or above
 *      `GATE_AUTHOR_HELD_FLOOR` — the interval, not the point estimate, and
 *   3. it is not significantly worse than the human seat (Fisher two-sided at
 *      `alpha`, and only in that direction: a seat that is significantly
 *      BETTER must not be refused by its own evidence).
 *
 * `{ explain: true }` returns `{ proposal, why }` instead — the reason the bar
 * was not cleared, for a verdict line or an operator asking why nothing came.
 * The plain call keeps the proposal-or-null contract every other proposal has.
 */
export function gateAuthorPromotion(summary, currentAuthority, alpha = 0.05, { explain = false } = {}) {
  const out = (proposal, why) => (explain ? { proposal, why } : proposal)
  if ((currentAuthority ?? 0) >= GATE_AUTHOR_MAX_AUTHORITY) return out(null, `authority is already ${currentAuthority} — 0.5 is the ceiling and the human keeps the binding seat`)
  const c = summary?.byAuthor?.cynco
  if (!c) return out(null, 'no gate-line summary — nothing has been exported yet')
  if (c.n < GATE_AUTHOR_MIN_LINES) return out(null, `only ${c.n} terminal CynCo gate line(s); ${GATE_AUTHOR_MIN_LINES} are needed`)
  if (c.ci[0] < GATE_AUTHOR_HELD_FLOOR) return out(null, `held rate ${c.held}/${c.n} has a Wilson lower bound of ${c.ci[0].toFixed(3)}, below the ${GATE_AUTHOR_HELD_FLOOR} floor`)
  const p = summary?.fisher?.p ?? null
  const humanRate = summary?.byAuthor?.human?.rate ?? null
  if (p !== null && p < alpha && humanRate !== null && c.rate < humanRate) {
    return out(null, `CynCo holds ${(c.rate * 100).toFixed(1)}% against the human's ${(humanRate * 100).toFixed(1)}% at p=${p.toFixed(4)} — significantly worse than the human seat`)
  }
  return out({
    type: 'Parameter', name: 'gate-author/gate', newValue: GATE_AUTHOR_MAX_AUTHORITY,
    bounds: { min: 0, max: GATE_AUTHOR_MAX_AUTHORITY }, status: 'pending',
    evidence: { n: c.n, held: c.held, rate: c.rate, ci: c.ci, p, humanRate, table: summary?.fisher?.table ?? null },
  }, null)
}

/**
 * One harness git in the staging folder that writes its work tree or reads it into a commit or a patch
 * (wave 19, A3): `{ worktreeLinks: true }`, so a link in the tree that leads outside it, or a tree that
 * cannot be read, refuses the call. A refused call is not started at all (`git apply` applies a patch
 * through a refused `GIT_DIR`, measured by the harness-children builder): `{ refused }` with the reason
 * harness git logged, which every caller names and never reads as a success.
 */
function stagingTreeGit(io, dir, args) {
  const env = harnessGitEnv({}, { repo: dir, worktreeLinks: true })
  if (isHarnessRefused(env)) {
    return { refused: `harness git refused the staging folder ${dir} (the [harness-git] line says why), so git ${args[0]} was not run`, status: null, stdout: '', stderr: '' }
  }
  return io.run('git', ['-C', dir, ...args], { timeoutMs: 60_000, env })
}

function commitStaging(stagingDir, message, io) {
  // F242: the staging folder is the authoring mission's own, so the harness's git there runs with its
  // hooks, monitor and repository-defined filters off and the work tree pinned.
  const dir = norm(stagingDir)
  const r = stagingTreeGit(io, dir, ['add', '-A'])
  if (r.refused) { console.error(`[author] REFUSED: ${r.refused}; nothing was committed`); return }
  if (r.status !== 0) { console.error(`[author] git add in ${dir} failed: ${String(r.stderr).trim()}`); return }
  const c = stagingTreeGit(io, dir, ['commit', '-m', message])
  if (c.refused) { console.error(`[author] REFUSED: ${c.refused}; nothing was committed`); return }
  // "nothing to commit" is exit 1 and is not a fault: a resume that changed
  // nothing but the brief number still has a brief to dispatch.
  if (c.status !== 0 && !/nothing to commit/i.test(String(c.stdout) + String(c.stderr))) {
    console.error(`[author] git commit in ${norm(stagingDir)} failed: ${String(c.stderr).trim()}`)
  }
}

/**
 * The graded ids the positive shim leaves FAILing, from its output tail.
 *
 * Rule 14's failure is never "the shim did not PASS" in any useful sense — it is
 * a list of facts the shim never made true, and that list is the resume brief's
 * whole content. `[]` for a tail that produced nothing (a crash before the first
 * check line), which is itself the finding the tail then shows.
 */
export function positiveLeavesFailing(positiveTail) {
  if (typeof positiveTail !== 'string' || positiveTail.trim() === '') return []
  return parseGateOutput(positiveTail).fails.map(f => f.id)
}

/**
 * The stored check output, minus the problems the staging dir has since fixed.
 *
 * A stored check is as old as the run that produced it, and a run that CRASHED
 * or was stopped leaves the previous run's reading in state. Attempt 3 of the
 * live C9 authoring was handed attempt 1's verdict — four `missing:` lines,
 * including `gate_c9.py`, which by then existed and was 17 KB — under the order
 * "Fix these before anything else; do not start over". A brief that asserts a
 * file is absent when it is present is worse than a brief that says nothing:
 * the model's cheapest reading of it is to write the file again.
 *
 * Only the presence claims are re-derived, because presence is the one thing
 * this function can answer for free and for certain. Anything else (a lint
 * problem, a calibration problem) is about a file that still exists and is
 * still worth reporting; the brief now tells the model the list is the PREVIOUS
 * run's, and that the harness runs the check again when its turn ends (decision sheet item 25: the
 * driver runs it outside the box; the model's own run of it is refused there).
 */
export function livePreviousCheck({ stagingDir, lastCheck, io }) {
  const output = lastCheck?.output
  if (typeof output !== 'string' || output.trim() === '') return null
  const dir = norm(stagingDir)
  const kept = output.split(/\r?\n/).filter(l => {
    const m = /^missing: (\S+) was never written into the staging dir$/.exec(l.trim())
    return !m || !io.exists(`${dir}/${m[1]}`)
  })
  if (!kept.some(l => l.trim() !== '')) return null
  // A problem the check located (Phase 4 residual) gets its FILE:LINE on the
  // line below it, so the resume opens the file at the line instead of
  // grepping for the id: `  at gate_c9.py:42`.
  const located = new Map()
  for (const a of atEntries(lastCheck?.problemAt)) if (!located.has(a.problem)) located.set(a.problem, a)
  const parts = [kept.map(l => {
    const a = located.get(l.trim())
    return a ? `${l}\n  at ${a.file}:${a.line}` : l
  }).join('\n')]

  // The evidence behind the problem list. Attempt 4 was told only that the
  // positive shim "did not PASS" and spent iterations 340-475 working out why by
  // reading the harness; the tail says it outright, and the failing ids say
  // which graded facts the shim never made true.
  // The positive shim's tail always, because reaching GATE: PASS is its whole job
  // and why it did not is the resume's entire task. The BASE and cheat-stub tails
  // only when they carry an error line: a gate that dies at import writes its
  // traceback to stderr, and a resume told "BASE run printed 1 error line(s)" with
  // no traceback is being asked to guess.
  const errorish = (s) => /Traceback|Error:|FABRICATED/.test(String(s ?? ''))
  const tailOf = (s) => String(s).split(/\r?\n/).filter(l => l.trim() !== '').slice(-20).join('\n')
  for (const [what, tail, always] of [
    ['positive shim', lastCheck?.tails?.positive, true],
    ['gate-at-BASE', lastCheck?.tails?.base, false],
    ['cheat stub', lastCheck?.tails?.perturb, false],
  ]) {
    if (typeof tail !== 'string' || tail.trim() === '') continue
    if (!always && !errorish(tail)) continue
    parts.push(`${what} output (tail):\n\n${tailOf(tail)}`)
  }
  const failing = Array.isArray(lastCheck?.positiveLeavesFailing) ? lastCheck.positiveLeavesFailing : []
  if (failing.length) {
    parts.push(`the positive shim leaves these lines FAIL: ${failing.join(' ')}`)
  }
  return parts.join('\n\n')
}

/** Where the driver leaves a stopped mission's uncommitted tree. */
export const WORK_SNAPSHOT_DIR = 'C:/tmp'

/**
 * The supervisor's refusal, read off disk, or null.
 *
 * By path rather than copied into state: the reviewer's file stays the one source,
 * and a note that has been edited since the refusal is read as it now stands. An
 * unreadable path is null and SAID — silently dropping the content of a refusal
 * would leave the next attempt re-authoring blind against a bar it cannot see.
 */
export function readNote(notePath, io) {
  if (!notePath) return null
  try {
    const text = io.readFile(notePath)
    return typeof text === 'string' && text.trim() !== '' ? text.trim() : null
  } catch { return null }
}

/** The four files an authoring mission owes, in the staging dir. */
export const stagedPaths = (id, stagingDir) => {
  const dir = norm(stagingDir)
  return { gate: `${dir}/gate_${id}.py`, perturb: `${dir}/perturb_${id}.py`,
    positive: `${dir}/positive_${id}.py`, draft: `${dir}/${id}.campaign.draft.json` }
}

/**
 * One check reading, in the shape the state stores and the brief reads.
 *
 * `kind` is the distinction `harnessFault` was carrying with no consumer: a
 * `fault` means the instrument did not run and the triple is UNGRADED, while
 * `refused` means it ran and the triple is not a bar. The verdict line and the
 * dashboard both print that word, and conflating them is how nine invented
 * problems got recorded against a sound gate in the first place.
 */
export function checkRecord(check, io) {
  // A dirty harness (review I4) is a fault, not a refusal: the instrument that
  // would have judged the triple is not the one it was dispatched under.
  const kind = check.fault || check.harnessDirty ? 'fault' : check.ok ? 'ok' : 'refused'
  return {
    at: io.now(), kind, ok: check.ok, problems: check.problems, lineCount: check.lineIds.length,
    // The check result's `at` list — where each located problem lives, printed
    // by the resume brief as `  at gate_c9.py:42` under its problem. Stored as
    // `problemAt` because the record's own `at` has always been its timestamp
    // (the time this reading was taken), and one field cannot be both.
    problemAt: atEntries(check.at),
    ...(check.harnessDirty ? { harnessDirty: true, harnessDirtyFiles: check.harnessDirtyFiles ?? [] } : {}),
    // Kept, not just counted: a resume that proposes straight from the staged
    // triple builds its proposal out of this record and has no other source for
    // the ids, and `draftToSpec` needs the ids themselves at seal time.
    lineIds: check.lineIds,
    output: check.ok ? `PASS — ${check.lineIds.length} graded lines` : check.problems.join('\n'),
    // The resume brief's raw material. A problem list says the positive shim
    // "did not PASS"; the tail says it died on `import gilded.ui.views` at line
    // 124, and the failing ids say which facts it never made true. Attempt 4
    // spent its budget rediscovering both by hand.
    tails: check.tails ?? null,
    positiveLeavesFailing: positiveLeavesFailing(check.tails?.positive ?? null),
  }
}

/**
 * The reading the resume brief is built from — measured now, not remembered.
 *
 * The stored `lastCheck` is as old as the run that wrote it, and can be worse
 * than old. Attempt 5's brief was built from attempt 4's verdict: eleven
 * problems, of which nine were F155's inventions ("too few gate lines: 0 < 8"
 * against a gate that grades 12, six MUST-FAIL complaints against an empty BASE
 * failure set, and a two-hour timeout inside a 32-second check). A brief is a
 * contract, and "Fix these before anything else" over nine phantoms buys nothing
 * but budget spent disproving them. It also cannot carry the shim's output tail,
 * because a verdict written before the tails existed has none.
 *
 * So on a resume — and only when all four files are actually staged, which the
 * first attempt never has — run the subprocess check once and use that. Four
 * minutes of a four-hour budget for a brief that is true. Falls back to the
 * stored reading if the check itself could not run: a harness fault is not a
 * reason to tell the model nothing.
 */
export async function refreshedLastCheck({ id, stagingDir, baseDir, prev, io }) {
  const stored = prev?.lastCheck ?? null
  if (!prev?.attempts) return stored
  const paths = stagedPaths(id, stagingDir)
  if (!Object.values(paths).every(p => io.exists(p))) return stored
  const check = await checkStagedViaSubprocess({ id, stagingDir, baseDir, io })
  if (check.fault) {
    console.error(`[author] ${id}: could not refresh the previous check (${faultSummary(check.fault)}) — the brief carries the stored reading`)
    return stored
  }
  console.log(`[author] ${id}: refreshed the previous check — ${check.ok ? 'PASS' : `${check.problems.length} problem(s)`}, ${check.lineIds.length} graded line(s)`)
  return checkRecord(check, io)
}

/**
 * Put the last attempt's uncommitted work back before the next one starts.
 *
 * The driver preserves what the tree was holding when it stopped
 * (`snapshotUncommittedWork`) and then resets, so the gate grades the commit.
 * Nothing put it back. On a resume that is the difference between the model
 * finding the file it was halfway through and finding the version from before
 * its last hour of work.
 *
 * `git apply --check` first, always: a patch that does not apply cleanly is left
 * alone and NAMED, because a half-applied patch is worse than none — the model
 * would be reading a tree neither it nor the check has ever seen. It is committed
 * rather than left dirty, so the staging dir's history says where the work came
 * from and the driver's own dirty-tree handling has nothing to preserve twice.
 *
 * Returns the sentence the brief prints. `null` when there is nothing to say.
 */
export function restoreUncommittedWork({ stagingDir, missionId, io, snapshotDir = WORK_SNAPSHOT_DIR }) {
  if (!missionId) return null
  const patch = `${norm(snapshotDir)}/${missionId}.uncommitted.patch`
  if (!io.exists(patch)) return null
  const dir = norm(stagingDir)
  const check = stagingTreeGit(io, dir, ['apply', '--check', patch])
  if (check.refused) return `The previous run's uncommitted work (${patch}) was NOT restored: ${check.refused}. The tree is at its last commit.`
  if (check.fault) {
    return `The previous run's uncommitted work (${patch}) was NOT restored: git apply --check could not run (${faultSummary(check.fault)}). The tree is at its last commit.`
  }
  if (check.status !== 0) {
    const why = String(check.stderr ?? '').trim().split(/\r?\n/)[0] || `exit ${check.status}`
    return `The previous run's uncommitted work (${patch}) was NOT restored: it does not apply cleanly to the current tree (${why}). The tree is at its last commit — nothing is half-applied.`
  }
  const applied = stagingTreeGit(io, dir, ['apply', patch])
  if (applied.refused) return `The previous run's uncommitted work (${patch}) was NOT restored: ${applied.refused}. The tree is at its last commit.`
  if (applied.fault || applied.status !== 0) {
    const why = applied.fault ? faultSummary(applied.fault) : (String(applied.stderr ?? '').trim().split(/\r?\n/)[0] || `exit ${applied.status}`)
    return `The previous run's uncommitted work (${patch}) was NOT restored: git apply failed after passing --check (${why}). The tree may be partly changed — run the check before you trust it.`
  }
  commitStaging(stagingDir, `restore uncommitted work from ${missionId}`, io)
  return `The previous run's uncommitted work WAS restored into ${dir} and committed as "restore uncommitted work from ${missionId}". The tree already holds whatever that run was part-way through.`
}

/**
 * `--author <id>`: one authoring mission, start to verdict.
 *
 * The model's own check is NOT trusted — the driver ran it, but the driver ran
 * it in a process the mission could have reached. The runner re-runs the check
 * from here, as a SUBPROCESS (F155), and only that reading raises the proposal.
 */
export async function authorCampaign({ id, roadmap, state, io, notePath = null }) {
  const refusal = (why) => ({ ok: false, why, proposal: null, missionId: null, verified: null, check: null })
  const line = lineFor(roadmap, id)
  if (!line) return refusal(`the roadmap has no line "${id}"`)
  if (line.status !== 'open' && line.status !== 'authoring') {
    return refusal(`roadmap line ${id} is "${line.status}" — --author only opens a line that is "open" or "authoring"`)
  }
  // The roadmap is ordered, and each line's gate is authored against the line
  // before it (`prevId` below is the exemplar). Authoring out of order would
  // hand the model an exemplar for a campaign that has not been written yet,
  // so the only line `--author` will open is the first one still in flight.
  const next = nextOpenLine(roadmap)
  if (next && next.id !== id) {
    return refusal(`roadmap line ${next.id} is still "${next.status}" — author the roadmap in order, ${next.id} before ${id}`)
  }
  // F242 (review of wave 5): under the integrity latch, or with a models record that does not match,
  // nothing is started or spent: no staging, no roadmap change, no re-run of the staged check. The same
  // question is asked again before the brief is written.
  const integrityFirst = io.integrity ? io.integrity.refusal() : null
  if (integrityFirst) {
    console.error(`[author] ${id}: REFUSED: integrity: ${integrityFirst} — nothing was started`)
    return refusal(`integrity: ${integrityFirst} — nothing was started`)
  }
  const s = state.state
  s.authoring = s.authoring ?? {}
  const prevId = previousLineId(roadmap, id)
  const { stagingDir, baseDir } = prepareStaging({ id, base: line.base, repo: CIVKINGS_REPO, io })
  setLineStatus(roadmap, id, 'authoring')
  ;(io.saveRoadmap ?? saveRoadmap)(ROADMAP_PATH, roadmap)

  const prev = s.authoring[id] ?? {}
  const attempt = (prev.attempts ?? 0) + 1
  // A supervisor refusal changes what the next attempt IS. The note path sticks to
  // the state so a later `--author` without `--note` still carries it — the
  // refusal does not expire because the operator typed a shorter command.
  const refusals = Array.isArray(prev.refusals) ? prev.refusals : []
  const activeNotePath = notePath ?? refusals.at(-1)?.notePath ?? null
  if (notePath && notePath !== refusals.at(-1)?.notePath) {
    s.authoring[id] = { ...prev, refusals: [...refusals, { at: io.now(), by: 'supervisor', notePath }] }
  }
  const supervisorNote = readNote(activeNotePath, io)
  if (activeNotePath && !supervisorNote) {
    console.error(`[author] ${id}: --note ${activeNotePath} could not be read — the refusal's content will NOT reach the brief`)
  }
  // The resume budget is for a shim fix. A refused seal is a re-authoring of what
  // the gate MEANS — new lines, new outcomes, a rewritten draft — so it gets the
  // full four hours.
  const timeoutS = supervisorNote ? AUTHOR_TIMEOUT_S : authorTimeoutFor(attempt)
  const briefFile = `${stagingDir}/brief-${attempt}.txt`
  // Before the brief is written, so the brief can say what it found.
  const restoreNote = restoreUncommittedWork({ stagingDir, missionId: prev.missionId ?? null, io })
  if (restoreNote) console.log(`[author] ${restoreNote}`)

  // A RESUME's brief must carry a CURRENT reading, so the check runs once here,
  // against the tree the mission is about to open. The stored `lastCheck` is as
  // old as the run that wrote it and can be worse than old: attempt 5's brief
  // was built from attempt 4's verdict, eleven problems of which nine were F155
  // inventions — "too few gate lines: 0 < 8" against a gate with 12, and a
  // two-hour timeout that never happened. A brief is a contract; handing a model
  // nine false problems under "fix these" spends its budget on phantoms.
  //
  // Only on a resume, and only once the triple is actually there: the first
  // attempt has nothing to read, and four minutes of a four-hour budget buys a
  // brief that is true.
  const resumeCheck = await refreshedLastCheck({ id, stagingDir, baseDir, prev, io })
  if (resumeCheck !== prev.lastCheck) s.authoring[id] = { ...s.authoring[id], lastCheck: resumeCheck }

  // The staged triple already passes: there is nothing for a mission to do, and
  // four hours of GPU to prove it. Propose from what is on disk. This is the same
  // reading `authorCampaign` would take after a dispatch — the subprocess check —
  // so the evidence behind the proposal is identical either way.
  // ...UNLESS a supervisor has refused this triple. A refused triple is
  // KNOWN-INSUFFICIENT, and its passing the mechanical check is exactly the thing
  // the refusal disputes: the C9 triple that drew this note was mechanically clean
  // — BASE missed by absence, the stub's header was exact, the shim reached
  // GATE: PASS — and still did not measure the roadmap line. Proposing it again
  // because the check is green would be the harness overruling the supervisor.
  //
  // ...AND unless the harness closure moved since the dispatch that produced the
  // triple (review I4). This shortcut raises a proposal without the end-of-run
  // check that would have compared fingerprints, so it compares here: a check
  // that passes only because the acceptance test's own code changed is not the
  // evidence the shortcut claims to reuse. It dispatches instead — loudly — and
  // that run's check is taken under a fingerprint of its own.
  const shortcutDirty = resumeCheck?.ok && prev.harnessSha256
    ? harnessDirtyFiles({ sha256: prev.harnessSha256, files: prev.harnessFiles ?? {} }, (io.harnessHash ?? harnessFingerprint)())
    : []
  if (shortcutDirty.length) {
    console.error(`[author] ${id}: the staged triple passes, but the harness closure changed since attempt ${prev.attempts} was dispatched (${shortcutDirty.join(', ')}) — not proposing from it; dispatching instead`)
  }
  if (resumeCheck?.ok && !supervisorNote && !shortcutDirty.length) {
    const check = { ok: true, problems: [], lineIds: resumeCheck.lineIds ?? [], tails: resumeCheck.tails ?? null }
    const proposal = gateProposal({ id, check, missionId: prev.missionId ?? null, verified: prev.verified ?? null })
    s.proposals = s.proposals ?? []
    if (!s.proposals.some(p => p.name === proposal.name && p.status === 'pending')) s.proposals.push({ ...proposal, proposedAt: io.now() })
    setLineStatus(roadmap, id, 'proposed')
    ;(io.saveRoadmap ?? saveRoadmap)(ROADMAP_PATH, roadmap)
    state.save()
    console.log(`[author] ${id}: proposal ${proposal.name} raised from the staged triple — no mission needed`)
    return { ok: true, why: null, proposal, missionId: prev.missionId ?? null, verified: prev.verified ?? null,
      check, sealed: null, dispatched: false }
  }

  // F242: nothing is written or dispatched under the integrity latch or with a models record that does not match.
  const integrityWhy = io.integrity ? io.integrity.refusal() : null
  if (integrityWhy) {
    console.error(`[author] ${id}: REFUSED: integrity: ${integrityWhy} — nothing was dispatched`)
    return { ok: false, why: `integrity: ${integrityWhy} — nothing was dispatched`, proposal: null, missionId: prev.missionId ?? null, verified: prev.verified ?? null,
      check: null, sealed: null, dispatched: false }
  }

  const text = authoringBrief({ line, id, prevId, baseDir, stagingDir, exemplar: exemplarFor({ prevId, io }),
    previousCheck: livePreviousCheck({ stagingDir, lastCheck: resumeCheck, io }), restoreNote,
    packageMap: readPackageMap({ baseDir, io }), timeoutS, supervisorNote })
  io.writeFile(briefFile, text)
  io.writeFile(sidecarPath(briefFile), JSON.stringify(authoringSidecar({ stagingDir, baseDir }), null, 2) + '\n')
  commitStaging(stagingDir, `${id}-author: brief ${attempt}`, io)

  // Wave 19 (plan P6 item 4): one name per attempt. The dispatch refuses a run whose engine or driver log
  // already exists rather than truncate it, and an attempt's brief stem (`brief-<n>`) repeats across campaigns.
  const pidFile = `C:/tmp/driver_${id}-author-${attempt}.pid`, driverLog = `C:/tmp/driver_${id}-author-${attempt}.log`
  const engineLog = `C:/tmp/engine_${id}-author-${attempt}.log`
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
    // The two numbers are ONE number on purpose. Since decision sheet item 25
    // the driver alone runs the check (the model's run of it is refused in the
    // box), but the model still runs the gate itself against BASE (Rule 11),
    // which runs the prior campaigns' chain; a Bash cap below the check cap
    // would kill that run where the driver's survives. 7,200,000 ms is what
    // the sidecar assertion allows.
    CYNCO_BASH_TIMEOUT_MS: '7200000',
    CYNCO_CHECK_TIMEOUT_MS: '7200000',
    CYNCO_SKIP_IDLE_ENGINE: '1',
    DRIVER_PID_FILE: pidFile,
    DRIVER_LOG: driverLog,
    // F242, entry 1.B2 part 1: the check runs its calibration in the BASE archive, so the dispatch
    // labels that folder for the run too (dispatch-mission.sh hands it to cynco-sandbox.mjs create
    // --also). toolEnv strips the key from every tool child.
    CYNCO_MISSION_ALSO_LABEL: baseDir,
    // Decision sheet item 25: the one mark of the authoring dispatch. The driver runs the acceptance check
    // itself, outside the box, as this checkout's own script for this staging folder (authorCheckPlan).
    [AUTHOR_CHECK_MARK]: '1',
    // Wave 19 (plan P6 item 4): the dispatch refuses a stem whose logs already exist, so each attempt names its own.
    ENGINE_LOG: engineLog,
  })
  // Persist BEFORE the wall clock starts, the same discipline runWave keeps: a
  // runner that dies in the wait must not let the next invocation dispatch a
  // second authoring mission on top of the first.
  // `...s.authoring[id]`, NOT `...prev`: this runs after the refusal above may
  // have added `refusals`, and spreading the stale snapshot silently dropped it —
  // the note path then vanished and the next resume without `--note` forgot the
  // refusal entirely.
  // Review I4: the acceptance test's own code, fingerprinted at dispatch. The
  // end-of-run check refuses to believe a subprocess run under any other.
  const harness = (io.harnessHash ?? harnessFingerprint)()
  s.authoring[id] = { ...s.authoring[id], stagingDir, baseDir, briefFile, attempts: attempt, dispatchedAt: io.now(), missionId: null, verified: null, fault: null,
    harnessSha256: harness.sha256, harnessFiles: harness.files }
  state.save()

  let missionId = null, verified = null, fault = null, driverExited = false
  // F242: the dispatch's run id (it keys the integrity baseline), and why its engine is not known to be dead.
  let runId = null, notDead = null
  try {
    const dispatched = await io.dispatch({ briefFile, marker: `gate ${id} authored`, cwd: stagingDir, timeoutS, checkCmd: checkCommand(stagingDir, baseDir), env })
    runId = dispatched?.runId ?? null
    const waited = await io.waitForDriver({ pidFile, driverLog, timeoutMs: (timeoutS + 3600) * 1000 })
    missionId = waited.exited ? (waited.missionId ?? io.missionIdFrom?.(driverLog) ?? null) : null
    driverExited = Boolean(waited.exited)
    const row = missionId ? io.readRow(missionId) : null
    verified = row ? (row.verified ?? null) : null
    // A missing row is worth SAYING and is no longer worth refusing over: the
    // triple on disk is the thing being graded and the runner's check reads it
    // directly. Only a driver that never came back leaves nothing to grade.
    if (!row) {
      // A mission id with no row behind it points at nothing anyone can read, so
      // it is not recorded as evidence — the fault line says what happened.
      missionId = null
      fault = waited.exited ? 'driver exited without a ledger row — the triple was graded from disk'
        : waited.pidUnseen ? `driver pid ${waited.pidUnseen} was already invisible on the first probe — the PID handoff is broken and the mission may still be running unwatched (see ${driverLog})`
          : 'driver did not exit within the wall clock'
      if (!waited.exited) notDead = fault
    }
  } catch (e) {
    fault = `dispatch or wait failed: ${e?.message ?? e}`
    console.error(`[author] ${id}: ${e?.stack ?? e}`)
    if (!DISPATCH_LEFT_NOTHING_RUNNING.test(String(e?.message ?? ''))) notDead = fault
  }
  // F242, rule 8: a mission engine that may still be running is the integrity latch, as in a wave (runWave).
  if (notDead && io.integrity?.halt) {
    try {
      await io.integrity.halt({ by: 'gate-author', run: runId ?? `${id}-author`, reason: 'engine-not-confirmed-dead', detail: notDead, cwd: stagingDir })
    } catch (e) {
      console.error(`[author] ${id}: the integrity latch step failed: ${e?.message ?? e}`)
    }
  }

  // Wave 19b (check A-F1): the re-check takes the suite baseline the driver's in-run check could not write
  // (the held-out folder is frozen while this run's integrity baseline is open), so it waits for the dispatch
  // watcher's settle first, bounded, as the wave runner does; a run still open after the bound is said, and
  // the re-check then names the frozen baseline itself.
  if (driverExited && runId && io.integrity?.settled) {
    const until = Date.now() + (io.integrity.settleWaitMs ?? 300_000)
    while (!io.integrity.settled(runId) && Date.now() < until) await (io.integrity.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms))))(10_000)
    if (!io.integrity.settled(runId)) console.error(`[author] ${id}: run ${runId} had not settled ${Math.round((io.integrity.settleWaitMs ?? 300_000) / 1000)} s after the driver's exit, so the re-check runs with its integrity baseline open and may not write the suite baseline`)
  }

  // Whenever the driver came back at all, the triple on disk gets graded — a
  // missing ledger row is a thing to report, not a reason to leave a green bar
  // ungraded. Only a driver still running, or never seen, has nothing to grade.
  const check = driverExited
    ? await checkStagedViaSubprocess({ id, stagingDir, baseDir, io, harness })
    : { ok: false, problems: [`not graded: ${fault ?? 'the driver never returned'}`], lineIds: [], tails: null, fault: null }
  const lastCheck = checkRecord(check, io)
  s.authoring[id] = { ...s.authoring[id], missionId, verified, lastCheck, fault }

  let proposal = null
  // CONTROLLER RULING, amending the spec: the authoring verdict is THIS check and
  // never `verified`. `verified` is the driver's advisory reading, and for an
  // authoring mission it is structurally null — the run cannot go quiet, so the
  // driver warns that its gate and the mission are racing for the same tree and
  // records null. Gating on it made a green bar unproposable by construction:
  // live attempt 7 passed the driver's own check (exit 0, 277 s, `GATE: PASS`)
  // AND the runner's re-check (ok, 11 graded lines) and still printed "no
  // proposal — the mission produced no verified check result". `verified` is
  // recorded on the state and printed in the verdict line; nothing hangs off it.
  if (check.ok) {
    proposal = gateProposal({ id, check, missionId, verified })
    s.proposals = s.proposals ?? []
    if (!s.proposals.some(p => p.name === proposal.name && p.status === 'pending')) s.proposals.push({ ...proposal, proposedAt: io.now() })
    setLineStatus(roadmap, id, 'proposed')
    ;(io.saveRoadmap ?? saveRoadmap)(ROADMAP_PATH, roadmap)
  }

  // AUTO-APPROVE (spec ruling 2). What earned authority BUYS is this branch and
  // nothing else: at `gate-author/gate` 0.5 the seat seals its own gate instead
  // of waiting for `--approve-proposal gate/<id>`.
  //
  // Everything else is unchanged, deliberately. `sealGate` runs every one of
  // its refusals before a single visible byte is written, so a triple that does
  // not survive the seal-time re-check leaves the proposal PENDING and the
  // roadmap line `proposed` — exactly where a supervisor's refused approval
  // leaves them. Earned authority buys the seat the right to press the button,
  // never the right to skip the checks behind it.
  // The seat's authority, not this fresh campaign's: the promotion was approved
  // into the state of whichever campaign gathered the evidence, so the local
  // value is 0 on every campaign that has just been created.
  const authority = Math.max(s.gateAuthorAuthority ?? 0, io.seatAuthority?.() ?? 0)
  let sealed = null
  if (proposal && authority >= GATE_AUTHOR_MAX_AUTHORITY) {
    // BEFORE the seal, not after: without the runner's decision writer there is
    // no way to record that this gate was approved, and a gate copied into the
    // sealed tree against a proposal that is still `pending` is a seal nobody
    // can audit and nobody can re-approve. Refuse while nothing has moved.
    if (typeof io.applyProposalDecision !== 'function') {
      sealed = { ok: false, problems: ['io.applyProposalDecision was not supplied by the runner — run --author through scripts/cynco-campaign.mjs; nothing was sealed'] }
      console.error(`[author] ${id}: earned authority ${authority}, but ${sealed.problems[0]}`)
    } else {
      try {
        sealed = await sealGate({ id, state, roadmap, io })
        if (sealed.ok) {
          // The decision is recorded through the runner's own
          // `applyProposalDecision`, handed over in the io (this module never
          // imports the runner — that would close the ESM cycle it lives on the
          // other side of). `decidedBy: 'auto'` is what tells a later reader
          // that no human looked at this seal.
          const decided = io.applyProposalDecision(s, proposal.name, true, { decidedBy: 'auto' })
          if (!decided?.ok) console.error(`[author] ${id}: sealed, but the decision was not recorded — ${decided?.why ?? 'no reason given'}`)
          if (io.notify) await io.notify(`${id.toUpperCase()}: gate SEALED by the gate-author seat at authority ${authority} — proposal ${proposal.name} approved automatically (${check.lineIds.length} graded lines, ${sealed.specPath}). No supervisor approved this.`)
        } else {
          console.error(`[author] ${id}: auto-seal REFUSED — the proposal stays pending for --approve-proposal ${proposal.name}:\n  ${sealed.problems.join('\n  ')}`)
        }
      } catch (e) {
        // A throw here must not lose the authoring run: the proposal is already
        // raised and the supervisor can still approve it by hand.
        console.error(`[author] ${id}: auto-seal failed — ${e?.stack ?? e}`)
        sealed = { ok: false, problems: [`auto-seal failed: ${e?.message ?? e}`] }
      }
    }
  }
  state.save()
  // `kind` decides the wording, because "the instrument did not run" and "the
  // triple is not a bar" are different things to a person reading one line.
  // `fault` (the dispatch/wait fault) is reported alongside rather than instead:
  // the check still ran and still has something to say.
  const why = proposal ? null
    : lastCheck.kind === 'fault' ? `NOT GRADED — ${check.problems.join('; ')}${fault ? ` (and: ${fault})` : ''}`
      : `--check refused the staged triple (${check.problems.length} problem(s))${fault ? ` (and: ${fault})` : ''}`
  return { ok: Boolean(proposal), why, proposal, missionId, verified, check, sealed, kind: lastCheck.kind }
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
  const claimed = [...new Set(work.flatMap(w => w.gateIds))]
  // A draft's gateId is the SHORT id — `C9.1a` — and a lint id is the full one —
  // `C9.1a.resolution-list`. Matched exactly, as this did, every draft any author
  // could write would throw at seal time, and nothing caught it because the seal
  // had never been reached. The prefix rule is the one `parsePerturbHeader`
  // already uses for the EXPECT-FLIP / MUST-FAIL lists, so a draft, a stub header
  // and a gate now all name lines the same way.
  const matches = (short, full) => full === short || full.startsWith(short + '.')
  const covers = (full) => claimed.some(short => matches(short, full))
  const uncovered = lineIds.filter(x => x.toLowerCase() !== regression && !x.toLowerCase().startsWith(regression + '.') && !covers(x))
  if (uncovered.length) throw new Error(`draft work[] gateIds do not cover ${uncovered.length} graded line(s): ${uncovered.join(' ')}`)
  // And the other direction. A work item claiming an id the gate never prints
  // reads, in the wave brief, as an order to fix a line that cannot fail — and
  // `loadCampaignSpec` would accept it, because nothing there has ever seen
  // the gate. The lint ids are the only list that has. (`C9.4b` in the first
  // authored draft was exactly this: a phantom left behind when the author merged
  // two lines into one.)
  if (lineIds.length) {
    const phantom = claimed.filter(short => !lineIds.some(full => matches(short, full)))
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
    invariants: { ...WORKER_INVARIANTS },
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
    gitHasCommit: io.gitHasCommit ?? ((repo, sha) => spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8', env: harnessGitEnv(process.env) }).status === 0),
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
  // Sealing writes into the held-out folder, which is FROZEN while any run is open (F242, entry 4.M5).
  const frozenWhy = (io.frozenWriteRefusal ?? frozenWriteRefusal)()
  if (frozenWhy) return { ok: false, problems: [frozenWhy], check }
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
    // F155: `runSync`, never a bare spawnSync. The authoring runner's first
    // spawn after `waitForDriver` follows a FOUR-HOUR gap, which is the exact
    // shape that made bun report a stale deadline as a two-hour timeout.
    // Plan P6 item 7: a contained run (the check's gate runs) is recorded (authorRunOpts).
    run: (cmd, args, opts = {}) => runSync(cmd, args, authorRunOpts(opts)),
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
    // The auto-approve branch's one reach back into the runner. Absent, the
    // branch refuses loudly rather than sealing a gate and recording nothing:
    // a seal nobody decided is a seal nobody can audit.
    applyProposalDecision: helpers.applyProposalDecision ?? (() => { throw new Error('io.applyProposalDecision was not supplied by the runner — run --author through scripts/cynco-campaign.mjs') }),
    notify: helpers.notify ?? null,
    integrity: helpers.integrity ?? null,
    // What the SEAT has earned, read across every campaign — see
    // `gateAuthorAuthorityAcrossCampaigns`. A seam because the campaigns dir is
    // a real directory and the auto-approve tests must point it somewhere else.
    seatAuthority: helpers.seatAuthority ?? (() => gateAuthorAuthorityAcrossCampaigns()),
    // Review I4: the acceptance test's import closure, fingerprinted. A seam so
    // the dirty-harness tests can move it without editing a real script.
    harnessHash: () => harnessFingerprint(),
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
      console.error('usage: bun scripts/cynco-gate-author.mjs --check <stagingDir> <baseDir> [--json]')
      return 2
    }
    const id = basename(norm(stagingDir))
    const check = await checkStaged({ id, stagingDir, baseDir, io })
    // The machine-readable verdict, for the runner's subprocess re-check (F155).
    // Behind `--json`, because the tails run to ~12 KB and the MODEL runs this
    // command too: every one of its checks would otherwise end in a wall of its
    // own output, re-read into its context for nothing. Printed on stdout in both
    // directions and always last, so a reader takes the final marker line.
    const wantJson = flag('--json') !== -1
    const cal = check.calibration ?? {}
    const jsonLine = CHECK_JSON_MARKER + JSON.stringify({
      ok: check.ok, problems: check.problems, at: check.at ?? [], lineIds: check.lineIds,
      tails: { base: cal.baseOutputTail ?? null, perturb: cal.perturbOutputTail ?? null, positive: cal.positiveOutputTail ?? null },
    })
    if (check.ok) {
      console.log(`[check] ${id}: PASS — ${check.lineIds.length} graded lines, BASE MISS, cheat stub honest, positive shim PASS`)
      if (wantJson) console.log(jsonLine)
      return 0
    }
    console.error(`[check] ${id}: REFUSED — ${check.problems.length} problem(s)`)
    for (const p of check.problems) console.error(`  ${p}`)
    if (wantJson) console.log(jsonLine)
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
    const notePath = flag('--note') !== -1 ? argv[flag('--note') + 1] : null
    try {
      const r = await authorCampaign({ id, roadmap, state, io, notePath })
      if (r.ok && r.sealed?.ok) { console.log(`[author] ${id}: SEALED at earned authority — ${r.sealed.specPath} written, triple copied, proposal ${r.proposal.name} approved automatically (${r.check.lineIds.length} graded lines)`); return 0 }
      if (r.ok) { console.log(`[author] ${id}: proposal ${r.proposal.name} raised (${r.check.lineIds.length} graded lines) — review the triple, then --approve-proposal ${r.proposal.name}`); return 0 }
      // Spec §4 (review #7): a refusal BEFORE dispatch — the line is not
      // open/authoring, or an earlier line is still in flight — is the operator
      // asking for something the ladder does not allow, exit 2 like every other
      // usage-shaped refusal. `check: null` is exactly that shape: nothing ran.
      if (!r.ok && r.check === null) { console.error(`[author] ${id}: refused — ${r.why}`); return 2 }
      // A FAULT is not a refusal: nothing was measured, so nothing was judged,
      // and the operator's next move is to fix the harness rather than the gate.
      // Both are exit 1: a check that ran (or tried to) and raised no proposal.
      console.error(`[author] ${id}: ${r.kind === 'fault' ? 'fault' : 'no proposal'} — ${r.why}`)
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
