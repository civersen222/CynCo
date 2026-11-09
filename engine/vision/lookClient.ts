/**
 * engine/vision/lookClient.ts — one look at one picture, on the image box.
 *
 * The 5090's chat model is text-only. A photo attached in a project chat is
 * sent once to the vision model on the 4070 Ti Super box (Ollama `/api/chat`
 * with `images`) with a fixed instruction that asks, in order, for the visible
 * text, the state of things, and a description — the diagnostic use case
 * itself ("which line do I pick", "is this light supposed to be red"), so the
 * answer needs no aiming by the user's question. The reply is parsed by those
 * three labels; a missing label is an empty section, never a failure.
 *
 * Plain `fetch`, never `fetchGuarded`: that helper refuses 192.168/16 and the
 * box's address is the operator's choice. Bounded by a fixed 60 s deadline,
 * cold load included; every failure is a reason string the caller can show.
 * Design: docs/decisions/2026-11-08-image-box-design.md (sections 2 and 3).
 */
import { visionSettings } from './settings.js'

export const LOOK_INSTRUCTION = [
  'Look at this picture and answer in exactly three labelled sections, in this order.',
  'TEXT: every word visible in the picture, transcribed faithfully — menu lines, error messages, labels, numbers, file names. Keep line breaks. Write "none" if there is no text.',
  'STATE: the state of things — lights and their colours, cables and which ports they are in, switches, what is selected or highlighted on a screen. Write "none" if nothing applies.',
  'DESCRIPTION: one paragraph describing the picture for someone who cannot see it.',
].join('\n')

export type Look = { text: string; state: string; description: string; model: string; ms: number }
export type LookResult = { ok: true; look: Look } | { ok: false; reason: string }

export const LOOK_TIMEOUT_MS = 60_000
/**
 * Ollama's default window is 4096 tokens; a 12 MP phone photo alone is ~4100 image
 * tokens on qwen3-vl (Ollama caps the image near 4 MP), so the first real photo was
 * refused with HTTP 400 (F190). 8192 holds the capped image, the instruction and the
 * answer; the dashboard also shrinks uploads to 3 MP (~2900 tokens) before they arrive.
 */
export const LOOK_NUM_CTX = 8192
const LABELS = ['TEXT', 'STATE', 'DESCRIPTION'] as const

/** Split the reply by its three labels; a label that is missing yields ''. */
export function parseLook(content: string): Pick<Look, 'text' | 'state' | 'description'> {
  const out = { text: '', state: '', description: '' }
  const re = /(?:^|\n)\s*\**(TEXT|STATE|DESCRIPTION)\**\s*:\s*/g
  const hits: Array<{ label: typeof LABELS[number]; start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) hits.push({ label: m[1] as typeof LABELS[number], start: m.index, end: m.index + m[0].length })
  for (let i = 0; i < hits.length; i++) {
    const body = content.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined).trim()
    const key = hits[i].label.toLowerCase() as 'text' | 'state' | 'description'
    if (!out[key]) out[key] = body === 'none' ? '' : body
  }
  return out
}

export class LookClient {
  private readonly url: string
  private readonly model: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(opts: { url: string; model: string; fetchFn?: typeof fetch; timeoutMs?: number; now?: () => number }) {
    this.url = opts.url.replace(/\/+$/, '')
    this.model = opts.model
    this.fetchFn = opts.fetchFn ?? fetch
    this.timeoutMs = opts.timeoutMs ?? LOOK_TIMEOUT_MS
    this.now = opts.now ?? (() => Date.now())
  }

  async look(image: Uint8Array, _mime: string): Promise<LookResult> {
    const started = this.now()
    try {
      const resp = await this.fetchFn(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          keep_alive: '10m',
          options: { num_ctx: LOOK_NUM_CTX },
          messages: [{ role: 'user', content: LOOK_INSTRUCTION, images: [Buffer.from(image).toString('base64')] }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!resp.ok) {
        const body = (await resp.text().catch(() => '')).slice(0, 200)
        return { ok: false, reason: `image box did not answer: HTTP ${resp.status}${body ? ` ${body}` : ''}` }
      }
      const data = (await resp.json()) as { model?: string; message?: { content?: string } }
      const parsed = parseLook(data.message?.content ?? '')
      return { ok: true, look: { ...parsed, model: data.model ?? this.model, ms: this.now() - started } }
    } catch (e) {
      return { ok: false, reason: `image box did not answer: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
}

/** The client the settings describe, or null when no image box is configured. */
export function makeLookClient(env: NodeJS.ProcessEnv = process.env): LookClient | null {
  const s = visionSettings(env)
  return s.url ? new LookClient({ url: s.url, model: s.model }) : null
}
