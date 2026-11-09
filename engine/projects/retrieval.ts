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

  /** The block text, or null when nothing was added; drains. */
  take(): string | null {
    if (this.pending.length === 0) return null
    const lines = this.pending.map(e => `- ${e.filePath} — ${e.indexed ? `indexed (${e.chunks ?? 0} passage(s))` : `kept, not vector-indexed: ${e.reason ?? 'no reason given'}`}`)
    this.pending = []
    return `${RETRIEVAL_TAG}\nFiles added to this project since your last turn (uploaded or saved; they live at the paths shown, under the project folder):\n${lines.join('\n')}\n`
  }
}
