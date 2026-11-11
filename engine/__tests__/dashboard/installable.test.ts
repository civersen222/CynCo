/**
 * The installable page: a web manifest, two icons, and the head tags that
 * point at them (engine/dashboard/installable.ts). Chrome installs a page that
 * is served over HTTPS and whose manifest has a name, a start_url, a
 * standalone display and a 192 px and a 512 px icon. The three routes are
 * static and carry nothing about the engine, so they answer without a token:
 * the browser fetches a manifest and its icons with no Authorization header.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { PNG } from 'pngjs'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { webManifest, appIconPng, APP_ICON_SIZES } from '../../dashboard/installable.js'
import { pairingPage } from '../../dashboard/access.js'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function start(peer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-install-'))
  dirs.push(dir)
  const tokens = loadOrCreateTokens(dir)
  const server = new DashboardServer({ port: 0, tokens, deps: { remoteAddress: () => peer }, proxyPort: null })
  servers.push(server)
  await new Promise(r => setTimeout(r, 50))
  return { tokens, base: `http://127.0.0.1:${server.getPort()}` }
}

describe('webManifest', () => {
  const m = webManifest()
  it('has what Chrome needs to offer an install', () => {
    expect(m.name).toBe('CynCo')
    expect(m.short_name).toBe('CynCo')
    expect(m.start_url).toBe('/')
    expect(m.scope).toBe('/')
    expect(m.display).toBe('standalone')
    expect(m.icons.map(i => i.sizes)).toEqual(['192x192', '512x512'])
    for (const i of m.icons) { expect(i.type).toBe('image/png'); expect(i.src).toMatch(/^\/icon-(192|512)\.png$/) }
    expect((m as Record<string, unknown>).prefer_related_applications).toBeUndefined()
  })
  it('says nothing about the engine: no host, no token, no path on this machine', () => {
    const text = JSON.stringify(m)
    expect(text).not.toMatch(/[0-9a-f]{32}/)
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('appIconPng', () => {
  it('is a square PNG of the size asked for, and is a picture, not a flat fill', () => {
    for (const size of APP_ICON_SIZES) {
      const png = PNG.sync.read(appIconPng(size))
      expect([png.width, png.height]).toEqual([size, size])
      const colours = new Set<number>()
      for (let i = 0; i < png.data.length; i += 4) colours.add((png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!)
      expect(colours.size).toBeGreaterThan(2)
      // Opaque edge to edge: Android masks the icon to its own shape.
      for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 255) throw new Error('transparent pixel at ' + i)
      // The corners are background; the mark stays inside the mask's safe zone (the middle 80%).
      const at = (x: number, y: number) => { const o = (y * size + x) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]] }
      expect(at(0, 0)).toEqual(at(size - 1, size - 1))
      expect(at(Math.floor(size * 0.05), Math.floor(size / 2))).toEqual(at(0, 0))
    }
  })
  it('is drawn once per size', () => {
    expect(appIconPng(192)).toBe(appIconPng(192))
  })
})

describe('the routes', () => {
  for (const [who, peer] of [['the desk', '127.0.0.1'], ['a phone', '100.64.0.9']] as const) {
    it(`${who}: the manifest and both icons answer with no token`, async () => {
      const t = await start(peer)
      const m = await fetch(t.base + '/manifest.webmanifest')
      expect(m.status).toBe(200)
      expect(m.headers.get('content-type')).toBe('application/manifest+json')
      expect(await m.json()).toEqual(JSON.parse(JSON.stringify(webManifest())))
      for (const size of APP_ICON_SIZES) {
        const icon = await fetch(`${t.base}/icon-${size}.png`)
        expect(icon.status).toBe(200)
        expect(icon.headers.get('content-type')).toBe('image/png')
        const bytes = Buffer.from(await icon.arrayBuffer())
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        expect(PNG.sync.read(bytes).width).toBe(size)
      }
    })
  }

  it('nothing else became public: a neighbouring path, another size and a POST still meet the token check', async () => {
    const t = await start('100.64.0.9')
    expect((await fetch(t.base + '/manifest.json')).status).toBe(401)
    expect((await fetch(t.base + '/icon-64.png')).status).toBe(401)
    expect((await fetch(t.base + '/icon-192.png/../api/session')).status).toBe(401)
    expect((await fetch(t.base + '/manifest.webmanifest', { method: 'POST', body: '{}' })).status).toBe(401)
  })
})

describe('the pages point at them', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
  const head = html.slice(0, html.indexOf('</head>'))
  for (const [name, page] of [['the dashboard page', head], ['the pairing page', pairingPage()]] as const) {
    it(`${name}: manifest link, theme colour, icons`, () => {
      expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest">')
      expect(page).toMatch(/<meta name="theme-color" content="#1e1e1e">/)
      expect(page).toContain('<link rel="icon" type="image/png" href="/icon-192.png">')
      expect(page).toContain('<link rel="apple-touch-icon" href="/icon-192.png">')
    })
  }
})

describe('the socket URL on an https page (page function, lifted by text)', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
  const start0 = html.indexOf('function wsUrl(')
  const end = /\r?\n\}\r?\n/.exec(html.slice(start0))!
  const wsUrl = new Function(`${html.slice(start0, start0 + end.index + end[0].length)}; return wsUrl;`)() as (loc: { protocol: string; host: string }, token: string | null, query: string) => string

  it('behind tailscale serve: wss on the name, no dangling colon where the port would be', () => {
    expect(wsUrl({ protocol: 'https:', host: 'longdongsilver.tail05397a.ts.net' }, 'abc', '')).toBe('wss://longdongsilver.tail05397a.ts.net/ws?token=abc')
  })
  it('on the desk and on the plain tailnet address: ws with the port', () => {
    expect(wsUrl({ protocol: 'http:', host: '127.0.0.1:9161' }, 't k', '&epoch=e-0&since=3&off=0')).toBe('ws://127.0.0.1:9161/ws?token=t%20k&epoch=e-0&since=3&off=0')
    expect(wsUrl({ protocol: 'http:', host: '100.101.192.101:9161' }, null, '')).toBe('ws://100.101.192.101:9161/ws?token=')
  })
  it('connectWS builds its socket from it', () => {
    expect(html).toMatch(/ws = new WebSocket\(wsUrl\(location, window\.__CYNCO_TOKEN,/)
  })
})
