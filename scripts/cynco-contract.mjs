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

/** Reject at dispatch, where a person is watching, rather than mid-mission. */
function refuse(file, why) {
  throw new Error(`mission contract sidecar ${file}: ${why}`)
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''

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
    return { text: entry.text, command: entry.command.trim() }
  }

  refuse(file, `assertion ${JSON.stringify(entry)} names no known kind ` +
    '(testCensus, fileAbsent, text+command, or a sentence assertionCheck recognises)')
}

/**
 * The assertions this mission is dispatched with, or null for no contract.
 *
 * `io` is injected so the whole of this is testable without a filesystem.
 */
export function loadMissionAssertions(taskFile, checkCmd, io) {
  const assertions = []
  if (nonBlank(checkCmd)) {
    assertions.push({ text: HELD_OUT_GATE_TEXT, command: checkCmd })
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

/** `commandAssertion` is re-exported so the visible form has one definition. */
export { commandAssertion }
