import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, readFileIndex, readJournal } from '../../projects/layout.js'
import { ingestFile, ingestChat, removeFromIndex, rescanProject, openProjectStore, proseEmbedModel, PROJECT_DB_FILES, removeProjectStore, type IngestEvent } from '../../projects/ingest.js'
import { pdfWithPages, scannedPdf } from './fixtures.js'
import type { EmbedClient } from '../../index/embedClient.js'

class StubEmbed { calls = 0; constructor(private fail = false) {}
  async embed(_t: string): Promise<number[]> { this.calls++; if (this.fail) throw new Error('connect ECONNREFUSED'); return new Array(768).fill(0.01) }
  async embedQuery(t: string): Promise<number[]> { return this.embed(t) }
  async embedBatch(ts: string[]): Promise<number[][]> { return Promise.all(ts.map(t => this.embed(t))) }
  get modelName() { return 'stub-model' }
}
const asClient = (s: StubEmbed) => s as unknown as EmbedClient

let home: string, slug: string, dir: string, events: IngestEvent[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-ingest-'))
  slug = createProject(home, { name: 'Ingest' }).slug
  dir = join(home, slug)
  events = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
const deps = (embed: StubEmbed | null) => ({ home, embed: embed ? asClient(embed) : null, embedModel: 'stub-model', emit: (e: IngestEvent) => events.push(e), now: () => '2026-10-05T00:00:00.000Z' })

describe('ingestFile', () => {
  it('indexes a markdown file: record, chunks, journal, event', async () => {
    writeFileSync(join(dir, 'knowledge', 'bread.md'), '# Bread\n\n## Starter\n\nFeed it daily with equal parts flour and water.\n', 'utf8')
    const ev = await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'bread.md', 'pasted')
    expect(ev).toEqual({ slug, filePath: 'knowledge/bread.md', kind: 'knowledge', indexed: true, chunks: 1 })
    expect(readFileIndex(dir, 'knowledge').files['bread.md']).toMatchObject({ origin: 'pasted', indexed: true, chunks: 1, embedModel: 'stub-model', addedAt: '2026-10-05T00:00:00.000Z' })
    const store = openProjectStore(dir)
    const rows = store.allChunks(['knowledge'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ filePath: 'knowledge/bread.md', name: 'Bread › Starter', startLine: 1, endLine: 1 })
    expect(store.getMeta('embed_model')).toBe('stub-model')
    store.close()
    expect(readJournal(dir)[0]).toMatchObject({ event: 'knowledge.added', detail: 'bread.md (pasted) — 1 chunk(s)' })
    expect(events).toEqual([ev])
  })
  it('a scanned PDF is kept, recorded unindexed with the reason, journaled and emitted', async () => {
    writeFileSync(join(dir, 'knowledge', 'scan.pdf'), scannedPdf())
    const ev = await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'scan.pdf', 'uploaded')
    expect(ev).toEqual({ slug, filePath: 'knowledge/scan.pdf', kind: 'knowledge', indexed: false, reason: 'no extractable text' })
    expect(readFileIndex(dir, 'knowledge').files['scan.pdf']).toMatchObject({ indexed: false, reason: 'no extractable text' })
    expect(readJournal(dir)[0]).toMatchObject({ event: 'knowledge.unindexed' })
    expect(existsSync(join(dir, 'knowledge', 'scan.pdf'))).toBe(true)
  })
  it('embedding failure records the reason and leaves the file for rescan', async () => {
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext here\n', 'utf8')
    const ev = await ingestFile(deps(new StubEmbed(true)), slug, 'knowledge', 'a.md', 'pasted')
    expect(ev.indexed).toBe(false)
    expect(ev.reason).toMatch(/^embeddings unavailable: /)
    expect(readFileIndex(dir, 'knowledge').files['a.md'].indexed).toBe(false)
  })
  it('no embed client at all indexes keyword-only rows (empty embedding)', async () => {
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext here\n', 'utf8')
    const ev = await ingestFile(deps(null), slug, 'knowledge', 'a.md', 'pasted')
    expect(ev.indexed).toBe(true)
    expect(ev.reason).toBeUndefined()
  })
  it('re-ingesting replaces the old rows (no duplicates) and a PDF gets page ordinals', async () => {
    writeFileSync(join(dir, 'knowledge', 'g.pdf'), pdfWithPages(['Page one text about resin.', 'Page two text about sanding.']))
    await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'g.pdf', 'uploaded')
    await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'g.pdf', 'uploaded')
    const store = openProjectStore(dir)
    const rows = store.allChunks(['knowledge'])
    expect(rows.map(r => [r.startLine, r.name])).toEqual([[1, 'g.pdf › page 1'], [2, 'g.pdf › page 2']])
    store.close()
  })
  it('a model change rebuilds the store and journals index.rebuilt', async () => {
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext\n', 'utf8')
    await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'a.md', 'pasted')
    const other = { ...deps(new StubEmbed()), embedModel: 'other-model' }
    await ingestFile(other, slug, 'knowledge', 'a.md', 'pasted')
    expect(readJournal(dir).some(e => e.event === 'index.rebuilt' && /stub-model → other-model/.test(e.detail))).toBe(true)
    const store = openProjectStore(dir)
    expect(store.getMeta('embed_model')).toBe('other-model')
    store.close()
  })
  it('a rebuild removes project.db with its WAL sidecars, never leaving the old model\'s frames to replay (final review M4)', async () => {
    expect([...PROJECT_DB_FILES]).toEqual(['project.db', 'project.db-wal', 'project.db-shm'])
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext\n', 'utf8')
    await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'a.md', 'pasted')
    // What a second connection open at close leaves behind: sidecars no
    // checkpoint folded in. (SQLite itself rewrites stand-in sidecars when the
    // old store is opened, so the removal is checked on plain files.)
    const idx = join(dir, '.cynco', 'index')
    const scratch = mkdtempSync(join(tmpdir(), 'cynco-store-'))
    mkdirSync(join(scratch, '.cynco', 'index'), { recursive: true })
    for (const f of PROJECT_DB_FILES) writeFileSync(join(scratch, '.cynco', 'index', f), 'old model', 'utf8')
    removeProjectStore(scratch)
    expect(PROJECT_DB_FILES.filter(f => existsSync(join(scratch, '.cynco', 'index', f)))).toEqual([])
    rmSync(scratch, { recursive: true, force: true })
    // and the rebuild is the one that calls it, not a lone rm of project.db
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'projects', 'ingest.ts'), 'utf8')
    const rebuild = src.slice(src.indexOf('function openForModel('), src.indexOf('async function writeChunks('))
    expect(rebuild).toContain('removeProjectStore(dir)')
    expect(rebuild).not.toContain('rmSync(')
    await ingestFile({ ...deps(new StubEmbed()), embedModel: 'other-model' }, slug, 'knowledge', 'a.md', 'pasted')
    expect(existsSync(idx)).toBe(true)
    const store = openProjectStore(dir)
    expect(store.getMeta('embed_model')).toBe('other-model')
    expect(store.allChunks(['knowledge'])).toHaveLength(1)
    store.close()
  })
  it('an artifact that fails to index is journaled artifact.unindexed, and its removal artifact.removed (final review M3)', async () => {
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n\nsteps\n', 'utf8')
    const ev = await ingestFile(deps(new StubEmbed(true)), slug, 'artifact', 'plan.md', 'chat')
    expect(ev.indexed).toBe(false)
    expect(readJournal(dir)[0]).toMatchObject({ event: 'artifact.unindexed', detail: expect.stringMatching(/^plan\.md \(chat\) — not indexed: embeddings unavailable: /) })
    writeFileSync(join(dir, 'artifacts', 'photo.png'), new Uint8Array([1, 2, 3]))
    await ingestFile(deps(new StubEmbed()), slug, 'artifact', 'photo.png', 'chat')
    expect(readJournal(dir)[0]).toMatchObject({ event: 'artifact.unindexed', detail: 'photo.png (chat) — not indexed: images are captioned in sub-project 3' })
    await removeFromIndex(deps(new StubEmbed()), slug, 'artifact', 'plan.md')
    expect(readJournal(dir)[0]).toMatchObject({ event: 'artifact.removed', detail: 'plan.md removed' })
    expect(readJournal(dir).some(e => e.event === 'artifact.saved')).toBe(false)
  })
})

describe('chats, removal, rescan', () => {
  it('ingestChat indexes turn pairs under the title and replaces on re-ingest', async () => {
    await ingestChat(deps(new StubEmbed()), slug, '20261005T120000-resin.jsonl', 'Resin', [{ user: 'How much?', assistant: '400 ml' }])
    await ingestChat(deps(new StubEmbed()), slug, '20261005T120000-resin.jsonl', 'Resin', [{ user: 'How much?', assistant: '400 ml' }, { user: 'Brand?', assistant: 'Any' }])
    const store = openProjectStore(dir)
    expect(store.allChunks(['chat']).map(r => r.startLine)).toEqual([1, 2])
    store.close()
  })
  it('removeFromIndex drops rows and the record and journals', async () => {
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext\n', 'utf8')
    await ingestFile(deps(new StubEmbed()), slug, 'knowledge', 'a.md', 'pasted')
    await removeFromIndex(deps(new StubEmbed()), slug, 'knowledge', 'a.md')
    const store = openProjectStore(dir); expect(store.allChunks()).toHaveLength(0); store.close()
    expect(readFileIndex(dir, 'knowledge').files['a.md']).toBeUndefined()
    expect(readJournal(dir)[0]).toMatchObject({ event: 'knowledge.removed' })
  })
  it('rescanProject ingests every file in knowledge and artifacts and reports counts', async () => {
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext\n', 'utf8')
    writeFileSync(join(dir, 'knowledge', 'photo.jpg'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n\nsteps\n', 'utf8')
    const r = await rescanProject(deps(new StubEmbed()), slug)
    expect(r).toEqual({ files: 3, indexed: 2, unindexed: 1 })
    expect(readFileIndex(dir, 'knowledge').files['photo.jpg']).toMatchObject({ indexed: false, reason: 'images are captioned in sub-project 3', origin: 'uploaded' })
  })
})

describe('proseEmbedModel', () => {
  it('defaults to nomic-embed-text and honours LOCALCODE_PROJECTS_EMBED_MODEL', () => {
    expect(proseEmbedModel({})).toBe('nomic-embed-text')
    expect(proseEmbedModel({ LOCALCODE_PROJECTS_EMBED_MODEL: 'bge-m3' })).toBe('bge-m3')
  })
})
