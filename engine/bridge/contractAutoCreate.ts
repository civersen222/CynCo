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

import { ContractState, globalContract } from '../tools/contract.js'

export type HarnessContractSpec = {
  title: string
  brief?: string
  assertions: string[]
}

/** Intent-classified assertions for a user message (moved from conversationLoop). */
export function synthesizeMessageAssertions(text: string): string[] {
  const lowerText = text.toLowerCase()
  const assertions: string[] = []

  // Classify intent
  const isEditTask = /\b(edit|add|create|write|fix|change|modify|delete|remove|wire|implement|refactor|build|update|move|rename)\b/.test(lowerText)
  const isAnalysisTask = /\b(analyze|explain|describe|summarize|review|compare|investigate|trace|debug|diagnose|why|how does|what is|what are|tell me|show me|find|search|look at|check)\b/.test(lowerText)
  const isRunTask = /\b(run|test|execute|deploy|install|start|launch|build)\b/.test(lowerText)

  if (isEditTask) {
    // Extract file targets from the message
    const fileMatches = text.match(/[\w./\\-]+\.(py|ts|js|tsx|jsx|rs|go|java|c|cpp|h|html|css|json|yaml|yml|toml|md)\b/g)
    if (fileMatches) {
      for (const f of [...new Set(fileMatches)].slice(0, 3)) {
        if (/\b(create|write|new file)\b/i.test(text) && text.includes(f)) {
          assertions.push(`File ${f} exists after changes`)
        } else {
          assertions.push(`File ${f} was modified (git diff shows changes)`)
        }
      }
    }
    if (assertions.length === 0) {
      assertions.push('Code was modified to address the task')
    }
    assertions.push('Changes committed to git')
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
export function maybeAutoCreateContract(text: string, contract: ContractState = globalContract): boolean {
  if (contract.isActive() && !contract.isComplete()) return false
  if (text.length <= 15) return false
  contract.create(text.slice(0, 60), text.slice(0, 200), synthesizeMessageAssertions(text))
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
