/**
 * Helpers for deciding when to inject a summary-request message into a conversation
 * that has completed tool use but produced no explanatory text from the model.
 *
 * See design spec: docs/superpowers/specs/2026-04-16-ux-completion-design.md §3
 */

import type { Message } from '../types.js'

const SUMMARY_TEXT_THRESHOLD_CHARS = 40

/**
 * Decide whether the current exiting turn warrants an injected summary request.
 *
 * Returns true iff ALL of:
 *   - stop reason is 'end_turn' (natural completion, not error/abort/truncation)
 *   - at least one tool was used at some point in this session (runModelLoop invocation)
 *   - the model's final assistant text, after whitespace strip, is < 40 chars
 *   - we have not already injected a summary during this session (single-shot)
 */
export function shouldInjectSummary(
  assistantText: string,
  stopReason: string,
  toolsUsedInSession: string[],
  alreadyInjected: boolean,
): boolean {
  if (alreadyInjected) return false
  if (stopReason !== 'end_turn') return false
  if (toolsUsedInSession.length === 0) return false
  const stripped = assistantText.trim()
  if (stripped.length >= SUMMARY_TEXT_THRESHOLD_CHARS) return false
  return true
}

/**
 * Build a user message that asks the model to summarize what it just did.
 */
export function buildSummaryInjectionMessage(toolsUsedInSession: string[]): Message {
  const unique = Array.from(new Set(toolsUsedInSession))
  let phrasing: string
  if (unique.length === 0) {
    phrasing = 'Before we wrap up, briefly summarize what you just accomplished — 2–3 sentences is plenty.'
  } else if (unique.length === 1) {
    phrasing = `Before we wrap up, briefly summarize what you just did with the ${unique[0]} tool — 2–3 sentences is plenty.`
  } else {
    const list = unique.join(', ')
    phrasing = `Before we wrap up, briefly summarize what you just did with the ${list} tools — 2–3 sentences is plenty.`
  }
  return {
    role: 'user',
    content: [{ type: 'text', text: phrasing }],
  }
}
