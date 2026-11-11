/**
 * /api/projects/<slug>/inbox — a project's drafts, over HTTP
 * (engine/projects/inbox.ts; docs/decisions/2026-11-11-phone-uploads-and-inbox.md).
 *
 * Inference scope like every project route, so the owner's paired phone can
 * read a draft and accept or discard it; nothing here is configuration.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { createProject } from '../../projects/layout.js'
import { addDraft } from '../../projects/inbox.js'
import type { IngestEvent } from '../../projects/ingest.js'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const FROM = { mission: 'yard-weekly', triggerId: 'planting-plan' }
const T0 = new Date('2026-11-11T18:45:00Z')

async function start() {
  const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-inbox-routes-'))
  const home = mkdtempSync(join(tmpdir(), 'cynco-inbox-routes-home-'))
  dirs.push(tokenDir, home)
  const tokens = loadOrCreateTokens(tokenDir)
  let peer = '127.0.0.1'
  const events: IngestEvent[] = []
  const server = new DashboardServer({
    port: 0, tokens, proxyPort: null,
    deps: { remoteAddress: () => peer, projects: { home, embed: null, embedModel: 'none', emit: (e: IngestEvent) => events.push(e), contextLength: 8192 } },
  })
  servers.push(server)
  await new Promise(r => setTimeout(r, 60))
  const base = `http://127.0.0.1:${server.getPort()}`
  const meta = createProject(home, { name: 'Yard' })
  const dir = join(home, meta.slug)
  const call = (path: string, init: RequestInit = {}, token: string | null = tokens.tokenFor('inference')) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(base + path, { ...init, headers })
  }
  return { server, tokens, home, dir, slug: meta.slug, call, events, asPhone() { peer = '100.64.0.9' }, asDesk() { peer = '127.0.0.1' } }
}

describe('the inbox routes', () => {
  it('list, read, accept: the draft becomes an artifact and is gone from the inbox', async () => {
    const t = await start()
    const { name } = addDraft(t.dir, { stem: 'planting-plan', text: '# Planting plan\n\nTulips.\n', from: FROM, summary: 'A plan.', now: T0 }) as { name: string }
    const list = await (await t.call(`/api/projects/${t.slug}/inbox`)).json()
    expect(list).toEqual({ full: false, drafts: [{ name, bytes: 25, addedAt: T0.toISOString(), from: 'yard-weekly · planting-plan', summary: 'A plan.', readable: true }] })
    const read = await (await t.call(`/api/projects/${t.slug}/inbox/${encodeURIComponent(name)}`)).json()
    expect(read).toEqual({ name, text: '# Planting plan\n\nTulips.\n', truncated: false })
    const accepted = await t.call(`/api/projects/${t.slug}/inbox/${encodeURIComponent(name)}/accept`, { method: 'POST' })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ accepted: name, artifact: name })
    expect(readFileSync(join(t.dir, 'artifacts', name), 'utf8')).toBe('# Planting plan\n\nTulips.\n')
    expect((await (await t.call(`/api/projects/${t.slug}/inbox`)).json()).drafts).toEqual([])
    const artifacts = await (await t.call(`/api/projects/${t.slug}/artifacts`)).json()
    expect(Object.keys(artifacts.files)).toEqual([name])
    expect(t.events.map(e => e.filePath)).toEqual([`artifacts/${name}`])
  })

  it('discard: gone, and a second discard is a 404', async () => {
    const t = await start()
    const { name } = addDraft(t.dir, { stem: 'plan', text: 'x\n', from: FROM, now: T0 }) as { name: string }
    const gone = await t.call(`/api/projects/${t.slug}/inbox/${encodeURIComponent(name)}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(await gone.json()).toEqual({ discarded: name })
    expect(readdirSync(join(t.dir, 'inbox')).filter(n => !n.startsWith('.'))).toEqual([])
    expect((await t.call(`/api/projects/${t.slug}/inbox/${encodeURIComponent(name)}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('the project list carries the count', async () => {
    const t = await start()
    addDraft(t.dir, { stem: 'a', text: 'x\n', from: FROM, now: T0 })
    addDraft(t.dir, { stem: 'b', text: 'y\n', from: FROM, now: T0 })
    const list = await (await t.call('/api/projects')).json()
    expect(list.projects.map((p: { slug: string; drafts: number }) => [p.slug, p.drafts])).toEqual([[t.slug, 2]])
  })

  it('a paired phone may read, accept and discard: inference scope, as for every project route', async () => {
    const t = await start()
    const { name } = addDraft(t.dir, { stem: 'plan', text: 'x\n', from: FROM, now: T0 }) as { name: string }
    t.asPhone()
    const paired = await (await fetch(`http://127.0.0.1:${t.server.getPort()}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: t.server.pairingCode(), label: 'Pixel' }) })).json()
    expect((await t.call(`/api/projects/${t.slug}/inbox`, {}, paired.token)).status).toBe(200)
    expect((await t.call(`/api/projects/${t.slug}/inbox/${encodeURIComponent(name)}/accept`, { method: 'POST' }, paired.token)).status).toBe(200)
    // No token, or the desk's shared one off this machine: unknown.
    expect((await t.call(`/api/projects/${t.slug}/inbox`, {}, null)).status).toBe(401)
    expect((await t.call(`/api/projects/${t.slug}/inbox`, {}, t.tokens.tokenFor('inference'))).status).toBe(401)
  })

  it('a name that reaches outside the inbox never reaches a path join: 404, and the project file is untouched', async () => {
    const t = await start()
    const before = readFileSync(join(t.dir, 'project.json'), 'utf8')
    for (const bad of ['..%2Fproject.json', '..%5Cproject.json', 'index.json', '.meta', '.meta%2Fx.json', 'a%2Fb.md', '%00.md']) {
      expect((await t.call(`/api/projects/${t.slug}/inbox/${bad}`)).status, `GET ${bad}`).toBe(404)
      expect((await t.call(`/api/projects/${t.slug}/inbox/${bad}`, { method: 'DELETE' })).status, `DELETE ${bad}`).toBe(404)
      expect((await t.call(`/api/projects/${t.slug}/inbox/${bad}/accept`, { method: 'POST' })).status, `accept ${bad}`).toBe(404)
    }
    expect(readFileSync(join(t.dir, 'project.json'), 'utf8')).toBe(before)
  })

  it('wrong methods and shapes: 405 on a known path, 404 past it, 404 for an unknown project', async () => {
    const t = await start()
    writeFileSync(join(t.dir, 'inbox', 'plan.md'), 'x\n')
    expect((await t.call(`/api/projects/${t.slug}/inbox`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405)
    expect((await t.call(`/api/projects/${t.slug}/inbox/plan.md`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405)
    expect((await t.call(`/api/projects/${t.slug}/inbox/plan.md/accept`)).status).toBe(405)
    expect((await t.call(`/api/projects/${t.slug}/inbox/plan.md/promote`, { method: 'POST' })).status).toBe(404)
    expect((await t.call('/api/projects/no-such/inbox')).status).toBe(404)
  })

  it('a picture draft has no words to read, and says what to do instead', async () => {
    const t = await start()
    writeFileSync(join(t.dir, 'inbox', 'photo.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))
    const r = await t.call(`/api/projects/${t.slug}/inbox/photo.jpg`)
    expect(r.status).toBe(415)
    expect((await r.json()).error).toMatch(/not text; accept it to keep it/)
  })
})
