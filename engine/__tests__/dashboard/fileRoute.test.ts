/**
 * GET /api/projects/:slug/files/<path> — an image file the model wrote into
 * the project, shown by an Image whose src is its relative path (dashboard
 * transcript, 2026-10-11: 1:1 printable SVG templates the page could not
 * show). Mounted under the project routes' inference gate; the decoded path
 * must pass the validator's own rule (`projectImagePath`), the file must
 * really be inside the project (links followed), carry its format's
 * signature and stay under the cap; it goes out under its fixed type, never
 * sniffed, with a sandbox CSP, inline, never cached (the file can change),
 * no ACAO. The page fetches it with the token header into a blob URL.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { createProject } from '../../projects/layout.js'
import { canHardLinkFiles, canSymlinkFiles, PNG_1X1 } from '../imagegen/mockComfy.js'
import type { IngestEvent } from '../../projects/ingest.js'

const CAN_SYMLINK_FILES = canSymlinkFiles()
const CAN_HARD_LINK_FILES = canHardLinkFiles()

const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-files-tokens-'))
const tokens = loadOrCreateTokens(tokenDir)
const INFERENCE = tokens.tokenFor('inference')!

const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- a 1:1 template -->\n<svg xmlns="http://www.w3.org/2000/svg" width="30in" height="40in"><rect width="1" height="1"/></svg>\n'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

let server: DashboardServer
let HOME: string
let OUTSIDE: string
let slug: string
let BASE: string

function get(path: string, init: RequestInit = {}, token: string | null = INFERENCE): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${BASE}${path}`, { ...init, headers })
}
const file = (path: string) => `/api/projects/${slug}/files/${path}`

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), 'cynco-dash-files-home-'))
  OUTSIDE = mkdtempSync(join(tmpdir(), 'cynco-dash-files-outside-'))
  slug = createProject(HOME, { name: 'Towers' }).slug
  const dir = join(HOME, slug)
  mkdirSync(join(dir, 'tower', 'templates'), { recursive: true })
  mkdirSync(join(dir, 'my tower (v2)'), { recursive: true })
  writeFileSync(join(dir, 'tower', 'templates', 'tower_v1.1_30in.svg'), SVG)
  writeFileSync(join(dir, 'front.png'), PNG_1X1)
  writeFileSync(join(dir, 'a.jpg'), JPEG)
  writeFileSync(join(dir, 'c.gif'), GIF)
  writeFileSync(join(dir, 'd.webp'), WEBP)
  writeFileSync(join(dir, 'my tower (v2)', 'front view.png'), PNG_1X1)
  writeFileSync(join(dir, 'fake.png'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8')
  writeFileSync(join(dir, 'page.svg'), '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>', 'utf8')
  writeFileSync(join(dir, 'bypass.svg'), '<!DOCTYPE svg SYSTEM "a><!--" [<!ENTITY x "yyyyyyyy">]><!----><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>', 'utf8')
  writeFileSync(join(dir, 'big.png'), PNG_1X1)
  truncateSync(join(dir, 'big.png'), 32 * 1024 * 1024 + 1)
  writeFileSync(join(dir, 'big.svg'), SVG)
  truncateSync(join(dir, 'big.svg'), 2 * 1024 * 1024 + 1)
  writeFileSync(join(OUTSIDE, 'secret.png'), PNG_1X1)
  if (CAN_SYMLINK_FILES) {
    symlinkSync(join(OUTSIDE, 'secret.png'), join(dir, 'linked.png'))
    symlinkSync(OUTSIDE, join(dir, 'elsewhere'), 'junction')
  }
  if (CAN_HARD_LINK_FILES) linkSync(join(OUTSIDE, 'secret.png'), join(dir, 'hard.png'))
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

describe('the file route is gated like every project route', () => {
  it.each([['tower/templates/tower_v1.1_30in.svg'], ['front.png'], ['nonsense']])('%s refuses an anonymous caller with 401', async (path) => {
    const res = await get(file(path), {}, null)
    expect(res.status).toBe(401)
  })

  it('a token in the query string is not accepted', async () => {
    const res = await get(file(`front.png?token=${INFERENCE}`), {}, null)
    expect(res.status).toBe(401)
  })
})

describe('a file the model wrote into the project', () => {
  const INERT = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'inline',
    'cache-control': 'no-store',
  }

  it('an svg 200s as image/svg+xml under exactly the inert headers, never cached, no ACAO', async () => {
    const res = await get(file('tower/templates/tower_v1.1_30in.svg'), { headers: { Origin: 'http://evil.example' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SVG)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    for (const [k, v] of Object.entries(INERT)) expect(res.headers.get(k), k).toBe(v)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each([
    ['front.png', 'image/png', PNG_1X1],
    ['a.jpg', 'image/jpeg', JPEG],
    ['c.gif', 'image/gif', GIF],
    ['d.webp', 'image/webp', WEBP],
    ['my%20tower%20(v2)/front%20view.png', 'image/png', PNG_1X1],
  ])('%s 200s as %s with the same headers', async (path, type, bytes) => {
    const res = await get(file(path))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    expect(res.headers.get('content-type')).toBe(type)
    for (const [k, v] of Object.entries(INERT)) expect(res.headers.get(k), k).toBe(v)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('anything else is refused, never read', () => {
  it.each([
    ['a percent-encoded traversal', '..%2f..%2fproject.json'],
    ['a traversal to project.json with an image name after it', '..%2fproject.json%2f..%2ffront.png'],
    ['a traversal inside a segment', 'tower%2f..%2f..%2fsecret.png'],
    ['a backslash traversal', '..%5cfront.png'],
    ['a backslash separator', 'tower%5ctemplates%5ctower_v1.1_30in.svg'],
    ['a null byte', 'front.png%00'],
    ['a null byte in front', '%00front.png'],
    ['a null byte before the extension', 'front%00.png'],
    ['unicode dots', '%E2%80%A4%E2%80%A4%2Ffront.png'],
    ['a fullwidth dot', '%EF%BC%8E%EF%BC%8E/front.png'],
    ['an absolute path', '%2Fetc%2Fpasswd.png'],
    ['a drive letter', 'C:%2Ffront.png'],
    ['a dot-leading segment', '.cynco/index/x.png'],
    ['the project file', 'project.json'],
    ['an html file', 'index.html'],
    ['a double extension', 'front.png.html'],
    ['a query inside the segment', 'front.png%3Fv=2'],
    ['201 characters', 'a'.repeat(197) + '.png'],
  ])('%s answers 400 "bad file path"', async (_what, path) => {
    const res = await get(file(path))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad file path' })
  })

  it('a malformed escape answers 400 "bad path encoding"', async () => {
    const res = await get(file('%E0%A4%A.png'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad path encoding' })
  })

  it('a missing file or project answers 404', async () => {
    const res = await get(file('tower/templates/missing.svg'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no such file' })
    expect((await get(file('tower/templates'))).status).toBe(400) // a folder has no image extension
    const other = await get('/api/projects/no-such-project/files/front.png')
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual({ error: 'no such project' })
  })

  it('a raster without its signature and an svg that is not one answer 415, never their bytes', async () => {
    const png = await get(file('fake.png'))
    expect(png.status).toBe(415)
    expect(png.headers.get('content-type')).toBe('application/json')
    expect(await png.json()).toEqual({ error: 'fake.png is not a PNG file; refused' })
    const svg = await get(file('page.svg'))
    expect(svg.status).toBe(415)
    expect(svg.headers.get('content-type')).toBe('application/json')
    expect(await svg.json()).toEqual({ error: 'page.svg is not a SVG file; refused' })
    // review: a DOCTYPE whose SYSTEM literal holds '>' hid its internal subset from the scan
    const bypass = await get(file('bypass.svg'))
    expect(bypass.status).toBe(415)
    expect(await bypass.json()).toEqual({ error: 'bypass.svg is not a SVG file; refused' })
  })

  it('a raster over 32 MB and an svg over 2 MB answer 413, never their bytes', async () => {
    const png = await get(file('big.png'))
    expect(png.status).toBe(413)
    expect(await png.json()).toEqual({ error: 'big.png is larger than 32 MB; refused' })
    const svg = await get(file('big.svg'))
    expect(svg.status).toBe(413)
    expect(await svg.json()).toEqual({ error: 'big.svg is larger than 2 MB; refused' })
  })

  it.skipIf(!CAN_SYMLINK_FILES)('a link out of the project answers 404, through a file link or a folder link', async () => {
    expect((await get(file('linked.png'))).status).toBe(404)
    expect((await get(file('elsewhere/secret.png'))).status).toBe(404)
  })

  // review: realInside follows symlinks only, so a hard link to a file outside the project was served with the outside bytes
  it.skipIf(!CAN_HARD_LINK_FILES)('a hard link to a file outside the project answers 404, never its bytes', async () => {
    const res = await get(file('hard.png'))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ error: 'no such file' })
  })

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s answers 405', async (method) => {
    const res = await get(file('front.png'), { method })
    expect(res.status).toBe(405)
  })

  it('no listing: 404', async () => {
    expect((await get(`/api/projects/${slug}/files`)).status).toBe(404)
    expect((await get(`/api/projects/${slug}/files/`)).status).toBe(404)
  })

  it('a bad slug is refused before anything is joined', async () => {
    const res = await get(`/api/projects/..%2F${slug}/files/front.png`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad slug' })
  })
})
