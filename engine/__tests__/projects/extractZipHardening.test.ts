// Review fixes for slice 5: the zip reader inflates only what the caller wants
// and caps the total; a self-closing attributed paragraph does not swallow the
// next block in docx.
import { describe, expect, it } from 'bun:test'
import { deflateRawSync } from 'zlib'
import { makeZip } from './extractOffice.test.js'
import { readZip } from '../../projects/extract/zip.js'
import { extractDocx } from '../../projects/extract/docx.js'

describe('readZip hardening', () => {
  it('inflates only the wanted entries', () => {
    const z = readZip(makeZip({ 'word/document.xml': '<w:document/>', 'word/media/img1.png': 'x'.repeat(5000) }, { deflate: true }), { want: (n) => n === 'word/document.xml' })
    expect([...z.keys()]).toEqual(['word/document.xml'])
  })

  it('refuses when the total inflated size would pass the cap (overlapping-entry bomb shape)', () => {
    // Build a zip whose central directory lists the SAME local entry 20 times under
    // different names: each passes the per-entry cap, together they do not.
    const raw = Buffer.from('y'.repeat(4000))
    const data = deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22)
    const name0 = Buffer.from('e0'); local.writeUInt16LE(name0.length, 26)
    const parts: Buffer[] = [local, name0, data]
    const cdEntries: Buffer[] = []
    for (let i = 0; i < 20; i++) {
      const nm = Buffer.from(`e${i}`)
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24)
      cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42) // all point at offset 0
      cdEntries.push(cd, nm)
    }
    const cdBuf = Buffer.concat(cdEntries)
    const cdOffset = Buffer.concat(parts).length
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(20, 8); eocd.writeUInt16LE(20, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16)
    const bomb = new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]))
    expect(() => readZip(bomb, { maxTotalBytes: 30_000 })).toThrow(/total too large/)
    // and with a generous total cap it is simply 20 entries
    expect(readZip(bomb, { maxTotalBytes: 1_000_000 }).size).toBe(20)
  })

  it('a corrupt archive never escapes an extractor as a throw', async () => {
    const r = await extractDocx(makeZip({ 'word/document.xml': 'x' }).slice(0, 40), 'x.docx')
    expect(r.ok).toBe(false)
  })
})

describe('docx self-closing paragraph', () => {
  it('an attributed empty paragraph before a table does not swallow the table', async () => {
    const xml = `<w:document xmlns:w="w"><w:body>
<w:p w14:paraId="1A2B"/>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Player</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Proj</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>after</w:t></w:r></w:p>
</w:body></w:document>`
    const r = await extractDocx(makeZip({ 'word/document.xml': xml }), 'x.docx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.segments[0].text).toBe('Player | Proj\nafter')
  })
})
