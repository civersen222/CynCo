// docx / xlsx extraction through the zlib-only zip reader (wakefulness slice 5).
// Fixtures are built here by a tiny zip WRITER (stored and deflate entries),
// so the repo carries no Office binaries.
import { describe, expect, it } from 'bun:test'
import { deflateRawSync } from 'zlib'
import { readZip } from '../../projects/extract/zip.js'
import { extractDocx } from '../../projects/extract/docx.js'
import { extractFile, ACCEPTED_EXTS } from '../../projects/extract/index.js'

// ---- minimal zip writer -----------------------------------------------------
function crc32(buf: Uint8Array): number {
  let c: number, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
export function makeZip(entries: Record<string, string | Uint8Array>, opts: { deflate?: boolean; lieUncompressed?: number } = {}): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content)
    const data = opts.deflate ? deflateRawSync(raw) : raw
    const method = opts.deflate ? 8 : 0
    const nameB = Buffer.from(name, 'utf-8')
    const crc = crc32(raw)
    const uncompressed = opts.lieUncompressed ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(uncompressed, 22); local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(uncompressed, 24)
    cd.writeUInt16LE(nameB.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42)
    parts.push(local, nameB, data)
    central.push(cd, nameB)
    offset += local.length + nameB.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10)
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]))
}

const DOCX_XML = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Roster notes</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Start </w:t></w:r><w:r><w:t>Puka</w:t></w:r><w:r><w:t> at WR2.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Bench</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Player</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Proj</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Nacua</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>14.2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>A &amp; B &lt; C</w:t></w:r></w:p>
</w:body></w:document>`

describe('readZip', () => {
  it('reads stored and deflated entries', () => {
    for (const deflate of [false, true]) {
      const z = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.bin': new Uint8Array([1, 2, 3]) }, { deflate }))
      expect(Buffer.from(z.get('a.txt')!).toString()).toBe('hello')
      expect([...z.get('dir/b.bin')!]).toEqual([1, 2, 3])
    }
  })
  it('refuses an entry that claims more than the cap before inflating', () => {
    const bomb = makeZip({ 'x': 'tiny' }, { deflate: true, lieUncompressed: 10 * 1024 * 1024 })
    expect(() => readZip(bomb, { maxEntryBytes: 1024 * 1024 })).toThrow(/too large/)
  })
  it('rejects a non-zip', () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a zip/)
  })
})

describe('extractDocx', () => {
  it('splits on headings, joins runs, renders tables as rows, decodes entities', async () => {
    const r = await extractDocx(makeZip({ 'word/document.xml': DOCX_XML }, { deflate: true }), 'notes.docx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.segments.map(s => s.heading)).toEqual([['notes.docx', 'Roster notes'], ['notes.docx', 'Roster notes', 'Bench']])
    expect(r.segments[0].text).toBe('Start Puka at WR2.')
    expect(r.segments[1].text).toBe('Player | Proj\nNacua | 14.2\nA & B < C')
  })
  it('a renamed zip with no word/document.xml is refused with a reason', async () => {
    const r = await extractDocx(makeZip({ 'readme.txt': 'nope' }), 'x.docx')
    expect(r).toEqual({ ok: false, reason: 'not a docx: word/document.xml missing' })
  })
  it('a corrupt file is refused, never thrown', async () => {
    const r = await extractDocx(new Uint8Array([0, 1, 2]), 'x.docx')
    expect(r.ok).toBe(false)
  })
  it('is registered for .docx', async () => {
    expect(ACCEPTED_EXTS.has('.docx')).toBe(true)
    const r = await extractFile(makeZip({ 'word/document.xml': DOCX_XML }), 'n.docx')
    expect(r.ok).toBe(true)
  })
})
