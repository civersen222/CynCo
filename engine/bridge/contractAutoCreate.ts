// P4.2 (STATE doc Phase 4(a)): how contracts come into being at message time.
//
// maybeAutoCreateContract — intent-classified auto-contract from the user
// message (extracted verbatim from conversationLoop.handleUserMessage so it
// is unit-testable). A COMPLETE stale contract from a prior task is replaced
// — otherwise taskError (P4.1) measures the wrong task; an INCOMPLETE one is
// kept (live task / follow-up message).
//
// applyHarnessContract — harness-supplied contract (mission mode: the brief's
// check script IS the contract). Enforcement stays at its default: the
// 2026-06-12 weekly-digest incident was about miscalibrated interactive
// auto-assertions on pinned-tool runs, not harness-authored ones, and
// enforcement caps at 5 rounds.

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ContractState, globalContract } from '../tools/contract.js'
import { COMMITTED_ASSERTION, fileExistsAssertion, fileModifiedAssertion } from '../tools/contractVerify.js'

export type HarnessContractSpec = {
  title: string
  brief?: string
  assertions: string[]
}

/**
 * Intent-classified assertions for a user message (moved from conversationLoop).
 *
 * File targets are resolved against `cwd` before they become assertions.
 * ContractAssertPass now answers these against the repository, so an assertion
 * naming a file that does not exist and was never asked for is one nothing can
 * satisfy — the task can never be closed honestly and the run scores as
 * incomplete work that was in fact done. A filename-shaped token in prose is not
 * evidence that the file exists; the workspace is.
 */
const FILE_TOKEN = /[\w./\\-]+\.(py|ts|js|tsx|jsx|rs|go|java|c|cpp|h|html|css|json|yaml|yml|toml|md)\b/g

/** How far before a filename a create verb may sit and still be about that file. */
const CREATE_VERB_REACH = 40

/**
 * Does the message ask for *this* file to be brought into existence?
 *
 * The create-intent used to be a flag over the whole message, which meant the
 * word "write" anywhere turned every unrecognised filename token into a claim
 * that the file would exist when the task closed. Every TDD instruction says
 * "write the test first", so any correction message that mentions a bare
 * basename in passing manufactured an assertion nothing could ever satisfy.
 * The verb has to be attached to the filename to be about the filename.
 */
function asksToCreate(text: string, file: string): boolean {
  const verb = /\b(create|write|new file)\b[^.]*$/i
  let from = 0
  for (;;) {
    const at = text.indexOf(file, from)
    if (at < 0) return false
    if (verb.test(text.slice(Math.max(0, at - CREATE_VERB_REACH), at))) return true
    from = at + file.length
  }
}

/**
 * The sentences of `text` that contain `file`.
 *
 * Split on end-of-sentence punctuation followed by whitespace, plus newlines and
 * list bullets, so a filename's own dot ("grip.py") never splits a sentence.
 */
function sentencesMentioning(text: string, file: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+/)
    .filter(s => s.includes(file))
}

const CHANGE_VERB =
  /\b(edit|add|create|writ(e|ing)|fix|change|modify|delete|remove|strip|wire|implement|refactor|rewrite|build|update|move|rename|declare|replace|revert)\b/i

/**
 * Does the message ask for *this* existing file to be changed?
 *
 * The existing-file branch used to have no verb check at all: any real path named
 * anywhere in the message became "was modified". So a fix-list that PRAISED CynCo
 * for reverting an edit to gilded/society/realm.py asserted that realm.py must be
 * modified, and on the live L2d run the model burned turns insisting "the contract
 * says realm.py should be modified... but realm.py has no changes", trying to
 * reconcile a mandate to edit a file it had just been commended for leaving alone.
 * "Leave X alone" produced the same inversion.
 *
 * Scoped to the sentence rather than a character window (the rule `asksToCreate`
 * uses) because a real instruction puts the verb on either side of the path —
 * "delete the fallback branch in gilded/grip.py" and "gilded/grip.py — strip the
 * unused imports" are both mandates, and neither fits a fixed lookbehind.
 *
 * A missed mandate costs one assertion and falls back to the generic "Code was
 * modified to address the task". A false one points the agent at the wrong file.
 */
function asksToChange(text: string, file: string): boolean {
  return sentencesMentioning(text, file).some(s => CHANGE_VERB.test(s))
}

export function synthesizeMessageAssertions(text: string, cwd: string): string[] {
  const lowerText = text.toLowerCase()
  const assertions: string[] = []

  // Classify intent
  const isEditTask = /\b(edit|add|create|write|fix|change|modify|delete|remove|wire|implement|refactor|build|update|move|rename)\b/.test(lowerText)
  const isAnalysisTask = /\b(analyze|explain|describe|summarize|review|compare|investigate|trace|debug|diagnose|why|how does|what is|what are|tell me|show me|find|search|look at|check)\b/.test(lowerText)
  const isRunTask = /\b(run|test|execute|deploy|install|start|launch|build)\b/.test(lowerText)

  if (isEditTask) {
    // Extract file targets from the message, keeping where each one was said.
    const seen = new Set<string>()
    for (const m of text.matchAll(FILE_TOKEN)) {
      if (assertions.length >= 3) break
      const f = m[0]
      if (seen.has(f)) continue
      seen.add(f)
      if (existsSync(isAbsolute(f) ? f : resolve(cwd, f))) {
        // It is there, so "exists after changes" is true before a keystroke is
        // typed. The claim worth making is that the work touched it — but only
        // where the message actually asked for that.
        if (asksToChange(text, f)) assertions.push(fileModifiedAssertion(f))
      } else if (asksToCreate(text, f)) {
        assertions.push(fileExistsAssertion(f))
      }
      // Otherwise: a filename in prose naming nothing on disk. The engine
      // cannot tell a target from a mention, and an assertion it cannot tell
      // the truth about is worse than one less assertion.
    }
    if (assertions.length === 0) {
      assertions.push('Code was modified to address the task')
    }
    // The engine does not get to overrule the user about what the task is. On
    // the live L2 run this assertion was appended to a message that said "Do
    // not commit", the model committed to satisfy the contract, and then cited
    // that forbidden commit as its evidence.
    if (!/\b(do not|do n't|don'?t|never|without)\s+commit(ting)?\b/i.test(text)) {
      assertions.push(COMMITTED_ASSERTION)
    }
  } else if (isAnalysisTask) {
    assertions.push('Analysis or answer was provided to the user')
    assertions.push('Response directly addresses what the user asked')
  } else if (isRunTask) {
    assertions.push('Command was executed')
    assertions.push('Output or result was reported to the user')
  } else {
    // Default: treat as a general task
    assertions.push('Task was completed — user request fully addressed')
  }

  return assertions
}

/**
 * Auto-create a contract for this user message. Returns true when a contract
 * was created. Keeps an INCOMPLETE active contract; replaces a COMPLETE one.
 */
export function maybeAutoCreateContract(
  text: string,
  cwd: string,
  contract: ContractState = globalContract,
): boolean {
  if (contract.isActive() && !contract.isComplete()) return false
  if (text.length <= 15) return false
  contract.create(text.slice(0, 60), text.slice(0, 200), synthesizeMessageAssertions(text, cwd))
  return true
}

/** Apply a harness-supplied contract spec. Returns true when applied. */
export function applyHarnessContract(spec: HarnessContractSpec | undefined, contract: ContractState = globalContract): boolean {
  if (!spec || !spec.title || !Array.isArray(spec.assertions) || spec.assertions.length === 0) return false
  if (contract.isActive() && !contract.isComplete()) {
    console.log(`[contract] Harness contract replacing an incomplete active contract ("${spec.title}")`)
  }
  // Authored by whoever wrote the brief, so this one is a specification and the
  // reward labeler may score against it.
  contract.create(spec.title, spec.brief ?? '', spec.assertions, 'harness')
  return true
}
