import { extname } from 'node:path'
import { extractMarkdown } from './markdown.js'
import { extractPdf } from './pdf.js'
import { extractEpub } from './epub.js'
import type { Extracted, Extractor } from './types.js'
export type { Extracted, Extractor, Segment } from './types.js'

export const EXTRACTOR_EXTS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt', '.pdf', '.epub'])
export const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
export const ACCEPTED_EXTS: ReadonlySet<string> = new Set([...EXTRACTOR_EXTS, ...IMAGE_EXTS])

export function extractorFor(fileName: string): Extractor | null {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return extractMarkdown
  if (ext === '.pdf') return extractPdf
  if (ext === '.epub') return extractEpub
  return null
}

export async function extractFile(bytes: Uint8Array, fileName: string): Promise<Extracted> {
  const ext = extname(fileName).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return { ok: false, reason: 'images are captioned in sub-project 3' }
  const fn = extractorFor(fileName)
  if (!fn) return { ok: false, reason: `no extractor for ${ext || '(no extension)'}` }
  return fn(bytes, fileName)
}
