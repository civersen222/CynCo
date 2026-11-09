import { extname } from 'node:path'
import { extractMarkdown } from './markdown.js'
import { extractPdf } from './pdf.js'
import { extractEpub } from './epub.js'
import { extractDocx } from './docx.js'
import { extractXlsx } from './xlsx.js'
import type { Extracted, Extractor, LookInput } from './types.js'
import { imageSegments } from './image.js'
export type { Extracted, Extractor, LookInput, Segment } from './types.js'

export const EXTRACTOR_EXTS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt', '.pdf', '.epub', '.docx', '.xlsx'])
export const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
export const ACCEPTED_EXTS: ReadonlySet<string> = new Set([...EXTRACTOR_EXTS, ...IMAGE_EXTS])

export function extractorFor(fileName: string): Extractor | null {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return extractMarkdown
  if (ext === '.pdf') return extractPdf
  if (ext === '.epub') return extractEpub
  if (ext === '.docx') return extractDocx
  if (ext === '.xlsx') return extractXlsx
  return null
}

export async function extractFile(bytes: Uint8Array, fileName: string, lookInput?: LookInput): Promise<Extracted> {
  const ext = extname(fileName).toLowerCase()
  if (IMAGE_EXTS.has(ext)) {
    // A picture is what the image box read off it (image.ts); the look is the caller's to supply.
    if (!lookInput) return { ok: false, reason: 'no vision model configured' }
    if ('failure' in lookInput) return { ok: false, reason: lookInput.failure }
    return { ok: true, segments: imageSegments(lookInput.look, fileName) }
  }
  const fn = extractorFor(fileName)
  if (!fn) return { ok: false, reason: `no extractor for ${ext || '(no extension)'}` }
  return fn(bytes, fileName)
}
