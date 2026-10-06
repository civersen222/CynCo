/**
 * engine/projects/proseChunker.ts — headings first, then paragraphs.
 *
 * A chunk never crosses a heading boundary. Paragraphs are packed toward
 * TARGET_WORDS; a paragraph that would push past MAX_WORDS starts a new chunk,
 * and each new chunk begins with the previous chunk's last paragraph so a
 * sentence cut by the boundary is still findable. A single paragraph longer
 * than MAX_WORDS is split at sentence ends. Ordinal = page or chapter ordinal
 * when the segment has one, else the chunk's 1-based position in the file.
 */
import type { Segment } from './extract/types.js'

export type ProseChunk = { heading: string; page?: number; chapter?: string; ordinal: number; text: string }
export const TARGET_WORDS = 500
export const MAX_WORDS = 800

const wc = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)

function splitLongParagraph(p: string): string[] {
  const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (wc(cur) + wc(s) > MAX_WORDS && cur) { out.push(cur.trim()); cur = '' }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function chunkSegments(segments: Segment[]): ProseChunk[] {
  const out: ProseChunk[] = []
  let fileOrdinal = 0
  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue
    const heading = seg.heading.join(' › ')
    const fixedOrdinal = seg.page ?? (seg.chapter ? segments.filter(s => s.chapter).indexOf(seg) + 1 : null)
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).flatMap(p => (wc(p) > MAX_WORDS ? splitLongParagraph(p) : [p]))
    let cur: string[] = []
    let overlap: string | null = null
    const push = () => {
      if (!cur.length) return
      fileOrdinal++
      out.push({ heading, page: seg.page, chapter: seg.chapter, ordinal: fixedOrdinal ?? fileOrdinal, text: cur.join('\n\n') })
      overlap = cur[cur.length - 1]
      cur = []
    }
    for (const p of paragraphs) {
      const curWords = wc(cur.join(' '))
      if (cur.length && (curWords + wc(p) > MAX_WORDS || curWords + wc(p) > TARGET_WORDS)) {
        push()
        if (overlap && wc(overlap) + wc(p) <= MAX_WORDS) cur.push(overlap)
      }
      cur.push(p)
    }
    push()
  }
  return out
}

export function chunkTranscriptTurns(turns: { user: string; assistant: string }[], title: string): ProseChunk[] {
  return turns
    .filter(t => t.user.trim() || t.assistant.trim())
    .map((t, i) => ({ heading: title, ordinal: i + 1, text: `User: ${t.user.trim()}\n\nAssistant: ${t.assistant.trim()}` }))
}
