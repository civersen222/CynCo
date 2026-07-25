/**
 * Prepare a conversation for persistence as training data.
 *
 * The snapshot is the training corpus, so it holds verbatim repo source and
 * anything else the agent read or wrote. These policies apply at write time:
 *   - truncate individual tool results (one Read of a large file would
 *     otherwise dominate the example and balloon the corpus)
 *   - redact results whose originating tool touched a sensitive path
 *   - redact and truncate the tool call's own INPUT on the same terms — a
 *     `Write` puts its payload in the input, so capping only results let a
 *     whole file, secrets included, through untouched
 *   - redact secret-SHAPED values wherever they appear, independent of any
 *     path (see SECRET_VALUE)
 *   - redact any tool_result whose originating tool_use is not in the array —
 *     an unprovenanced payload cannot be cleared by the path check at all
 *   - cap every text-bearing block, not only tool results, and replace
 *     binary/base64 payloads with a marker
 *   - cap the whole snapshot, dropping oldest non-system messages
 *
 * Pure: no I/O, no mutation of the input.
 */

import type { Message, ContentBlock } from '../types.js'

export const RESULT_CAP_BYTES = 4096
export const FILE_CAP_BYTES = 2 * 1024 * 1024

// Deliberately biased toward over-redaction: `credentials` matches bare (so
// `docs/credentials-guide.md` is redacted too). Losing a benign example costs
// corpus volume; leaking one secret costs the corpus.
//
// This reads tool *inputs* only — it is a check on the NAME of the thing being
// touched. A secret that only ever appears in output, `echo $OPENAI_API_KEY`,
// has no sensitive path to key on; so does a real key pasted into
// `src/config.ts`. SECRET_VALUE below covers that case by keying on the shape
// of the value instead, and the two checks are independent: a payload has to
// clear both.
const SENSITIVE =
  /(^|[\s\/\\.])(\.env|env\.local)([\s\/\\.]|$)|credentials|secrets?\b|\.pem\b|id_rsa|\.p12\b|\.pfx\b/i

/**
 * Values that are secrets by their own shape, wherever they appear.
 *
 * Unlike a sensitive path, a secret-shaped value says nothing about whether
 * the surrounding conversation is worth keeping — so only the matched span is
 * replaced, and the text around it survives as training signal.
 *
 * Length floors are set below the real minimum for each vendor prefix
 * (an OpenAI key is far longer than `sk-` + 8), on the same over-redaction
 * bias: a false positive costs one mangled span, a false negative costs the
 * corpus.
 */
const SECRET_VALUE: RegExp[] = [
  // A terminated PEM block, then an unterminated one running to end of string.
  // Order matters: the greedy tail rule would otherwise swallow the terminator.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g,
  // OpenAI / Anthropic-style: sk-, sk-proj-, sk-ant-…
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // GitHub: classic PAT and fine-grained PAT.
  /\bghp_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{8,}/g,
  // Slack bot/app/user/refresh/… tokens.
  /\bxox[baprse]-[A-Za-z0-9-]{8,}/g,
]

export const SECRET_MARKER = '[redacted: secret]'
export const ORPHAN_MARKER = '[redacted: orphaned tool result]'
export const BINARY_MARKER = '[redacted: binary payload]'

/**
 * Replace every secret-shaped span in a string with SECRET_MARKER.
 *
 * Must run BEFORE truncate(): truncation keeps the head and the tail, so a key
 * sitting in the retained tail of an oversized file would survive verbatim.
 */
export function redactSecretValues(text: string): string {
  let out = text
  for (const re of SECRET_VALUE) {
    re.lastIndex = 0
    out = out.replace(re, SECRET_MARKER)
  }
  return out
}

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
  if (typeof value === 'string') return capText(value, cap)
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
 * The single treatment every free-text string in the snapshot gets: strip
 * secret-shaped spans, then cap the length. Always in that order — see
 * redactSecretValues.
 */
function capText(text: string, cap: number): string {
  return truncate(redactSecretValues(text), cap)
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
 * Sanitize one non-tool block: cap what is text, drop what is bytes.
 *
 * Everything in the ContentBlock union that is not tool_use/tool_result is
 * handled explicitly, because passing a block through untouched means passing
 * it through UNCAPPED and UNREDACTED. That mattered twice:
 *
 *  - image/document base64 and redacted_thinking `data` are megabyte-scale,
 *    carry no signal in a text corpus, and are already rendered as
 *    "[image block omitted]" by datasetBuilder — so storing them only spends
 *    the 2 MB file cap, evicting real messages to keep bytes nobody trains on.
 *  - text/thinking/connector_text were uncapped while tool results were capped
 *    at 4 KB, which is the wrong way round: a model can emit an arbitrarily
 *    long turn.
 */
function sanitizeOtherBlock(b: ContentBlock, cap: number): ContentBlock {
  switch (b.type) {
    case 'text':
    case 'thinking':
    case 'connector_text':
      return typeof b.text === 'string' ? { ...b, text: capText(b.text, cap) } : { ...b }
    case 'redacted_thinking':
      // An opaque provider blob. Nothing readable to train on, so only its
      // presence is recorded.
      return { ...b, data: BINARY_MARKER }
    case 'image':
      return { ...b, source: { ...b.source, data: BINARY_MARKER } }
    case 'document': {
      const src = b.source
      if (src && src.type === 'text') return { ...b, source: { ...src, text: capText(src.text ?? '', cap) } }
      if (src && src.type === 'url') return { ...b, source: { ...src, url: capText(src.url ?? '', cap) } }
      return { ...b, source: { ...(src as Record<string, unknown>), data: BINARY_MARKER } as typeof b.source }
    }
    default:
      return { ...b }
  }
}

/**
 * Sanitize a conversation for persistence. Returns a deep-copied array; the
 * input is never mutated.
 */
export function sanitizeMessages(messages: Message[], opts: SanitizeOptions = {}): SanitizeResult {
  const resultCap = opts.resultCapBytes ?? RESULT_CAP_BYTES
  const fileCap = opts.fileCapBytes ?? FILE_CAP_BYTES

  // Two passes over the tool_use blocks: which ids exist at all, and which of
  // those touched a sensitive path.
  const knownCalls = new Set<string>()
  const sensitiveCalls = new Set<string>()
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_use') continue
      knownCalls.add(b.id)
      if (inputTouchesSensitive(b.input)) sensitiveCalls.add(b.id)
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
      if (b.type !== 'tool_result') return sanitizeOtherBlock(b, resultCap)
      if (sensitiveCalls.has(b.tool_use_id)) {
        return { ...b, content: '[redacted: sensitive path]' }
      }
      // Fail closed on an orphan. The sensitive-path check is the ONLY thing
      // that can clear a result payload, and it can only run when the
      // originating tool_use is in the array. It is not always: compactNow
      // (conversationLoop) replaces this.messages wholesale with a compacted
      // array, and pruneRedundantReads rewrites it — either can drop the
      // assistant turn holding Read({file_path: '.env'}) while keeping the
      // result. The snapshot is taken later, at finalize, so what lands here
      // is the rewritten array. Treating that as "not sensitive" and merely
      // capping it at 4 KB writes most config files verbatim into the corpus.
      // A result whose provenance cannot be established is not clearable, so
      // it is dropped. Marker is distinct from the path one so a reader of the
      // corpus can tell the two reasons apart.
      if (typeof b.tool_use_id !== 'string' || !knownCalls.has(b.tool_use_id)) {
        return { ...b, content: ORPHAN_MARKER }
      }
      return { ...b, content: capText(blockText(b.content), resultCap) }
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
