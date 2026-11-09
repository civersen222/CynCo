/**
 * engine/projects/extract/zip.ts — the smallest zip reader that opens Office files.
 *
 * .docx and .xlsx are zip archives whose entries are stored (method 0) or
 * deflated (method 8); Node's zlib inflates the latter, so no dependency is
 * needed (wakefulness slice 5; `fflate` was the fallback the spec allowed).
 * Reads the end-of-central-directory record, walks the central directory,
 * then each local header. Bounded three ways (review of slice 5): an entry whose
 * declared uncompressed size exceeds `maxEntryBytes` (default 64 MiB) is refused
 * before inflating; the declared total across entries may not exceed
 * `maxTotalBytes` (default 256 MiB) — the overlapping-entry bomb, where many
 * central-directory records point at one local header, fails here; and only
 * entries the caller `want`s are inflated at all (a docx's embedded photos are
 * never touched). Throws an Error with a reason; extractors turn that into
 * `{ ok: false, reason }`. Zip64 and encrypted archives are not supported
 * (an Office file is neither).
 */
import { inflateRawSync } from 'zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const DEFAULT_MAX_ENTRY = 64 * 1024 * 1024
const DEFAULT_MAX_TOTAL = 256 * 1024 * 1024

export type ReadZipOpts = {
  maxEntryBytes?: number
  /** Cap on the sum of the declared uncompressed sizes of the entries actually read. */
  maxTotalBytes?: number
  /** Only entries this returns true for are inflated and returned; default: all. */
  want?: (name: string) => boolean
}

export function readZip(bytes: Uint8Array, opts: ReadZipOpts = {}): Map<string, Uint8Array> {
  const maxEntry = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  const want = opts.want ?? (() => true)
  let total = 0
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 22) throw new Error('not a zip: too short')
  // EOCD: scan back over a possible comment (≤ 64 KiB).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('not a zip: no end-of-central-directory record')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset + cdSize > buf.length) throw new Error('not a zip: central directory out of bounds')

  const out = new Map<string, Uint8Array>()
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('not a zip: bad central directory entry')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (!want(name)) continue
    if (uncompSize > maxEntry) throw new Error(`zip entry ${name} too large (${uncompSize} bytes, cap ${maxEntry})`)
    total += uncompSize
    if (total > maxTotal) throw new Error(`zip total too large (over ${maxTotal} bytes across entries) — refused`)
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error(`not a zip: bad local header for ${name}`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error(`not a zip: data for ${name} out of bounds`)
    const data = buf.subarray(dataStart, dataStart + compSize)
    let content: Buffer
    if (method === 0) content = data
    else if (method === 8) {
      content = inflateRawSync(data, { maxOutputLength: maxEntry })
    } else throw new Error(`zip entry ${name}: unsupported compression method ${method}`)
    out.set(name, new Uint8Array(content))
  }
  return out
}

/** Decode the five XML entities and numeric references Office writes. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
