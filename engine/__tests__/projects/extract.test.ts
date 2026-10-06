import { describe, it, expect } from 'bun:test'
import { extractFile, extractorFor, ACCEPTED_EXTS } from '../../projects/extract/index.js'
import { extractMarkdown } from '../../projects/extract/markdown.js'
import { pdfWithPages, scannedPdf, epubWithChapters } from './fixtures.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('markdown/text', () => {
  it('splits by heading path and keeps a .txt as one segment under its name', async () => {
    const md = '# Bread\n\nIntro para.\n\n## Starter\n\nFeed daily.\n\n### Timing\n\nTwelve hours.\n\n## Bake\n\nHot oven.\n'
    const r = await extractMarkdown(enc(md), 'bread.md')
    if (!r.ok) throw new Error(r.reason)
    expect(r.segments.map(s => s.heading)).toEqual([['Bread'], ['Bread', 'Starter'], ['Bread', 'Starter', 'Timing'], ['Bread', 'Bake']])
    expect(r.segments[1].text).toBe('Feed daily.')
    const t = await extractMarkdown(enc('plain notes\nsecond line'), 'notes.txt')
    if (!t.ok) throw new Error(t.reason)
    expect(t.segments).toEqual([{ heading: ['notes.txt'], text: 'plain notes\nsecond line' }])
  })
  it('text before the first heading is a segment under the file name', async () => {
    const r = await extractMarkdown(enc('preamble\n\n# H\n\nbody'), 'x.md')
    if (!r.ok) throw new Error(r.reason)
    expect(r.segments[0]).toEqual({ heading: ['x.md'], text: 'preamble' })
  })
  it('refuses an empty file by name', async () => {
    const r = await extractMarkdown(enc('   \n'), 'empty.md')
    expect(r).toEqual({ ok: false, reason: 'empty file' })
  })
})

describe('pdf', () => {
  it('yields one segment per page with page numbers', async () => {
    const r = await extractFile(pdfWithPages(['Resin cures in twenty-four hours.', 'Sand the base before priming.']), 'guide.pdf')
    if (!r.ok) throw new Error(r.reason)
    expect(r.segments).toHaveLength(2)
    expect(r.segments[0]).toMatchObject({ page: 1, heading: ['guide.pdf', 'page 1'] })
    expect(r.segments[0].text).toContain('Resin cures')
    expect(r.segments[1].text).toContain('Sand the base')
  })
  it('a scan with no text layer is refused with the spec reason', async () => {
    const r = await extractFile(scannedPdf(), 'scan.pdf')
    expect(r).toEqual({ ok: false, reason: 'no extractable text' })
  })
  it('garbage bytes are refused with a reason, not a throw', async () => {
    const r = await extractFile(enc('not a pdf'), 'bad.pdf')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/pdf/i)
  })
})

describe('epub', () => {
  it('yields one segment per spine chapter with the chapter title, markup stripped', async () => {
    const r = await extractFile(epubWithChapters([
      { title: 'Starters', html: '<h1>Starters</h1><p>Feed <b>daily</b>.</p><p>Keep warm.</p>' },
      { title: 'Loaves', html: '<h1>Loaves</h1><p>Shape &amp; proof.</p>' },
    ]), 'book.epub')
    if (!r.ok) throw new Error(r.reason)
    expect(r.segments.map(s => s.chapter)).toEqual(['Starters', 'Loaves'])
    expect(r.segments[0].heading).toEqual(['book.epub', 'Starters'])
    expect(r.segments[0].text).toBe('Starters\n\nFeed daily.\n\nKeep warm.')
    expect(r.segments[1].text).toBe('Loaves\n\nShape & proof.')
  })
  it('a zip without container.xml is refused by name', async () => {
    const r = await extractFile(epubWithChapters([]).slice(0, 10), 'broken.epub')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/epub|zip/i)
  })
})

describe('routing', () => {
  it('maps extensions and names the refusal for the rest', async () => {
    expect([...ACCEPTED_EXTS].sort()).toEqual(['.epub', '.gif', '.jpeg', '.jpg', '.markdown', '.md', '.pdf', '.png', '.txt', '.webp'])
    expect(extractorFor('A.MD')).not.toBeNull()
    expect(extractorFor('x.docx')).toBeNull()
    expect(await extractFile(enc('x'), 'x.docx')).toEqual({ ok: false, reason: 'no extractor for .docx' })
    expect(await extractFile(enc('x'), 'photo.jpg')).toEqual({ ok: false, reason: 'images are captioned in sub-project 3' })
  })
})
