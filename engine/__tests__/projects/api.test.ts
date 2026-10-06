import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listProjects, createProjectApi, getProjectApi, patchProjectApi, searchApi,
  listKnowledgeApi, addKnowledgeApi, removeKnowledgeApi,
  listArtifactsApi, promoteArtifactApi,
  listChatsApi, getChatApi, renameChatApi, rescanApi,
  UPLOAD_MAX_BYTES, type ProjectsDeps,
} from '../../projects/api.js'
import { readFileIndex } from '../../projects/layout.js'
import { ingestFile, type IngestEvent } from '../../projects/ingest.js'
import { appendTranscript, newChatFile } from '../../projects/chat.js'
import { pdfWithPages } from './fixtures.js'
import type { EmbedClient } from '../../index/embedClient.js'

class StubEmbed {
  async embed(_t: string): Promise<number[]> { return new Array(8).fill(0.01) }
  async embedQuery(t: string): Promise<number[]> { return this.embed(t) }
  async embedBatch(ts: string[]): Promise<number[][]> { return Promise.all(ts.map(t => this.embed(t))) }
  get modelName() { return 'stub-model' }
}
const asClient = (s: StubEmbed) => s as unknown as EmbedClient

let home: string, events: IngestEvent[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-api-'))
  events = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const deps = (): ProjectsDeps => ({ home, embed: asClient(new StubEmbed()), embedModel: 'stub-model', emit: (e) => events.push(e), contextLength: 8192 })

describe('listProjects', () => {
  it('rebuilds a fresh home and reports it', () => {
    const r = listProjects(deps())
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ projects: [], rebuilt: true })
  })
})

describe('createProjectApi', () => {
  it('creates a project and returns its slug', async () => {
    const r = await createProjectApi(deps(), { name: 'Resin Diorama' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ slug: 'resin-diorama', name: 'Resin Diorama' })
  })
  it('refuses an empty name with 400', async () => {
    const r = await createProjectApi(deps(), { name: '   ' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'name is required' })
  })
})

describe('getProjectApi', () => {
  it('404s an unknown project', () => {
    const r = getProjectApi(deps(), 'nope')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: 'no such project' })
  })
  it('returns the project with instructions, counts, plan and journal', async () => {
    const d = deps()
    const created = await createProjectApi(d, { name: 'Diorama' })
    const slug = (created.body as { slug: string }).slug
    const r = getProjectApi(d, slug)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ slug, counts: { knowledge: 0, artifacts: 0, chats: 0 } })
  })
})

describe('patchProjectApi', () => {
  it('round-trips the instructions field', async () => {
    const d = deps()
    const created = await createProjectApi(d, { name: 'Diorama' })
    const slug = (created.body as { slug: string }).slug
    const r = await patchProjectApi(d, slug, { instructions: 'Keep notes concise.' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ instructions: 'Keep notes concise.' })
    const after = getProjectApi(d, slug)
    expect(after.body).toMatchObject({ instructions: 'Keep notes concise.' })
  })
})

describe('searchApi', () => {
  it('searches within a project scope and across all projects, and skips a deleted folder', async () => {
    const d = deps()
    const a = (await createProjectApi(d, { name: 'Alpha' })).body as { slug: string }
    const b = (await createProjectApi(d, { name: 'Beta' })).body as { slug: string }
    await addKnowledgeApi(d, a.slug, { name: 'notes.md', text: '# Notes\n\nResin curing takes 24 hours.\n' })

    const scoped = await searchApi(d, a.slug, 'resin', null, null)
    expect(scoped.status).toBe(200)
    expect((scoped.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0)

    const global1 = await searchApi(d, null, 'resin', null, null)
    expect(global1.status).toBe(200)
    expect((global1.body as { hits: unknown[] }).hits.length).toBeGreaterThan(0)

    // b's folder disappears from under the (still-cached) registry.
    rmSync(join(home, b.slug), { recursive: true, force: true })
    const global2 = await searchApi(d, null, 'resin', null, null)
    expect(global2.status).toBe(200)
    expect((global2.body as { skipped: { slug: string; reason: string }[] }).skipped).toContainEqual({ slug: b.slug, reason: 'project folder missing' })
    // Two createProjectApi + a knowledge add spawn ~15 git processes; under
    // full-suite load on Windows that ran past the 5 s default (final review M5).
  }, 30000)

  it('400s an empty query', async () => {
    const r = await searchApi(deps(), null, '  ', null, null)
    expect(r.status).toBe(400)
  })
})

describe('knowledge: add/list/remove', () => {
  it('pastes text, indexing it', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await addKnowledgeApi(d, slug, { name: 'notes.md', text: '# Notes\n\nSome content here.\n' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ name: 'notes.md', indexed: true })
    const list = listKnowledgeApi(d, slug)
    expect(list.status).toBe(200)
    expect((list.body as { files: Record<string, unknown> }).files['notes.md']).toBeDefined()
  })

  it('uploads bytes of a real PDF, indexing it', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await addKnowledgeApi(d, slug, { name: 'manual.pdf', bytes: pdfWithPages(['Hello from page one.']) })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ indexed: true })
  })

  it('refuses an unsupported file type with 415', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await addKnowledgeApi(d, slug, { name: 'resume.docx', bytes: new Uint8Array([1, 2, 3]) })
    expect(r.status).toBe(415)
    expect(r.body).toEqual({ error: 'unsupported file type .docx' })
  })

  it('refuses a file over UPLOAD_MAX_BYTES with 413', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await addKnowledgeApi(d, slug, { name: 'big.md', bytes: new Uint8Array(UPLOAD_MAX_BYTES + 1) })
    expect(r.status).toBe(413)
  })

  it('404s removing an unknown knowledge file', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await removeKnowledgeApi(d, slug, 'ghost.md')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: 'no such knowledge file' })
  })

  it('removes a known knowledge file', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    await addKnowledgeApi(d, slug, { name: 'notes.md', text: 'content\n' })
    const r = await removeKnowledgeApi(d, slug, 'notes.md')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ removed: 'notes.md' })
  })
})

describe('artifacts: list/promote', () => {
  it('lists an artifact indexed by hand, then promotes it into knowledge', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const dir = join(home, slug)
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n\nBuild the base first.\n', 'utf8')
    await ingestFile(d, slug, 'artifact', 'plan.md', 'artifact')

    const list = listArtifactsApi(d, slug)
    expect(list.status).toBe(200)
    expect((list.body as { files: Record<string, unknown> }).files['plan.md']).toBeDefined()

    const promoted = await promoteArtifactApi(d, slug, 'plan.md')
    expect(promoted.status).toBe(200)
    expect(promoted.body).toMatchObject({ promoted: 'plan.md' })
    expect(readFileIndex(dir, 'knowledge').files['plan.md']).toBeDefined()
  })

  it('404s promoting an unknown artifact', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await promoteArtifactApi(d, slug, 'ghost.md')
    expect(r.status).toBe(404)
  })

  it('refuses index.json, "." / "..", and a directory by name with 400, leaving knowledge/index.json intact (final review I1)', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const dir = join(home, slug)
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n\nBase first.\n', 'utf8')
    await ingestFile(d, slug, 'artifact', 'plan.md', 'artifact')
    const before = readFileSync(join(dir, 'knowledge', 'index.json'), 'utf8')
    for (const name of ['index.json', 'Index.JSON']) {
      const r = await promoteArtifactApi(d, slug, name)
      expect(r, name).toEqual({ status: 400, body: { error: '"index.json" is the project\'s own file index, not an artifact' } })
    }
    for (const name of ['.', '..', '']) {
      const r = await promoteArtifactApi(d, slug, name)
      expect(r.status, JSON.stringify(name)).toBe(400)
      expect((r.body as { error: string }).error).toMatch(/^not an artifact name/)
    }
    mkdirSync(join(dir, 'artifacts', 'drafts'))
    expect(await promoteArtifactApi(d, slug, 'drafts')).toEqual({ status: 400, body: { error: 'not a file: artifacts/drafts' } })
    expect(readFileSync(join(dir, 'knowledge', 'index.json'), 'utf8')).toBe(before)
  }, 30000)
})

describe('chats: list/rename', () => {
  it('lists a chat and renames it', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const dir = join(home, slug)
    const { file } = newChatFile(dir, 'How much resin do I need?')

    const list = listChatsApi(d, slug)
    expect(list.status).toBe(200)
    expect((list.body as { chats: { file: string }[] }).chats.map(c => c.file)).toContain(file)

    const renamed = await renameChatApi(d, slug, file, { title: 'Resin quantities' })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ file, title: 'Resin quantities' })
  })

  it('reads one chat transcript; 404s an unknown chat or project; basenames the file', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const dir = join(home, slug)
    const { file } = newChatFile(dir, 'How much resin do I need?')
    appendTranscript(dir, file, { role: 'user', content: [{ type: 'text', text: 'How much resin do I need?' }] })
    appendTranscript(dir, file, { role: 'assistant', content: [{ type: 'text', text: 'About 2 L.' }] })

    const r = getChatApi(d, slug, file)
    expect(r.status).toBe(200)
    const body = r.body as { header: { title: string }; messages: { role: string }[] }
    expect(body.header.title).toBe('How much resin do I need?')
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    // a path in the file name is reduced to its basename, never followed
    expect(getChatApi(d, slug, `../../${slug}/chats/${file}`).status).toBe(200)

    expect(getChatApi(d, slug, 'ghost.jsonl')).toEqual({ status: 404, body: { error: 'no such chat' } })
    expect(getChatApi(d, 'nope', file)).toEqual({ status: 404, body: { error: 'no such project' } })
    expect(getChatApi(d, '../x', file).status).toBe(400)
  })

  it('404s renaming an unknown chat', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const r = await renameChatApi(d, slug, 'ghost.jsonl', { title: 'x' })
    expect(r.status).toBe(404)
  })
})

describe('rescanApi', () => {
  it('ingests every file under knowledge and artifacts and reports counts', async () => {
    const d = deps()
    const slug = ((await createProjectApi(d, { name: 'Diorama' })).body as { slug: string }).slug
    const dir = join(home, slug)
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\ntext\n', 'utf8')
    writeFileSync(join(dir, 'knowledge', 'photo.jpg'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'artifacts', 'plan.md'), '# Plan\n\nsteps\n', 'utf8')
    const r = await rescanApi(d, slug)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ files: 3, indexed: 2, unindexed: 1 })
  })

  it('404s an unknown project', async () => {
    const r = await rescanApi(deps(), 'ghost')
    expect(r.status).toBe(404)
  })
})
