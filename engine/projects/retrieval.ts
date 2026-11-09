/**
 * engine/projects/retrieval.ts — the per-turn knowledge block.
 *
 * Built from search hits, numbered, cited by file › heading (ordinal), cut
 * to a token budget (chars/4, the engine's working estimate) and at most
 * MAX_PASSAGES. The block is injected as a system message tagged
 * RETRIEVAL_TAG so the loop can find and replace the previous one (R4).
 */
import type { SearchHit } from './search.js'
import type { IngestEvent } from './ingest.js'
import type { Look } from '../vision/lookClient.js'
import { IMAGE_EXTS } from './extract/index.js'
import { PENDING_REASON } from '../vision/lookRunner.js'

export const RETRIEVAL_TAG = '[Project knowledge]'
export const MAX_PASSAGES = 8
export type Citation = { n: number; filePath: string; heading: string; ordinal: number }

export function retrievalShare(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOCALCODE_PROJECTS_RETRIEVAL_SHARE)
  if (!Number.isFinite(n) || n <= 0) return 0.15
  return Math.min(0.5, Math.max(0.02, n))
}

const tokens = (s: string) => Math.ceil(s.length / 4)

export function buildRetrievalBlock(hits: SearchHit[], tokenBudget: number): { text: string; citations: Citation[] } | null {
  if (!hits.length) return null
  const header = `${RETRIEVAL_TAG}\nRelevant passages from this project. Cite a passage as [n] when you use it.\n`
  let used = tokens(header)
  const parts: string[] = []
  const citations: Citation[] = []
  for (const h of hits.slice(0, MAX_PASSAGES)) {
    const n = citations.length + 1
    const entry = `\n[${n}] ${h.filePath} › ${h.heading} (${h.ordinal})\n${h.passage.trim()}\n`
    if (used + tokens(entry) > tokenBudget && citations.length > 0) break
    if (used + tokens(entry) > tokenBudget) {
      const room = Math.max(0, tokenBudget - used) * 4
      const cut = `\n[${n}] ${h.filePath} › ${h.heading} (${h.ordinal})\n${h.passage.trim().slice(0, room)}…\n`
      parts.push(cut); citations.push({ n, filePath: h.filePath, heading: h.heading, ordinal: h.ordinal }); break
    }
    parts.push(entry)
    citations.push({ n, filePath: h.filePath, heading: h.heading, ordinal: h.ordinal })
    used += tokens(entry)
  }
  return { text: header + parts.join(''), citations }
}

export function citationsUsed(assistantText: string, citations: Citation[]): Citation[] {
  const seen = new Set<number>()
  const out: Citation[] = []
  for (const m of assistantText.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1])
    if (seen.has(n)) continue
    const c = citations.find(x => x.n === n)
    if (c) { seen.add(n); out.push(c) }
  }
  return out
}

/**
 * Files added to the project since the model's last turn — uploads from the
 * dashboard or the phone's Attach button, research saves — as a fact the model
 * is told at the top of the next `[Project knowledge]` block. Without it a
 * phone that attached a docx and asked "did you get it?" was answered from an
 * `Ls` of the wrong folder: "nothing landed" (2026-11-08). Chat ingests are
 * not files the user added and are skipped; only this project's events count.
 */
export class IngestNotes {
  private pending: IngestEvent[] = []
  constructor(readonly slug: string, private readonly cap = 20) {}

  add(ev: IngestEvent): void {
    if (ev.slug !== this.slug || ev.kind === 'chat') return
    this.pending.push(ev)
    if (this.pending.length > this.cap) this.pending.splice(0, this.pending.length - this.cap)
  }

  /** The events since the last turn; drains. The loop reads attached pictures out of these (image box §2). */
  takeEvents(): IngestEvent[] {
    const out = this.pending
    this.pending = []
    return out
  }

  /** The block text, or null when nothing was added; drains. */
  take(): string | null {
    return formatNotes(this.takeEvents())
  }
}

export function formatNotes(events: IngestEvent[]): string | null {
  // A picture still being looked at is the look block's to report (or the refusal line's), not a "not indexed" entry.
  const listed = events.filter(e => e.reason !== PENDING_REASON)
  if (listed.length === 0) return null
  const lines = listed.map(e => `- ${e.filePath} — ${e.indexed ? `indexed (${e.chunks ?? 0} passage(s))` : `kept, not vector-indexed: ${e.reason ?? 'no reason given'}`}`)
  return `${RETRIEVAL_TAG}\nFiles added to this project since your last turn (uploaded or saved; they live at the paths shown, under the project folder):\n${lines.join('\n')}\n`
}

/** The pictures among the files added since the last turn: `knowledge/<rel>` paths with an image extension, in order, once each. */
export function attachedImages(events: IngestEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (!e.filePath.startsWith('knowledge/')) continue
    const ext = e.filePath.toLowerCase().slice(e.filePath.lastIndexOf('.'))
    if (!IMAGE_EXTS.has(ext) || out.includes(e.filePath)) continue
    out.push(e.filePath)
  }
  return out
}

/**
 * What the image box saw, for the model: text first (the diagnostic use case),
 * then state, then description; empty parts omitted. Tagged like the rest of
 * the per-turn block so the loop replaces it next turn.
 */
export function formatLookBlock(filePath: string, look: Look): string {
  const parts = [look.text && `text: ${look.text}`, look.state && `state: ${look.state}`, look.description && `description: ${look.description}`].filter((p): p is string => !!p)
  return `${RETRIEVAL_TAG}\n[Attached image] ${filePath} — what the image box read off it:\n${parts.join('\n')}\n`
}

/**
 * The block when the look did not happen (box asleep, refused, or no box configured).
 * Silence here is not neutral: told only that a picture had landed, the text-only model
 * spent twenty iterations on ImageView and pixel scripts trying to see it (F190). The
 * model is told plainly what it cannot do and what to tell the user instead.
 */
export function formatNoLookBlock(filePath: string, reason: string): string {
  return `${RETRIEVAL_TAG}\n[Attached image] ${filePath} — the image box could not look at it: ${reason}.\n` +
    'You cannot see pictures and no tool can show you one. Do not open, convert, tile or analyse the file. ' +
    'Tell the user the picture could not be looked at, give the reason above in a few words, and say it will be read when the image box answers (attach it again, or ask for a rescan of the project).\n'
}
