/**
 * System prompt utilities for the CynCo conversation engine.
 *
 * Converts system prompt arrays into content blocks for the LLM.
 */

import type { SystemPrompt } from '../types.js'

// ─── Types ─────────────────────────────────────────────────────

/** A simple text content block. */
export type TextBlock = { type: 'text'; text: string }

// ─── buildSystemPromptBlocks ───────────────────────────────────

/**
 * Convert a branded SystemPrompt string array into TextBlock[].
 * Filters empty strings and wraps each in a text block.
 */
export function buildSystemPromptBlocks(systemPrompt: SystemPrompt): TextBlock[] {
  return (systemPrompt as readonly string[])
    .filter(text => text !== '')
    .map(text => ({ type: 'text' as const, text }))
}

// ─── Stubs ───────────────────────────────────────────────────

/** No-op — reserved for future cache control. */
export function addCacheBreakpoints(..._args: unknown[]): void {}

/** Returns empty metadata. */
export function getAPIMetadata(): Record<string, unknown> {
  return {}
}

/** No-op stream cleanup stub. */
export function cleanupStream(..._args: unknown[]): void {}
