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
import type { Look, LookClient } from './lookClient.js'
import type { IngestEvent } from '../projects/ingest.js'
import type { LookInput } from '../projects/extract/types.js'

export const PENDING_REASON = 'looking at the picture…'
const DEFAULT_RECENT_CAP = 20

export type LookFinish = (slug: string, rel: string, input: LookInput) => Promise<IngestEvent>

export class LookRunner {
  private readonly inflight = new Map<string, Promise<IngestEvent>>()
  private readonly recentLooks = new Map<string, Look>()
  private readonly cap: number

  constructor(private readonly deps: { client: LookClient; finish: LookFinish; log: (line: string) => void; recentCap?: number }) {
    this.cap = deps.recentCap ?? DEFAULT_RECENT_CAP
  }

  start(slug: string, rel: string, bytes: Uint8Array, mime: string): void {
    const key = `${slug}/${rel}`
    if (this.inflight.has(key)) return
    const run = (async (): Promise<IngestEvent> => {
      const r = await this.deps.client.look(bytes, mime)
      let input: LookInput
      if (r.ok) {
        this.remember(key, r.look)
        this.deps.log(`[vision] looked at ${key} (${r.look.model}, ${(r.look.ms / 1000).toFixed(1)} s)`)
        input = { look: r.look }
      } else {
        this.deps.log(`[vision] ${key}: ${r.reason}`)
        input = { failure: r.reason }
      }
      try {
        return await this.deps.finish(slug, rel, input)
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, run)
    run.catch(e => this.deps.log(`[vision] finishing ${key} failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  pending(slug: string, rel: string): Promise<IngestEvent> | null {
    return this.inflight.get(`${slug}/${rel}`) ?? null
  }

  recent(slug: string, rel: string): Look | null {
    return this.recentLooks.get(`${slug}/${rel}`) ?? null
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
