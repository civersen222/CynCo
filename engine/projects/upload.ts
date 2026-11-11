/**
 * engine/projects/upload.ts — what an upload into a project may be and where it lands.
 *
 * A file posted to `/api/projects/<slug>/knowledge` comes from the Projects tab
 * on the desk or, since phone files, from a paired phone's Attach. Three things
 * the handler took on trust are checked here, each a pure function:
 *
 *  - `contentFault`: the bytes are what the name's extension says. A `.jpg`
 *    that is HTML would be kept, journaled, handed to the image box and listed
 *    as a picture.
 *  - `safeStem`: the name is a file name on Windows. `CON.md` opens the
 *    console device, not a file.
 *  - `landingName`: a second file under a taken name. A document sent again is
 *    its new version (the owner named it). A photo's name is the camera's
 *    (`image.jpg`, every time, on some phones), so a different photo is kept
 *    beside the first and the same photo sent twice is one file.
 *
 * The write itself (`writeBytesAtomic`, layout.ts) never follows a link.
 */
import { IMAGE_EXTS } from './extract/index.js'

const at = (b: Uint8Array, offset: number, sig: number[]): boolean => b.length >= offset + sig.length && sig.every((x, i) => b[offset + i] === x)

const ZIP_BASED: ReadonlySet<string> = new Set(['.docx', '.xlsx', '.epub'])
const TEXT: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt'])

/** Null when `bytes` are what `ext` (lower case, with its dot) says they are; otherwise the reason, in words for the person who sent the file. */
export function contentFault(ext: string, bytes: Uint8Array): string | null {
  const wrong = `the content is not a ${ext} file`
  switch (ext) {
    case '.png': return at(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : wrong
    case '.jpg': case '.jpeg': return at(bytes, 0, [0xff, 0xd8, 0xff]) ? null : wrong
    case '.gif': return at(bytes, 0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61 ? null : wrong
    case '.webp': return at(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && at(bytes, 8, [0x57, 0x45, 0x42, 0x50]) ? null : wrong
    case '.pdf': return at(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? null : wrong
  }
  // Office files and EPUB are zip archives; the extractor reads the entries it needs and refuses the rest.
  if (ZIP_BASED.has(ext)) return at(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) ? null : wrong
  if (TEXT.has(ext)) {
    if (bytes.includes(0)) return `the content is not text (a ${ext} file holds no NUL bytes)`
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return `the content is not text (a ${ext} file is UTF-8)` }
    return null
  }
  return `no content rule for ${ext || '(no extension)'}`
}

/** Names Windows opens as a device whatever extension follows (`CON.md` is the console). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** `stem` (a file name without its extension, already slugified), or `stem-file` when Windows would not treat it as a file. */
export function safeStem(stem: string): string {
  return WINDOWS_DEVICE.test(stem) ? `${stem}-file` : stem
}

export type Landing =
  /** Write the bytes under `name` (a new file, or the new version of a document). */
  | { kind: 'write'; name: string }
  /** These exact bytes are already in the project under `name`: nothing to write. */
  | { kind: 'duplicate'; name: string }

/**
 * Where a file called `stem + ext` with content hash `sha256` lands, given
 * what the area already holds (`shaOf(name)`: the hash of the file under that
 * name, or null when the name is free).
 */
export function landingName(stem: string, ext: string, sha256: string, shaOf: (name: string) => string | null): Landing {
  const first = `${stem}${ext}`
  if (!IMAGE_EXTS.has(ext)) return { kind: 'write', name: first }
  for (let n = 1; n < 10_000; n++) {
    const name = n === 1 ? first : `${stem}-${n}${ext}`
    const held = shaOf(name)
    if (held === null) return { kind: 'write', name }
    if (held === sha256) return { kind: 'duplicate', name }
  }
  throw new Error(`no free name for ${first}`)
}
