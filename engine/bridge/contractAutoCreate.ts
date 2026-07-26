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
export function synthesizeMessageAssertions(text: string, cwd: string): string[] {
  const lowerText = text.toLowerCase()
  const assertions: string[] = []

  // Classify intent
  const isEditTask = /\b(edit|add|create|write|fix|change|modify|delete|remove|wire|implement|refactor|build|update|move|rename)\b/.test(lowerText)
  const isAnalysisTask = /\b(analyze|explain|describe|summarize|review|compare|investigate|trace|debug|diagnose|why|how does|what is|what are|tell me|show me|find|search|look at|check)\b/.test(lowerText)
  const isRunTask = /\b(run|test|execute|deploy|install|start|launch|build)\b/.test(lowerText)

  if (isEditTask) {
    // Extract file targets from the message
    const fileMatches = text.match(/[\w./\\-]+\.(py|ts|js|tsx|jsx|rs|go|java|c|cpp|h|html|css|json|yaml|yml|toml|md)\b/g)
    const wantsNewFile = /\b(create|write|new file)\b/i.test(text)
    if (fileMatches) {
      for (const f of new Set(fileMatches)) {
        if (assertions.length >= 3) break
        if (existsSync(isAbsolute(f) ? f : resolve(cwd, f))) {
          // It is there, so "exists after changes" is true before a keystroke is
          // typed. The claim worth making is that the work touched it.
          assertions.push(fileModifiedAssertion(f))
        } else if (wantsNewFile) {
          assertions.push(fileExistsAssertion(f))
        }
        // Otherwise: a filename in prose naming nothing on disk. The engine
        // cannot tell a target from a mention, and an assertion it cannot tell
        // the truth about is worse than one less assertion.
      }
    }
    if (assertions.length === 0) {
      assertions.push('Code was modified to address the task')
    }
    assertions.push(COMMITTED_ASSERTION)
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
  contract.create(spec.title, spec.brief ?? '', spec.assertions)
  return true
}
