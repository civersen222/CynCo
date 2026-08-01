// The DoD contract a mission is dispatched with.
//
// Split out of cynco-mission-driver.mjs so it can be measured: the driver opens
// a WebSocket at import time, so nothing in it was ever under test, and this is
// the part where being wrong is silent.
//
// Two things travel with a mission:
//
//   1. the held-out gate — the check command, withheld from the assertion TEXT
//      and carried beside it (findings (ah)/(aj), engine/tools/contract.ts);
//   2. whatever the brief AUTHORIZES — added by an optional JSON file beside the
//      brief.
//
// (2) exists because of finding (ai). `assessTestsUnmodified` vetoes the entire
// reward (-1.0, no components consulted) when a test file loses measured cases
// or vanishes, and clears only when every losing path is named by a passed
// assertion parsing to `test_census` or `file_absent`. Silence vetoes — that is
// deliberate, finding (w). But the driver's whole contract was derived from the
// check command, so nothing could name anything, and a mission that deleted four
// superseded cases BECAUSE THE BRIEF SAID TO scored -1.0 and entered the corpus
// as a maximal negative. A fabricated negative teaches as hard as a real one.
//
// The two authorizing kinds are written structurally and their sentences are
// rendered here rather than transcribed by the author, because `assertionCheck`
// matches anchored literal templates. A sidecar saying "test_ui.py keeps at
// least 40 tests" parses into nothing, and an assertion that parses into nothing
// is graded on the model's own word (contract.ts:425) — an authorization that
// authorizes by asking the subject whether it agrees.

import { existsSync, statSync } from 'node:fs'
import { assertionCheck, commandAssertion } from '../engine/tools/contractVerify.js'

/**
 * The text the model reads for the held-out gate.
 *
 * The command is NOT here. Wave 5c read `Verification command exits 0: <path>`
 * out of its own contract and ran the gate directly.
 */
export const HELD_OUT_GATE_TEXT =
  'The held-out verification gate for this mission exits 0. The dispatcher runs it ' +
  'after the mission ends; it is not yours to run and you are not told what it is.'

/**
 * Where a brief's authorizations live: the brief path with its extension
 * replaced. `wave8_brief.md` → `wave8_brief.contract.json`, so the two sort
 * adjacent in a directory listing and are hard to commit apart.
 */
export function sidecarPath(taskFile) {
  const p = taskFile.replace(/\\/g, '/')
  const slash = p.lastIndexOf('/')
  const dot = p.lastIndexOf('.')
  // Only an extension on the FILE. `C:/tmp/wave.8/brief` has a dot in a
  // directory and no extension at all.
  const stem = dot > slash ? p.slice(0, dot) : p
  return `${stem}.contract.json`
}

/**
 * Why this workspace cannot be dispatched into, or null when it can.
 *
 * Measured on the Wave 10 dispatch. The cwd was written with backslashes in a
 * bash command line, the shell ate them, and the driver was handed
 * `C:Userscivercivkings` — which it accepted. It then reported sealing TWO
 * held-out instruments where one was expected, and only died later, by luck, on
 * a raw `ENOENT: uv_spawn 'git'`.
 *
 * The count was the finding. `harnessGatePaths` skips any path resolving INSIDE
 * the workspace, because a gate the mission owns is not withheld from it. A
 * workspace root that matches nothing makes that skip unreachable, so the
 * repository's own path joins the sealed set — and a sealed workspace refuses
 * every call naming it with a refusal that, by design, cannot say what it is
 * protecting. The mission would spend its entire budget being told it had
 * touched something it is not allowed to know about.
 *
 * Which is why this lives in the contract module rather than beside the argv
 * parsing: the workspace root is an input to what gets sealed, and a wrong one
 * is a sealing fault before it is a path fault.
 *
 * `.git` is checked for existence and not for being a directory — a linked
 * worktree's `.git` is a FILE holding a gitdir pointer, and the gates are run
 * against exactly those.
 */
export function workspaceError(cwd, io = {}) {
  const exists = io.exists ?? ((p) => existsSync(p))
  const isDirectory = io.isDirectory ?? ((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true)
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!exists(root)) return `workspace ${cwd} does not exist`
  if (!isDirectory(root)) return `workspace ${cwd} is not a directory`
  if (!exists(`${root}/.git`)) return `workspace ${cwd} is not a git repository`
  return null
}

/** Reject at dispatch, where a person is watching, rather than mid-mission. */
function refuse(file, why) {
  throw new Error(`mission contract sidecar ${file}: ${why}`)
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''

/** A cap is a positive, finite number of milliseconds, or it is not a cap. */
const usableCap = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * The cap as a spreadable field, so an absent one stays ABSENT.
 *
 * `{ timeoutMs: undefined }` would serialize the key away over the wire but
 * survive in process as a key that is present and empty, which is the kind of
 * difference that later reads as "somebody set this".
 */
const capOf = (v) => (usableCap(v) ? { timeoutMs: v } : {})

/**
 * One sidecar entry → the assertion the engine will carry.
 *
 * Every branch ends in a text `assertionCheck` recognises or a withheld command,
 * and the structural kinds are re-parsed before being returned. A rendered
 * sentence that does not survive its own round trip is the failure this shape
 * exists to prevent, so it is checked rather than assumed — a path containing a
 * newline, for one, escapes an anchored template silently.
 */
function toAssertion(entry, file) {
  if (nonBlank(entry)) {
    if (!assertionCheck(entry)) {
      refuse(file, `assertion "${entry}" parses into no repository check, so nothing would ` +
        'verify it and the model would mark it passed on its own word')
    }
    return entry
  }

  if (!isPlainObject(entry)) {
    refuse(file, `assertion ${JSON.stringify(entry)} is neither a sentence nor an object`)
  }

  if ('testCensus' in entry) {
    if (!nonBlank(entry.testCensus)) refuse(file, 'testCensus needs a path')
    if (!Number.isInteger(entry.min) || entry.min < 0) {
      refuse(file, `testCensus ${entry.testCensus} needs an integer min >= 0, got ${JSON.stringify(entry.min)}`)
    }
    const text = `Test file ${entry.testCensus} declares at least ${entry.min} test cases`
    const back = assertionCheck(text)
    if (back?.kind !== 'test_census' || back.path !== entry.testCensus || back.min !== entry.min) {
      refuse(file, `testCensus ${JSON.stringify(entry.testCensus)} does not survive the round trip ` +
        'through assertionCheck, so the veto would never find it')
    }
    return text
  }

  if ('fileAbsent' in entry) {
    if (!nonBlank(entry.fileAbsent)) refuse(file, 'fileAbsent needs a path')
    const text = `File ${entry.fileAbsent} no longer exists after changes`
    const back = assertionCheck(text)
    if (back?.kind !== 'file_absent' || back.path !== entry.fileAbsent) {
      refuse(file, `fileAbsent ${JSON.stringify(entry.fileAbsent)} does not survive the round trip ` +
        'through assertionCheck, so the veto would never find it')
    }
    return text
  }

  if ('command' in entry || 'text' in entry) {
    if (!nonBlank(entry.text)) refuse(file, 'a withheld assertion needs the text the model reads')
    if (!nonBlank(entry.command)) {
      refuse(file, `withheld assertion "${entry.text}" has no command — the text is prose and ` +
        'the command is the whole of the check')
    }
    // Refused here, where a person is watching, rather than at the far end. A
    // cap that fails the engine's number check silently reverts to the 300s
    // default, so a bad one is worse than none: it looks set and is not.
    if ('timeoutMs' in entry && !usableCap(entry.timeoutMs)) {
      refuse(file, `withheld assertion "${entry.text}" has timeoutMs ` +
        `${JSON.stringify(entry.timeoutMs)} — a cap must be a positive number of MILLISECONDS`)
    }
    return { text: entry.text, command: entry.command.trim(), ...capOf(entry.timeoutMs) }
  }

  refuse(file, `assertion ${JSON.stringify(entry)} names no known kind ` +
    '(testCensus, fileAbsent, text+command, or a sentence assertionCheck recognises)')
}

/**
 * The assertions this mission is dispatched with, or null for no contract.
 *
 * `io` is injected so the whole of this is testable without a filesystem.
 *
 * `gateTimeoutMs` is the driver's own cap on the held-out gate, sent so the
 * ENGINE runs it under the same one. The driver is a WebSocket client to a
 * daemon it did not start, so the variable it was given governs only its own
 * final run; the cockpit re-runs the identical command on every taskCompleted
 * and, before this, always at 300s. Gilded Wave 9d spent 115 turns failing a
 * 30-minute gate that was never allowed to finish.
 */
export function loadMissionAssertions(taskFile, checkCmd, io, gateTimeoutMs) {
  const assertions = []
  if (nonBlank(checkCmd)) {
    assertions.push({ text: HELD_OUT_GATE_TEXT, command: checkCmd, ...capOf(gateTimeoutMs) })
  }

  const file = sidecarPath(taskFile)
  if (io.exists(file)) {
    let parsed
    try {
      parsed = JSON.parse(io.readFile(file))
    } catch (e) {
      refuse(file, `is not valid JSON — ${e.message}`)
    }
    if (!isPlainObject(parsed)) refuse(file, 'must be a JSON object')
    if (!Array.isArray(parsed.assertions)) refuse(file, 'must have an "assertions" array')
    // An empty array is a file that was written, read, and authorized nothing —
    // the shape most likely to be mistaken for working.
    if (parsed.assertions.length === 0) refuse(file, 'has an empty "assertions" array')
    for (const entry of parsed.assertions) assertions.push(toAssertion(entry, file))
  }

  return assertions.length > 0 ? assertions : null
}

/** The capability an engine must advertise before it can be trusted to seal. */
export const CAP_SEALED_GATES = 'sealed-gates'

/**
 * F41: may this mission be dispatched to THIS engine? Null to dispatch, a
 * sentence to print and refuse on.
 *
 * Wave 9b was dispatched with a two-path seal to a daemon started seven hours
 * before the seal was written. Nothing on either side of the socket was in a
 * position to notice: the driver knew the contract sealed two files, the engine
 * knew nothing about sealing at all, and an engine that knows nothing about
 * sealing has no way to say so. The mission then read and ran its own grading
 * gate four times and the gate's PASS had to be thrown away.
 *
 * So the check is on ABSENCE, and it has to be, because that is the only shape
 * the failure comes in: a build too old to enforce a guarantee is also too old
 * to fail a check for it. `capabilities` missing, null (no session.ready
 * arrived), or present without the word all mean the same thing — UNKNOWN — and
 * unknown is not permission. That is the never-assume-a-measurement rule
 * applied to the engine's own competence.
 *
 * A mission with nothing sealed is unaffected. Most missions have nothing
 * sealed, and a guard that stopped them would be traded away within a week.
 */
export function sealedDispatchRefusal({ sealedCount, capabilities }) {
  if (!sealedCount) return null
  if (Array.isArray(capabilities) && capabilities.includes(CAP_SEALED_GATES)) return null

  const said = capabilities == null
    ? 'the engine advertised no capabilities at all (a build older than the seal cannot say the word)'
    : `the engine advertised [${capabilities.join(', ')}]`
  return `this mission seals ${sealedCount} held-out instrument(s), but ${said}. `
    + 'A seal the engine cannot enforce is worse than none: the mission would find '
    + 'and run its own grading gate and every component would report success. '
    + 'Restart the engine from the current tree and re-dispatch.'
}

/** The capability an engine must advertise before a mission may be measured on it. */
export const CAP_S5_ADVISORY = 's5-advisory'

/**
 * F59: may this mission be measured on THIS engine? Null to dispatch, a sentence
 * to print and refuse on.
 *
 * The driver's old detector was a console warning on the first `s5.decision`
 * frame carrying `enforced: true`. Late twice over: after the dispatch, and only
 * when a decision happened to enforce — so an engine with enforcement live that
 * enforced nothing early produced a confounded run and said nothing at all.
 *
 * Enforcement can restrict tools mid-mission (F7 killed a run that way) and it
 * confounds every label the mission produces, because the outcome then partly
 * measures the governor. That makes it a precondition of dispatching, not a
 * remark about a dispatch already made.
 *
 * Refuses on ABSENCE for the same reason `sealedDispatchRefusal` does: an engine
 * too old to say the word is exactly the engine most likely to be running with
 * defaults, and enforcement is ON by default. Unknown is not permission.
 *
 * Unlike the seal guard, this applies to every mission. A mission with nothing
 * withheld has its labels confounded just as thoroughly.
 */
export function s5DispatchRefusal({ capabilities }) {
  if (Array.isArray(capabilities) && capabilities.includes(CAP_S5_ADVISORY)) return null

  const said = capabilities == null
    ? 'the engine advertised no capabilities at all (a build older than this check cannot say the word)'
    : `the engine advertised [${capabilities.join(', ')}]`
  return `S5 enforcement may be live in this engine: ${said}, and the word for a capped `
    + 'governor is absent. S5 can restrict the mission\'s tools mid-run (F7) and every '
    + 'outcome label it produces would partly measure the governor rather than the work. '
    + 'Restart the engine with LOCALCODE_S5_ENFORCE=false and re-dispatch.'
}

/** `commandAssertion` is re-exported so the visible form has one definition. */
export { commandAssertion }
