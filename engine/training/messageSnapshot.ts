/**
 * Prepare a conversation for persistence as training data.
 *
 * The snapshot is the training corpus, so it holds verbatim repo source and
 * anything else the agent read. Three policies apply at write time:
 *   - truncate individual tool results (one Read of a large file would
 *     otherwise dominate the example and balloon the corpus)
 *   - redact results whose originating tool touched a sensitive path
 *   - cap the whole snapshot, dropping oldest non-system messages
 *
 * Pure: no I/O, no mutation of the input.
 */

import type { Message, ContentBlock } from '../types.js'

export const RESULT_CAP_BYTES = 4096
export const FILE_CAP_BYTES = 2 * 1024 * 1024

const SENSITIVE =
  /(^|[\s\/\\.])(\.env|env\.local)([\s\/\\.]|$)|credentials|secrets?\b|\.pem\b|id_rsa|\.p12\b|\.pfx\b/i

export type SanitizeOptions = {
  resultCapBytes?: number
  fileCapBytes?: number
}

export type SanitizeResult = {
  messages: Message[]
  truncatedMessages: number
}

/** Any string in a tool input that looks like a sensitive path or file. */
function inputTouchesSensitive(input: unknown): boolean {
  if (input === null || input === undefined) return false
  if (typeof input === 'string') return SENSITIVE.test(input)
  if (Array.isArray(input)) return input.some(inputTouchesSensitive)
  if (typeof input === 'object') return Object.values(input as Record<string, unknown>).some(inputTouchesSensitive)
  return false
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  const half = Math.floor(cap / 2)
  const elided = text.length - half * 2
  return `${text.slice(0, half)}\n…[${elided} bytes elided]…\n${text.slice(-half)}`
}

function blockText(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content
  return content.map(b => ('text' in b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('')
}

/**
 * Sanitize a conversation for persistence. Returns a deep-copied array; the
 * input is never mutated.
 */
export function sanitizeMessages(messages: Message[], opts: SanitizeOptions = {}): SanitizeResult {
  const resultCap = opts.resultCapBytes ?? RESULT_CAP_BYTES
  const fileCap = opts.fileCapBytes ?? FILE_CAP_BYTES

  // Map tool_use_id → whether that call touched a sensitive path.
  const sensitiveCalls = new Set<string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && inputTouchesSensitive(b.input)) sensitiveCalls.add(b.id)
    }
  }

  const cleaned: Message[] = messages.map(m => ({
    role: m.role,
    content: m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result') return { ...b }
      if (sensitiveCalls.has(b.tool_use_id)) {
        return { ...b, content: '[redacted: sensitive path]' }
      }
      return { ...b, content: truncate(blockText(b.content), resultCap) }
    }),
  }))

  // Whole-file cap: drop oldest non-system messages until it fits.
  let truncatedMessages = 0
  const kept = [...cleaned]
  while (JSON.stringify(kept).length > fileCap && kept.length > 1) {
    const idx = kept.findIndex(m => m.role !== 'system')
    if (idx === -1 || idx === kept.length - 1) break
    kept.splice(idx, 1)
    truncatedMessages++
  }

  return { messages: kept, truncatedMessages }
}
