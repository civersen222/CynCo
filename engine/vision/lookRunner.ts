/**
 * engine/vision/lookRunner.ts — looks run behind the upload, never in front
 * of the phone.
 *
 * `addKnowledgeApi` writes an image, records it as "looking at the picture…",
 * answers the POST, and calls `start`. The runner asks the image box once per
 * `<slug>/<rel>` (a second `start` on a pending key is a no-op), then hands
 * the result to `finish` — the ingest, bound by `makeProjectsDeps` — which
 * writes the record, the chunks and the `project.ingest` event. `pending`
 * lets the loop wait, bounded by the client's own deadline, for a look still
 * in flight; `recent` serves a finished look to the turn's knowledge block and
 * to a rescan without asking the box again (a small LRU; a restart loses it,
 * and a rescan then re-looks).
 * Design: docs/decisions/2026-11-08-image-box-design.md (sections 2 and 3).
 */
import type { AskResult, Look, LookClient } from './lookClient.js'
import type { IngestEvent } from '../projects/ingest.js'
import type { LookInput } from '../projects/extract/types.js'
import { sha256Of } from '../projects/layout.js'

export const PENDING_REASON = 'looking at the picture…'
const DEFAULT_RECENT_CAP = 20

export type LookFinish = (slug: string, rel: string, input: LookInput) => Promise<IngestEvent>

export class LookRunner {
  /** In-flight looks by `<slug>/<rel>@<sha256>`: the same bytes never run twice at once. */
  private readonly inflight = new Map<string, Promise<IngestEvent>>()
  /** Finished looks by the same key (LRU): the turn, a re-attach of the same bytes and a rescan reuse them. */
  private readonly recentLooks = new Map<string, Look>()
  /** The sha256 last started under each `<slug>/<rel>`: what `pending`/`recent` by name resolve to, and what a stale look is checked against. */
  private readonly latest = new Map<string, string>()
  private readonly cap: number

  constructor(private readonly deps: { client: LookClient; finish: LookFinish; log: (line: string) => void; recentCap?: number }) {
    this.cap = deps.recentCap ?? DEFAULT_RECENT_CAP
  }

  start(slug: string, rel: string, bytes: Uint8Array, mime: string): void {
    const relKey = `${slug}/${rel}`
    const sha = sha256Of(bytes)
    const key = `${relKey}@${sha}`
    this.latest.set(relKey, sha)
    if (this.inflight.has(key)) return
    const known = this.recentLooks.get(key)
    const run = (async (): Promise<IngestEvent> => {
      let input: LookInput
      if (known) {
        // The same bytes again (re-attached, or a rescan): no second look, the record is simply made again.
        input = { look: known }
      } else {
        const r = await this.deps.client.look(bytes, mime)
        if (r.ok) {
          this.remember(key, r.look)
          this.deps.log(`[vision] looked at ${relKey} (${r.look.model}, ${(r.look.ms / 1000).toFixed(1)} s)`)
          input = { look: r.look }
        } else {
          this.deps.log(`[vision] ${relKey}: ${r.reason}`)
          input = { failure: r.reason }
        }
      }
      try {
        if (this.latest.get(relKey) !== sha) {
          // Other bytes were uploaded under this name while we looked: their look finishes the file, not this one.
          this.deps.log(`[vision] ${relKey}: look superseded by a newer upload; not recorded`)
          return { slug, filePath: `knowledge/${rel}`, kind: 'knowledge', indexed: false, reason: 'superseded by a newer upload' }
        }
        return await this.deps.finish(slug, rel, input)
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, run)
    run.catch(e => this.deps.log(`[vision] finishing ${relKey} failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** The look in flight for these bytes (by sha, or the latest started under the name), or null. */
  /** The LookAt tool's path: one aimed question, straight to the box; nothing queued, cached or ingested (F191). */
  ask(bytes: Uint8Array, mime: string, question: string): Promise<AskResult> {
    return this.deps.client.ask(bytes, mime, question)
  }

  pending(slug: string, rel: string, sha?: string): Promise<IngestEvent> | null {
    const k = this.keyFor(slug, rel, sha)
    return k ? this.inflight.get(k) ?? null : null
  }

  /** A finished look for these bytes (by sha, or the latest started under the name), or null. */
  recent(slug: string, rel: string, sha?: string): Look | null {
    const k = this.keyFor(slug, rel, sha)
    return k ? this.recentLooks.get(k) ?? null : null
  }

  private keyFor(slug: string, rel: string, sha?: string): string | null {
    const relKey = `${slug}/${rel}`
    const s = sha ?? this.latest.get(relKey)
    return s ? `${relKey}@${s}` : null
  }

  private remember(key: string, look: Look): void {
    this.recentLooks.delete(key)
    this.recentLooks.set(key, look)
    while (this.recentLooks.size > this.cap) {
      const oldest = this.recentLooks.keys().next().value
      if (oldest === undefined) break
      this.recentLooks.delete(oldest)
    }
  }
}

/** The MIME type an image extension implies, for the look request. */
export function imageMime(fileName: string): string {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
}
