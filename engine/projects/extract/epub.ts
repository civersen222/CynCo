import { unzipSync, strFromU8 } from 'fflate'
import type { Extractor, Segment } from './types.js'

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`)) ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`))
  return m ? m[1] : null
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

/** XHTML → paragraphs: block elements become paragraph breaks, every other tag is dropped. */
export function htmlToText(html: string): string {
  const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|br)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(body).replace(/[ \t]+/g, ' ').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n\n')
}

export const extractEpub: Extractor = async (bytes, fileName) => {
  let files: Record<string, Uint8Array>
  try { files = unzipSync(new Uint8Array(bytes)) } catch (e) { return { ok: false, reason: `not a zip/epub: ${e instanceof Error ? e.message : String(e)}` } }
  const container = files['META-INF/container.xml']
  if (!container) return { ok: false, reason: 'epub has no META-INF/container.xml' }
  const rootfile = strFromU8(container).match(/<rootfile\b[^>]*>/i)
  const opfPath = rootfile ? attr(rootfile[0], 'full-path') : null
  if (!opfPath || !files[opfPath]) return { ok: false, reason: 'epub names no readable OPF' }
  const opf = strFromU8(files[opfPath])
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(item, 'id'), href = attr(item, 'href')
    if (id && href) manifest.set(id, base + decodeURIComponent(href))
  }
  const spine = (opf.match(/<itemref\b[^>]*>/gi) ?? []).map(t => attr(t, 'idref')).filter((x): x is string => !!x)
  if (spine.length === 0) return { ok: false, reason: 'epub spine is empty' }
  const segments: Segment[] = []
  for (const idref of spine) {
    const path = manifest.get(idref)
    const data = path ? files[path] : undefined
    if (!data) continue
    const html = strFromU8(data)
    const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '') ?? idref).trim()
    const text = htmlToText(html)
    if (text) segments.push({ heading: [fileName, title], chapter: title, text })
  }
  if (segments.length === 0) return { ok: false, reason: 'no extractable text' }
  return { ok: true, segments }
}
