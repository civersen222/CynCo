/**
 * engine/projects/extract/xlsx.ts — Excel workbooks, one segment per sheet.
 *
 * Sheets are named from xl/workbook.xml and located through
 * xl/_rels/workbook.xml.rels; cells read shared strings (`t="s"`), inline
 * strings (`t="inlineStr"`), booleans (`t="b"`) and plain values. A row
 * becomes `a | b | c` with empty trailing cells dropped; a sheet is capped at
 * `maxRows` (default 5000) with a final `… N more rows` line, so a giant
 * export cannot swamp the index. Same regex scraping and zlib-only zip reader
 * as docx.ts (wakefulness slice 5). Formulas are not evaluated: the cached
 * `<v>` value Excel saved is what the reader sees.
 */
import type { Extractor, Segment } from './types.js'
import { decodeXmlEntities, readZip } from './zip.js'

const DEFAULT_MAX_ROWS = 5000

type Opts = { maxRows?: number }

function textOf(xml: string): string {
  // every <t> in order (a rich-text <si> has several runs)
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXmlEntities(m[1])).join('')
}

function sheetOrder(entries: Map<string, Uint8Array>): { name: string; path: string }[] {
  const wb = entries.get('xl/workbook.xml')
  if (!wb) throw new Error('not an xlsx: xl/workbook.xml missing')
  const rels = Buffer.from(entries.get('xl/_rels/workbook.xml.rels') ?? new Uint8Array()).toString('utf-8')
  const relTarget = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1]
    if (id && target) relTarget.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }
  const out: { name: string; path: string }[] = []
  for (const m of Buffer.from(wb).toString('utf-8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1]
    const name = decodeXmlEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? 'Sheet')
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1]
    const target = rid ? relTarget.get(rid) : undefined
    if (target) out.push({ name, path: `xl/${target}` })
  }
  return out
}

export function extractXlsxWith(opts: Opts): Extractor {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS
  return async (bytes, fileName) => {
    let entries: Map<string, Uint8Array>
    let sheets: { name: string; path: string }[]
    try {
      entries = readZip(bytes, { want: (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || n.startsWith('xl/worksheets/') })
      sheets = sheetOrder(entries)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg.startsWith('not an xlsx') ? msg : `unreadable xlsx: ${msg}` }
    }
    const shared = [...Buffer.from(entries.get('xl/sharedStrings.xml') ?? new Uint8Array()).toString('utf-8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
    const segments: Segment[] = []
    for (const sheet of sheets) {
      const xml = entries.get(sheet.path)
      if (!xml) continue
      const text = Buffer.from(xml).toString('utf-8')
      const lines: string[] = []
      let more = 0
      for (const row of text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (lines.length >= maxRows) { more++; continue }
        const cells: string[] = []
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1], inner = c[2] ?? ''
          const t = /\bt="([^"]+)"/.exec(attrs)?.[1]
          let v = ''
          if (t === 's') { const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]); v = shared[idx] ?? '' }
          else if (t === 'inlineStr') v = textOf(inner)
          else if (t === 'b') v = /<v>\s*1\s*<\/v>/.test(inner) ? 'TRUE' : 'FALSE'
          else v = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
          cells.push(v)
        }
        while (cells.length && cells[cells.length - 1] === '') cells.pop()
        lines.push(cells.join(' | '))
      }
      if (more) lines.push(`… ${more} more rows`)
      const body = lines.join('\n').trim()
      if (body) segments.push({ heading: [fileName, sheet.name], text: body })
    }
    if (segments.length === 0) return { ok: false, reason: 'no extractable text' }
    return { ok: true, segments }
  }
}

export const extractXlsx: Extractor & ((bytes: Uint8Array, fileName: string, opts?: Opts) => ReturnType<Extractor>) =
  (bytes, fileName, opts?: Opts) => extractXlsxWith(opts ?? {})(bytes, fileName)
