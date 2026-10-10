/**
 * GET /api/projects/:slug/images/:name — a generated picture (F174) or its
 * public record. Mounted under the project routes' inference gate, names
 * checked after decoding (`<32 hex>.png|json` only), and the PNG served
 * under headers that make it inert anywhere but an <img>: type from the
 * fixed extension, nosniff, a sandbox CSP, inline, immutable private cache,
 * no ACAO. The page fetches it with the token header into a blob URL.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { createProject } from '../../projects/layout.js'
import { INTERRUPTED_REASON, pngPath, RUN_ID, writeSidecar, type ImageSidecar } from '../../imagegen/store.js'
import { canSymlinkFiles, PNG_1X1 } from '../imagegen/mockComfy.js'
import type { IngestEvent } from '../../projects/ingest.js'

const CAN_SYMLINK_FILES = canSymlinkFiles()

const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-images-tokens-'))
const tokens = loadOrCreateTokens(tokenDir)
const INFERENCE = tokens.tokenFor('inference')!

const DONE = 'a'.repeat(32)
const STALE = 'b'.repeat(32)
const PLANTED = 'c'.repeat(32)
const LINKED = 'd'.repeat(32)
const MISSING = 'e'.repeat(32)

let server: DashboardServer
let HOME: string
let OUTSIDE: string
let slug: string
let BASE: string

function sidecar(key: string, over: Partial<ImageSidecar> = {}): ImageSidecar {
  return {
    schema: 1, key, status: 'done', runId: RUN_ID, prompt: 'a tall green alien', negative: 'blurry', alt: 'Alien', seed: 7, width: 1024, height: 768,
    steps: 40, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', checkpoint: 'juggernautXL_v9.safetensors', workflow: { source: 'builtin', sha256: 'builtin-1' },
    apiPrompt: { '3': { class_type: 'KSampler', inputs: {} } }, comfy: { host: 'pc:8188', promptId: 'p1', outputs: [{ filename: 'x_00001_.png', subfolder: 'cynco', type: 'output' }] },
    sha256: 'f'.repeat(64), bytes: PNG_1X1.length, queuedAt: '2026-10-10T00:00:00.000Z', finishedAt: '2026-10-10T00:00:30.000Z',
    origin: { chatFile: 'c.jsonl', toolId: 't1', elementId: 'img-a', surfaceId: 'aliens' },
    ...over,
  }
}

function get(path: string, init: RequestInit = {}, token: string | null = INFERENCE): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${BASE}${path}`, { ...init, headers })
}
const img = (name: string) => `/api/projects/${slug}/images/${name}`

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), 'cynco-dash-images-home-'))
  OUTSIDE = mkdtempSync(join(tmpdir(), 'cynco-dash-images-outside-'))
  slug = createProject(HOME, { name: 'Aliens' }).slug
  const dir = join(HOME, slug)
  writeSidecar(dir, sidecar(DONE))
  writeFileSync(pngPath(dir, DONE), PNG_1X1)
  writeSidecar(dir, sidecar(STALE, { status: 'running', runId: 'an-engine-that-stopped', finishedAt: undefined, sha256: undefined, bytes: undefined }))
  writeFileSync(pngPath(dir, PLANTED), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8')
  if (CAN_SYMLINK_FILES) {
    writeFileSync(join(OUTSIDE, 'secret.png'), PNG_1X1)
    symlinkSync(join(OUTSIDE, 'secret.png'), pngPath(dir, LINKED))
  }
  mkdirSync(join(dir, 'images'), { recursive: true })
  server = new DashboardServer({
    port: 0,
    tokens,
    deps: { projects: { home: HOME, embed: null, embedModel: 'stub-model', emit: (_e: IngestEvent) => {}, contextLength: 8192 } },
  })
  const deadline = Date.now() + 2000
  while (server.getPort() === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  BASE = `http://127.0.0.1:${server.getPort()}`
})

afterAll(() => {
  server.stop()
  rmSync(tokenDir, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

describe('the image route is gated like every project route', () => {
  it.each([[`${DONE}.png`], [`${DONE}.json`], ['nonsense']])('%s refuses an anonymous caller with 401', async (name) => {
    const res = await get(img(name), {}, null)
    expect(res.status).toBe(401)
  })

  it('a token in the query string is not accepted', async () => {
    const res = await get(img(`${DONE}.png?token=${INFERENCE}`), {}, null)
    expect(res.status).toBe(401)
  })
})

describe('a done picture', () => {
  it('200s with the PNG bytes under exactly the inert headers', async () => {
    const res = await get(img(`${DONE}.png`), { headers: { Origin: 'http://evil.example' } })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_1X1)).toBe(true)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('its record is the public subset, never cached', async () => {
    const res = await get(img(`${DONE}.json`))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({
      status: 'done', w: 1024, h: 768, prompt: 'a tall green alien', alt: 'Alien', checkpoint: 'juggernautXL_v9.safetensors', seed: 7,
      finishedAt: '2026-10-10T00:00:30.000Z',
    })
    // no host, prompt id, output names or graph
    expect(JSON.stringify(body)).not.toMatch(/pc:8188|p1|x_00001_|KSampler|apiPrompt|origin/)
  })

  it('a record left running by an engine that stopped reads failed: interrupted', async () => {
    const res = await get(img(`${STALE}.json`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'failed', reason: INTERRUPTED_REASON })
  })
})

describe('anything else is refused, never read', () => {
  it.each([
    ['a percent-encoded traversal', `..%2f..%2f${DONE}.png`],
    ['a traversal to project.json', '..%2fproject.json'],
    ['a backslash traversal', `..%5c${DONE}.png`],
    ['a null byte', `${DONE}.png%00`],
    ['a null byte in front', `%00${DONE}.png`],
    ['uppercase hex', `${DONE.toUpperCase()}.png`],
    ['31 hex', `${DONE.slice(1)}.png`],
    ['an svg', `${DONE}.svg`],
    ['the origin index', 'index.json'],
  ])('%s answers 400 "bad image name"', async (_what, name) => {
    const res = await get(img(name))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad image name' })
  })

  it('a malformed escape answers 400 "bad path encoding"', async () => {
    const res = await get(img('%E0%A4%A.png'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad path encoding' })
  })

  it('a missing picture or project answers 404', async () => {
    expect((await get(img(`${MISSING}.png`))).status).toBe(404)
    expect(await (await get(img(`${MISSING}.json`))).json()).toEqual({ error: 'no such image' })
    const res = await get(`/api/projects/no-such-project/images/${DONE}.png`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such project' })
  })

  it('a planted file that is not a PNG answers 415, never its bytes', async () => {
    const res = await get(img(`${PLANTED}.png`))
    expect(res.status).toBe(415)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ error: `images/${PLANTED}.png is not a PNG; refused` })
  })

  it.skipIf(!CAN_SYMLINK_FILES)('a link out of the project answers 404', async () => {
    const res = await get(img(`${LINKED}.png`))
    expect(res.status).toBe(404)
  })

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s answers 405', async (method) => {
    const res = await get(img(`${DONE}.png`), { method })
    expect(res.status).toBe(405)
  })

  it('no listing and no extra segment: 404', async () => {
    expect((await get(`/api/projects/${slug}/images`)).status).toBe(404)
    expect((await get(img(`${DONE}.png/extra`))).status).toBe(404)
  })

  it('a bad slug is refused before anything is joined', async () => {
    const res = await get(`/api/projects/..%2F${slug}/images/${DONE}.png`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad slug' })
  })
})
