/**
 * engine/projects/extract/docx.ts — Word documents, by scraping word/document.xml.
 *
 * A paragraph (`<w:p>`) becomes one line: its runs' `<w:t>` texts joined. A
 * paragraph styled Heading1..6 starts a new segment and sets the heading chain
 * at that depth (so `heading` reads `[file, H1, H2]`, as the pdf extractor
 * reads `[file, page N]`). A table (`<w:tbl>`) becomes one line per row, cells
 * joined by ` | `. No XML parser: Office XML is regular enough for regexes
 * here, and a parser would be a dependency (wakefulness slice 5).
 */
import type { Extractor, Segment } from './types.js'
import { decodeXmlEntities, readZip } from './zip.js'

const TEXT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g

function paragraphText(pXml: string): string {
  let out = ''
  for (const m of pXml.matchAll(TEXT_RE)) {
    if (m[0].startsWith('<w:tab')) out += '\t'
    else if (m[0].startsWith('<w:br')) out += '\n'
    else out += decodeXmlEntities(m[1])
  }
  return out
}

function headingLevel(pXml: string): number | null {
  const m = /<w:pStyle\s+w:val="(?:Heading|heading|Titre|berschrift)?(\d)"/.exec(pXml) ?? /<w:pStyle\s+w:val="Heading(\d)"/.exec(pXml)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 6 ? n : null
}

export const extractDocx: Extractor = async (bytes, fileName) => {
  let xml: string
  try {
    const entries = readZip(bytes, { want: (n) => n === 'word/document.xml' })
    const doc = entries.get('word/document.xml')
    if (!doc) return { ok: false, reason: 'not a docx: word/document.xml missing' }
    xml = Buffer.from(doc).toString('utf-8')
  } catch (e) {
    return { ok: false, reason: `unreadable docx: ${e instanceof Error ? e.message : String(e)}` }
  }
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml

  const segments: Segment[] = []
  let chain: string[] = []
  let lines: string[] = []
  const flush = () => {
    const text = lines.join('\n').trim()
    if (text) segments.push({ heading: [fileName, ...chain], text })
    lines = []
  }
  // Top-level blocks: paragraphs and tables, in document order.
  // The self-closing form comes FIRST: `<w:p w14:paraId="…"/>` would otherwise
  // match the open-tag alternative (its `[^>]*` eats the `/`) and run on to the
  // next `</w:p>`, swallowing a following table's first cell (review of slice 5).
  const BLOCK_RE = /<w:p(?:\s[^>]*)?\/>|<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  for (const m of body.matchAll(BLOCK_RE)) {
    const block = m[0]
    if (block.startsWith('<w:tbl>')) {
      for (const row of block.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
        const cells = [...row[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map(c =>
          [...c[1].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(p => paragraphText(p[0])).join(' ').trim(),
        )
        lines.push(cells.join(' | '))
      }
      continue
    }
    const level = headingLevel(block)
    const text = paragraphText(block).trim()
    if (level !== null) {
      flush()
      chain = [...chain.slice(0, level - 1), text]
      continue
    }
    lines.push(text)
  }
  flush()
  if (segments.length === 0) return { ok: false, reason: 'no extractable text' }
  return { ok: true, segments }
}
