/**
 * /api/projects/* and /api/project-search — mounted under the inference
 * scope (R5) regardless of method, with a multipart upload branch for
 * knowledge files. Task 8 (+ fix round 1: slug validation in two layers,
 * 405s on a known path/wrong method, malformed input answers 400 instead
 * of a 500, full route-table coverage).
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { newChatFile } from '../../projects/chat.js'
import { projectDir } from '../../projects/layout.js'
import { pdfWithPages } from '../projects/fixtures.js'
import { UPLOAD_MAX_BYTES } from '../../projects/api.js'
import type { EmbedClient } from '../../index/embedClient.js'
import type { IngestEvent } from '../../projects/ingest.js'

class StubEmbed {
  calls = 0
  async embed(_t: string): Promise<number[]> { this.calls++; return new Array(768).fill(0.01) }
  async embedQuery(t: string): Promise<number[]> { return this.embed(t) }
  async embedBatch(ts: string[]): Promise<number[][]> { return Promise.all(ts.map(t => this.embed(t))) }
  get modelName() { return 'stub-model' }
}
const asClient = (s: StubEmbed) => s as unknown as EmbedClient

const _tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-projects-test-'))
const _tokens = loadOrCreateTokens(_tokenDir)
const _INFERENCE = _tokens.tokenFor('inference')!

let server: DashboardServer
let BASE: string
let HOME: string
let slug: string

function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${_INFERENCE}`)
  return fetch(`${BASE}${path}`, { ...init, headers })
}

async function waitForPort(s: DashboardServer): Promise<number> {
  const deadline = Date.now() + 2000
  while (s.getPort() === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  return s.getPort()
}

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), 'cynco-projects-dash-home-'))
  server = new DashboardServer({
    port: 0,
    tokens: _tokens,
    deps: {
      projects: {
        home: HOME,
        embed: asClient(new StubEmbed()),
        embedModel: 'stub-model',
        emit: (e: IngestEvent) => server.broadcast({ type: 'project.ingest', ...e }),
        contextLength: 8192,
      },
    },
  })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const port = server.getPort()
    if (port > 0) {
      try { await authFetch('/api/projects'); break } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 10))
  }
  BASE = `http://localhost:${server.getPort()}`
})

afterAll(() => {
  server.stop()
  rmSync(_tokenDir, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
})

describe('GET /api/projects', () => {
  it('answers { projects: [], rebuilt: true } before any project exists', async () => {
    const res = await authFetch('/api/projects')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [], rebuilt: true })
  })

  it('401s with no token, same as every other read route', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    expect(res.status).toBe(401)
  })
})

describe('POST /api/projects', () => {
  it('201s under the inference token (not 403) and returns the new project', async () => {
    const res = await authFetch('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Resin Table' }) })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.name).toBe('Resin Table')
    expect(typeof body.slug).toBe('string')
    slug = body.slug
  })
})

describe('GET /api/projects/:slug', () => {
  it('200s with the project body for the project just created', async () => {
    const res = await authFetch(`/api/projects/${slug}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.slug).toBe(slug)
    expect(body).toHaveProperty('counts')
  })

  it('404s for an unknown slug', async () => {
    const res = await authFetch('/api/projects/nope')
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/projects/:slug', () => {
  it('200s and updates the project', async () => {
    const res = await authFetch(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify({ description: 'Epoxy resin dining table' }) })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.description).toBe('Epoxy resin dining table')
  })
})

describe('POST /api/projects/:slug/knowledge', () => {
  it('a JSON paste indexes and returns 201 with indexed: true', async () => {
    const res = await authFetch(`/api/projects/${slug}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({ name: 'notes.md', text: '# Notes\n\nResin pours need a full cure before sanding.\n' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.name).toBe('notes.md')
    expect(body.event.indexed).toBe(true)
  })

  it('a multipart upload of a PDF indexes and returns 201', async () => {
    const bytes = pdfWithPages(['Page one text about resin.', 'Page two text about sanding.'])
    const form = new FormData()
    form.set('file', new File([bytes], 'guide.pdf', { type: 'application/pdf' }))
    const res = await authFetch(`/api/projects/${slug}/knowledge`, { method: 'POST', body: form })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.name).toBe('guide.pdf')
    expect(body.event.indexed).toBe(true)
  })

  it('an unsupported extension 415s naming the extension', async () => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'resume.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    const res = await authFetch(`/api/projects/${slug}/knowledge`, { method: 'POST', body: form })
    expect(res.status).toBe(415)
    expect((await res.json() as any).error).toBe('unsupported file type .docx')
  })

  // The brief's hand-set `content-length: 60000000` mismatched-header approach
  // is refused by this runtime's fetch (undici: RequestContentLengthMismatchError,
  // UND_ERR_REQ_CONTENT_LENGTH_MISMATCH) before the request ever leaves the
  // process, so the 413 is proven with a real body over UPLOAD_MAX_BYTES instead
  // — the server reads the (now-truthful) content-length header the same way.
  it('a real body over UPLOAD_MAX_BYTES 413s before the body is parsed', async () => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array(UPLOAD_MAX_BYTES + 1)], 'huge.md', { type: 'text/markdown' }))
    const res = await authFetch(`/api/projects/${slug}/knowledge`, { method: 'POST', body: form })
    expect(res.status).toBe(413)
  }, 30000)

  // Fix round 1 — reviewer findings.
  it('a multipart body with no "file" field 400s', async () => {
    const form = new FormData()
    form.set('note', 'not a file')
    const res = await authFetch(`/api/projects/${slug}/knowledge`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('multipart field "file" is required')
  })

  it('a malformed multipart body 400s instead of Bun\'s 500 HTML page', async () => {
    const res = await authFetch(`/api/projects/${slug}/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=----doesnotmatch' },
      body: 'this is not a valid multipart body at all',
    })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('malformed multipart body')
  })
})

describe('DELETE /api/projects/:slug/knowledge/:name', () => {
  it('200s and removes the file from the index', async () => {
    const res = await authFetch(`/api/projects/${slug}/knowledge/notes.md`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: 'notes.md' })
  })
})

describe('GET /api/projects/:slug/knowledge', () => {
  it('200s with the surviving file in the index and the removed one gone', async () => {
    const res = await authFetch(`/api/projects/${slug}/knowledge`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.files['guide.pdf']).toBeTruthy()
    expect(body.files['notes.md']).toBeUndefined()
  })
})

describe('GET /api/project-search', () => {
  it('finds the surviving guide.pdf passage across projects', async () => {
    const res = await authFetch('/api/project-search?q=resin')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.hits.length).toBeGreaterThan(0)
    expect(body.hits.some((h: any) => h.filePath === 'knowledge/guide.pdf')).toBe(true)
  })
})

describe('GET /api/projects/:slug/search', () => {
  it('200s with hits scoped to this one project', async () => {
    const res = await authFetch(`/api/projects/${slug}/search?q=resin`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.hits.length).toBeGreaterThan(0)
  })
})

describe('GET /api/projects/:slug/artifacts and POST .../promote', () => {
  it('lists artifacts and promotes one into knowledge', async () => {
    const dir = projectDir(HOME, slug)
    writeFileSync(join(dir, 'artifacts', 'sketch.md'), '# Sketch\n\nTable leg sketch, resin pour plan.\n', 'utf8')

    const list = await authFetch(`/api/projects/${slug}/artifacts`)
    expect(list.status).toBe(200)
    expect(await list.json()).toHaveProperty('files')

    const promoted = await authFetch(`/api/projects/${slug}/artifacts/sketch.md/promote`, { method: 'POST' })
    expect(promoted.status).toBe(200)
    const body = await promoted.json() as any
    expect(body.promoted).toBe('sketch.md')
  })
})

describe('PATCH /api/projects/:slug/chats/:file', () => {
  it('renames a chat file created by hand', async () => {
    const dir = projectDir(HOME, slug)
    const { file } = newChatFile(dir, 'How much resin do I need?')
    const res = await authFetch(`/api/projects/${slug}/chats/${file}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Resin quantity' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ file, title: 'Resin quantity' })
  })
})

describe('GET /api/projects/:slug/chats', () => {
  it('200s with the renamed chat listed', async () => {
    const res = await authFetch(`/api/projects/${slug}/chats`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.chats.some((c: any) => c.title === 'Resin quantity')).toBe(true)
  })
})

describe('POST /api/projects/:slug/rescan', () => {
  it('200s with file counts', async () => {
    const res = await authFetch(`/api/projects/${slug}/rescan`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(typeof body.files).toBe('number')
    expect(typeof body.indexed).toBe('number')
    expect(typeof body.unindexed).toBe('number')
  })
})

describe('/ws project.ingest', () => {
  it('a knowledge add reaches a connected dashboard socket as a project.ingest frame', async () => {
    const port = server.getPort()
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${_INFERENCE}`)
    const framePromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for project.ingest frame')), 5000)
      ws.addEventListener('message', (ev: any) => {
        const msg = JSON.parse(String(ev.data))
        if (msg.type === 'project.ingest') { clearTimeout(timer); resolve(msg) }
      })
      ws.addEventListener('error', (err: any) => { clearTimeout(timer); reject(err) })
    })
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (err: any) => reject(err))
    })
    const res = await authFetch(`/api/projects/${slug}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({ name: 'ws-check.md', text: '# WS\n\nAnother resin note for the socket test.\n' }),
    })
    expect(res.status).toBe(201)
    const frame = await framePromise
    expect(frame).toMatchObject({ type: 'project.ingest', slug, filePath: 'knowledge/ws-check.md', kind: 'knowledge' })
    ws.close()
  })
})

// ─── Fix round 1: reviewer findings ────────────────────────────────────────

describe('a slug with a path-traversal escape is refused before any file write', () => {
  it('..%2Foutside decodes to ../outside and 400s with "bad slug"', async () => {
    const res = await authFetch('/api/projects/..%2Foutside/knowledge', {
      method: 'POST',
      body: JSON.stringify({ name: 'x.md', text: 'hi' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('bad slug')
    // Nothing escaped the projects home: no sibling "outside" folder appeared.
    expect(existsSync(join(HOME, '..', 'outside'))).toBe(false)
  })
})

describe('a malformed percent-escape in the path 400s instead of a 500', () => {
  it('/api/projects/%E0%A4%A answers "bad path encoding"', async () => {
    const res = await authFetch('/api/projects/%E0%A4%A')
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('bad path encoding')
  })
})

describe('/api/project-search refuses every method but GET', () => {
  it('POST 405s rather than falling through to create a project', async () => {
    const res = await authFetch('/api/project-search', { method: 'POST', body: '{}' })
    expect(res.status).toBe(405)
  })
})

describe('a known sub-path with the wrong method answers 405, not 404', () => {
  it('DELETE /api/projects', async () => {
    expect((await authFetch('/api/projects', { method: 'DELETE' })).status).toBe(405)
  })
  it('DELETE /api/projects/:slug', async () => {
    expect((await authFetch(`/api/projects/${slug}`, { method: 'DELETE' })).status).toBe(405)
  })
  it('POST /api/projects/:slug/search', async () => {
    expect((await authFetch(`/api/projects/${slug}/search?q=x`, { method: 'POST' })).status).toBe(405)
  })
  it('GET /api/projects/:slug/rescan', async () => {
    expect((await authFetch(`/api/projects/${slug}/rescan`)).status).toBe(405)
  })
  it('PUT /api/projects/:slug/knowledge', async () => {
    expect((await authFetch(`/api/projects/${slug}/knowledge`, { method: 'PUT' })).status).toBe(405)
  })
  it('GET /api/projects/:slug/knowledge/:name', async () => {
    expect((await authFetch(`/api/projects/${slug}/knowledge/guide.pdf`)).status).toBe(405)
  })
  it('POST /api/projects/:slug/artifacts', async () => {
    expect((await authFetch(`/api/projects/${slug}/artifacts`, { method: 'POST' })).status).toBe(405)
  })
  it('GET /api/projects/:slug/artifacts/:name/promote', async () => {
    expect((await authFetch(`/api/projects/${slug}/artifacts/sketch.md/promote`)).status).toBe(405)
  })
  it('POST /api/projects/:slug/chats', async () => {
    expect((await authFetch(`/api/projects/${slug}/chats`, { method: 'POST' })).status).toBe(405)
  })
  it('GET /api/projects/:slug/chats/:file', async () => {
    expect((await authFetch(`/api/projects/${slug}/chats/whatever.jsonl`)).status).toBe(405)
  })
})

describe('a trailing extra segment on a known route 404s (not ignored)', () => {
  it('GET /api/projects/:slug/knowledge/:name/extra', async () => {
    const res = await authFetch(`/api/projects/${slug}/knowledge/guide.pdf/extra`)
    expect(res.status).toBe(404)
  })
})

describe('projects not configured', () => {
  it('503s on /api/projects when deps.projects is absent', async () => {
    const unconfigured = new DashboardServer({ port: 0, tokens: _tokens })
    try {
      await waitForPort(unconfigured)
      const headers = new Headers({ Authorization: `Bearer ${_INFERENCE}` })
      const res = await fetch(`http://localhost:${unconfigured.getPort()}/api/projects`, { headers })
      expect(res.status).toBe(503)
    } finally {
      unconfigured.stop()
    }
  })
})
