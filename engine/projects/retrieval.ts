/**
 * engine/projects/retrieval.ts — the per-turn knowledge block.
 *
 * Built from search hits, numbered, cited by file › heading (ordinal), cut
 * to a token budget (chars/4, the engine's working estimate) and at most
 * MAX_PASSAGES. The block is injected as a system message tagged
 * RETRIEVAL_TAG so the loop can find and replace the previous one (R4).
 */
import type { SearchHit } from './search.js'

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
