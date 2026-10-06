import { extractText, getDocumentProxy } from 'unpdf'
import type { Extractor } from './types.js'

/** Page-by-page text through pdf.js (bundled by unpdf; no canvas, runs under Bun). */
export const extractPdf: Extractor = async (bytes, fileName) => {
  let pages: string[]
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const r = await extractText(pdf, { mergePages: false })
    pages = r.text
  } catch (e) {
    return { ok: false, reason: `unreadable pdf: ${e instanceof Error ? e.message : String(e)}` }
  }
  const segments = pages
    .map((t, i) => ({ heading: [fileName, `page ${i + 1}`], page: i + 1, text: t.replace(/[ \t]+\n/g, '\n').trim() }))
    .filter(s => s.text.length > 0)
  if (segments.length === 0) return { ok: false, reason: 'no extractable text' }
  return { ok: true, segments }
}
