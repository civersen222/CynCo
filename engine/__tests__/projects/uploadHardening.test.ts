/**
 * What an upload into a project may do (docs/NOW.md, Next 1: "photos and files
 * from the phone into a project — upload route hardening").
 *
 * Since phone files (2026-11-08) a paired phone posts to
 * /api/projects/<slug>/knowledge. The handler trusted three things it should
 * not: that the name's extension says what the bytes are, that the path it
 * writes is a file inside the project, and that a second file with a taken
 * name is the same file again. `engine/projects/upload.ts` holds the rules.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addKnowledgeApi, promoteArtifactApi, type ProjectsDeps } from '../../projects/api.js'
import { createProject, readFileIndex, writeBytesAtomic } from '../../projects/layout.js'
import { contentFault, safeStem } from '../../projects/upload.js'
import { pdfWithPages } from './fixtures.js'
import type { IngestEvent } from '../../projects/ingest.js'

const JPG_A = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const JPG_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 9, 8, 7, 6, 5])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0])
const text = (s: string) => new TextEncoder().encode(s)

function canSymlinkFiles(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'cynco-linkprobe-'))
  try { writeFileSync(join(d, 't'), 'x'); symlinkSync(join(d, 't'), join(d, 'l')); return true } catch { return false } finally { rmSync(d, { recursive: true, force: true }) }
}

let home: string, outside: string, events: IngestEvent[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-upload-'))
  outside = mkdtempSync(join(tmpdir(), 'cynco-upload-outside-'))
  events = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
// No embed client: a file is kept and keyword-indexed; what is under test is what reaches the disk.
const deps = (): ProjectsDeps => ({ home, embed: null, embedModel: 'none', emit: (e) => events.push(e), contextLength: 8192 })
const project = () => { const m = createProject(home, { name: 'Yard' }); return { slug: m.slug, dir: join(home, m.slug) } }
const files = (dir: string) => readdirSync(join(dir, 'knowledge')).filter(n => n !== 'index.json').sort()

describe('contentFault: the bytes are what the extension says', () => {
  it('pictures by their signature', () => {
    expect(contentFault('.jpg', JPG_A)).toBeNull()
    expect(contentFault('.jpeg', JPG_A)).toBeNull()
    expect(contentFault('.png', PNG)).toBeNull()
    expect(contentFault('.gif', GIF)).toBeNull()
    expect(contentFault('.webp', WEBP)).toBeNull()
    expect(contentFault('.png', JPG_A)).toMatch(/not a \.png/)
    expect(contentFault('.jpg', text('<html><script>alert(1)</script>'))).toMatch(/not a \.jpg/)
    expect(contentFault('.gif', PNG)).toMatch(/not a \.gif/)
  })
  it('PDF by its header; the Office and EPUB formats by the zip they are', () => {
    expect(contentFault('.pdf', pdfWithPages(['one']))).toBeNull()
    expect(contentFault('.pdf', ZIP)).toMatch(/not a \.pdf/)
    for (const ext of ['.docx', '.xlsx', '.epub']) {
      expect(contentFault(ext, ZIP), ext).toBeNull()
      expect(contentFault(ext, text('plain words')), ext).toMatch(new RegExp(`not a \\${ext}`))
    }
  })
  it('text is text: UTF-8 with no NUL bytes', () => {
    expect(contentFault('.md', text('# Notes\n\ncafé, naïve, 日本語\n'))).toBeNull()
    expect(contentFault('.txt', text('plain'))).toBeNull()
    expect(contentFault('.md', new Uint8Array([0x23, 0x20, 0x00, 0x41]))).toMatch(/not text/)
    expect(contentFault('.txt', new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toMatch(/not text/)
    expect(contentFault('.md', PNG)).toMatch(/not text/)
  })
  it('an extension with no rule is not vouched for', () => {
    expect(contentFault('.exe', ZIP)).toMatch(/no content rule/)
  })
})

describe('safeStem: a name Windows would open as a device is not a file name', () => {
  it('device names get a suffix, whatever their case; everything else is left alone', () => {
    for (const n of ['con', 'nul', 'aux', 'prn', 'com1', 'com9', 'lpt1', 'lpt9']) expect(safeStem(n), n).toBe(`${n}-file`)
    expect(safeStem('console')).toBe('console')
    expect(safeStem('com10')).toBe('com10')
    expect(safeStem('notes')).toBe('notes')
  })
})

describe('writeBytesAtomic', () => {
  it('writes the bytes and leaves nothing else behind', () => {
    const d = mkdtempSync(join(tmpdir(), 'cynco-wba-'))
    try {
      writeBytesAtomic(join(d, 'a.bin'), new Uint8Array([1, 2, 3]))
      writeBytesAtomic(join(d, 'a.bin'), new Uint8Array([4, 5]))
      expect([...readFileSync(join(d, 'a.bin'))]).toEqual([4, 5])
      expect(readdirSync(d)).toEqual(['a.bin'])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('addKnowledgeApi: content', () => {
  it('refuses bytes that are not what the name says, 415, and keeps nothing', async () => {
    const { slug, dir } = project()
    const r = await addKnowledgeApi(deps(), slug, { name: 'holiday.jpg', bytes: text('<html><script>alert(1)</script></html>') })
    expect(r.status).toBe(415)
    expect((r.body as { error: string }).error).toMatch(/not a \.jpg/)
    expect(files(dir)).toEqual([])
    expect(readFileIndex(dir, 'knowledge').files).toEqual({})
    expect(events).toEqual([])
  })
  it('a PDF that is a PDF and a note that is text go in as before', async () => {
    const { slug, dir } = project()
    expect((await addKnowledgeApi(deps(), slug, { name: 'Manual.PDF', bytes: pdfWithPages(['Hello.']) })).status).toBe(201)
    expect((await addKnowledgeApi(deps(), slug, { name: 'notes.md', text: '# Notes\n\nResin cures in a day.\n' })).status).toBe(201)
    expect(files(dir)).toEqual(['manual.pdf', 'notes.md'])
  })
})

describe('addKnowledgeApi: a taken name', () => {
  it('a different photo under a name already taken is kept beside it, never over it', async () => {
    const { slug, dir } = project()
    const first = await addKnowledgeApi(deps(), slug, { name: 'image.jpg', bytes: JPG_A })
    const second = await addKnowledgeApi(deps(), slug, { name: 'image.jpg', bytes: JPG_B })
    const third = await addKnowledgeApi(deps(), slug, { name: 'IMAGE.JPG', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 7]) })
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201])
    expect((first.body as { name: string }).name).toBe('image.jpg')
    expect((second.body as { name: string }).name).toBe('image-2.jpg')
    expect((third.body as { name: string }).name).toBe('image-3.jpg')
    expect(files(dir)).toEqual(['image-2.jpg', 'image-3.jpg', 'image.jpg'])
    expect([...readFileSync(join(dir, 'knowledge', 'image.jpg'))]).toEqual([...JPG_A])
    expect([...readFileSync(join(dir, 'knowledge', 'image-2.jpg'))]).toEqual([...JPG_B])
  })
  it('the same photo sent twice is one file: the second answer is the record there already', async () => {
    const { slug, dir } = project()
    const first = await addKnowledgeApi(deps(), slug, { name: 'image.jpg', bytes: JPG_A })
    events.length = 0
    const again = await addKnowledgeApi(deps(), slug, { name: 'image.jpg', bytes: JPG_A })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ name: 'image.jpg', duplicate: true, sha256: (first.body as { sha256: string }).sha256 })
    expect(files(dir)).toEqual(['image.jpg'])
    expect(events).toEqual([]) // nothing new to tell the chat about
  })
  it('a document sent again under its name is the new version of it, as before', async () => {
    const { slug, dir } = project()
    await addKnowledgeApi(deps(), slug, { name: 'plan.md', text: 'first draft\n' })
    const r = await addKnowledgeApi(deps(), slug, { name: 'plan.md', text: 'second draft\n' })
    expect(r.status).toBe(201)
    expect((r.body as { name: string }).name).toBe('plan.md')
    expect(files(dir)).toEqual(['plan.md'])
    expect(readFileSync(join(dir, 'knowledge', 'plan.md'), 'utf8')).toBe('second draft\n')
  })
})

describe('addKnowledgeApi: where the bytes land', () => {
  it('a name Windows reads as a device lands under a file name', async () => {
    const { slug, dir } = project()
    const r = await addKnowledgeApi(deps(), slug, { name: 'CON.md', text: 'console notes\n' })
    expect(r.status).toBe(201)
    expect((r.body as { name: string }).name).toBe('con-file.md')
    expect(files(dir)).toEqual(['con-file.md'])
  })

  it('knowledge/ linked out of the project: refused, and the folder it points at is untouched', async () => {
    const { slug, dir } = project()
    rmSync(join(dir, 'knowledge'), { recursive: true, force: true })
    symlinkSync(outside, join(dir, 'knowledge'), 'junction')
    const r = await addKnowledgeApi(deps(), slug, { name: 'notes.md', text: 'should not land outside\n' })
    expect(r.status).toBe(409)
    expect((r.body as { error: string }).error).toMatch(/knowledge.*not a folder inside this project/)
    expect(readdirSync(outside)).toEqual([])
  })

  it.skipIf(!canSymlinkFiles())('a link planted at the file’s own name is replaced, never written through', async () => {
    const { slug, dir } = project()
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'the owner’s own file')
    symlinkSync(victim, join(dir, 'knowledge', 'notes.md'))
    const r = await addKnowledgeApi(deps(), slug, { name: 'notes.md', text: 'uploaded words\n' })
    expect(r.status).toBe(201)
    expect(readFileSync(victim, 'utf8')).toBe('the owner’s own file')
    expect(lstatSync(join(dir, 'knowledge', 'notes.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dir, 'knowledge', 'notes.md'), 'utf8')).toBe('uploaded words\n')
  })

  it('promoting an artifact lands the same way: knowledge/ linked out of the project is refused', async () => {
    const { slug, dir } = project()
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n')
    rmSync(join(dir, 'knowledge'), { recursive: true, force: true })
    symlinkSync(outside, join(dir, 'knowledge'), 'junction')
    const r = await promoteArtifactApi(deps(), slug, 'plan.md')
    expect(r.status).toBe(409)
    expect(readdirSync(outside)).toEqual([])
  })

  it.skipIf(!canSymlinkFiles())('promoting a link is refused: what it points at, anywhere on this machine, is not copied into knowledge', async () => {
    const { slug, dir } = project()
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'not the project’s to read')
    symlinkSync(secret, join(dir, 'artifacts', 'notes.md'))
    const r = await promoteArtifactApi(deps(), slug, 'notes.md')
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toMatch(/not a file of this project/)
    expect(files(dir)).toEqual([])
    expect(readFileIndex(dir, 'knowledge').files).toEqual({})
  })

  it.skipIf(!canSymlinkFiles())('promoting over a link planted in knowledge/ replaces the link', async () => {
    const { slug, dir } = project()
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'the owner’s own file')
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n')
    symlinkSync(victim, join(dir, 'knowledge', 'plan.md'))
    const r = await promoteArtifactApi(deps(), slug, 'plan.md')
    expect(r.status).toBe(200)
    expect(readFileSync(victim, 'utf8')).toBe('the owner’s own file')
    expect(readFileSync(join(dir, 'knowledge', 'plan.md'), 'utf8')).toBe('# Plan\n')
  })

  it('a folder sitting at the name is not replaced: refused, said', async () => {
    const { slug, dir } = project()
    mkdirSync(join(dir, 'knowledge', 'notes.md'))
    const r = await addKnowledgeApi(deps(), slug, { name: 'notes.md', text: 'words\n' })
    expect(r.status).toBe(409)
    expect(existsSync(join(dir, 'knowledge', 'notes.md'))).toBe(true)
    expect(lstatSync(join(dir, 'knowledge', 'notes.md')).isDirectory()).toBe(true)
  })
})
