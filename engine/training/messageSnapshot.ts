/**
 * Prepare a conversation for persistence as training data.
 *
 * The snapshot is the training corpus, so it holds verbatim repo source and
 * anything else the agent read or wrote. Four policies apply at write time:
 *   - truncate individual tool results (one Read of a large file would
 *     otherwise dominate the example and balloon the corpus)
 *   - redact results whose originating tool touched a sensitive path
 *   - redact and truncate the tool call's own INPUT on the same terms — a
 *     `Write` puts its payload in the input, so capping only results let a
 *     whole file, secrets included, through untouched
 *   - cap the whole snapshot, dropping oldest non-system messages
 *
 * Pure: no I/O, no mutation of the input.
 */

import type { Message, ContentBlock } from '../types.js'

export const RESULT_CAP_BYTES = 4096
export const FILE_CAP_BYTES = 2 * 1024 * 1024

// Deliberately biased toward over-redaction: `credentials` matches bare (so
// `docs/credentials-guide.md` is redacted too). Losing a benign example costs
// corpus volume; leaking one secret costs the corpus. Known limit: this reads
// tool *inputs*, so a secret that only ever appears in output — `echo
// $OPENAI_API_KEY` — is not caught.
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

/**
 * Truncate every string inside a tool input, in place of the whole input.
 *
 * `Write`/`Edit` carry their payload as an input field, so an uncapped input
 * is an uncapped file in the corpus. Truncating per-string rather than
 * replacing the object keeps `file_path` and the other short arguments
 * learnable — the structure of the call is the signal, its payload is not.
 */
function capInput(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return truncate(value, cap)
  if (Array.isArray(value)) return value.map(v => capInput(v, cap))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capInput(v, cap)
    return out
  }
  return value
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  const half = Math.floor(cap / 2)
  const elided = text.length - half * 2
  return `${text.slice(0, half)}\n…[${elided} bytes elided]…\n${text.slice(-half)}`
}

/**
 * Flatten a tool result to text. Non-text blocks (images, documents) carry no
 * training signal in a text corpus, so they are replaced by a visible marker
 * rather than dropped silently — a reader of the corpus should be able to tell
 * that something was there.
 */
function blockText(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content
  return content
    .map(b =>
      'text' in b && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : `[${b.type} block omitted]`,
    )
    .join('')
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
      if (b.type === 'tool_use') {
        // The call that names a secret also usually carries it. Keep the tool
        // name so the corpus still shows what was attempted.
        return sensitiveCalls.has(b.id)
          ? { ...b, input: { redacted: 'sensitive path' } }
          : { ...b, input: capInput(b.input, resultCap) as Record<string, unknown> }
      }
      if (b.type !== 'tool_result') return { ...b }
      if (sensitiveCalls.has(b.tool_use_id)) {
        return { ...b, content: '[redacted: sensitive path]' }
      }
      return { ...b, content: truncate(blockText(b.content), resultCap) }
    }),
  }))

  // Whole-file cap: drop oldest non-system messages until it fits. Sizes are
  // measured once and tracked incrementally — re-serializing the whole array
  // each iteration is quadratic, and this runs on multi-megabyte inputs.
  let truncatedMessages = 0
  const kept = [...cleaned]
  const sizes = kept.map(m => JSON.stringify(m).length)
  // JSON.stringify of an array: "[" + parts joined by "," + "]"
  let total = 2 + sizes.reduce((a, b) => a + b, 0) + Math.max(0, kept.length - 1)
  while (total > fileCap && kept.length > 1) {
    const idx = kept.findIndex(m => m.role !== 'system')
    if (idx === -1 || idx === kept.length - 1) break
    kept.splice(idx, 1)
    total -= sizes[idx] + 1 // the message plus its separating comma
    sizes.splice(idx, 1)
    truncatedMessages++
  }

  return { messages: kept, truncatedMessages }
}
