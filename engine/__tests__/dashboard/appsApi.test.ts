// The owner's local-LLM apps on the dashboard (docs/decisions/2026-11-11-local-llm-apps.md, slice 6).
//
// The owner can see the apps CynCo knows (name, how each serves its model,
// whether it holds the GPU now, whether CynCo manages it) and switch `manage`
// per app at the desk. A remote client may read and may not change, like every
// other management action.
import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAppsView, setAppManagedApi, type AppsDeps } from '../../dashboard/appsApi.js'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { loadRegistry } from '../../apps/registry.js'

const ROOT = 'C:\\Users\\o\\dndai'
const dndai = { id: 'dndai', name: 'dndai', root: ROOT, script: 'scripts/start-llm.sh', manage: true, source: 'by hand', launch: { exe: 'C:\\git\\usr\\bin\\bash.exe', args: ['scripts/start-llm.sh'], cwd: ROOT } }
const screenplayer = { id: 'screenplayer', name: 'screenplayer', root: 'C:\\Users\\o\\screenplayer', models: ['qwen3.6:27b'], manage: true, source: 'by hand' }

let home = ''
let registry = ''
let record = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-apps-dash-'))
  registry = join(home, 'apps.json')
  record = join(home, 'displaced-apps.json')
  writeFileSync(registry, JSON.stringify({ version: 1, apps: [dndai], ollamaApps: [screenplayer], ollama: { url: 'http://127.0.0.1:1', manage: true } }))
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const deps = (over: Partial<AppsDeps> = {}): AppsDeps => ({
  port: 8081, registryFile: registry, displacedFile: record,
  portHolder: async () => null, ollamaLoaded: async () => [], ...over,
})

describe('readAppsView', () => {
  it('lists both kinds of app with how each serves its model, in words', async () => {
    const v = await readAppsView(deps())
    expect(v.apps).toEqual([
      { id: 'dndai', name: 'dndai', kind: 'server', serves: 'its own model server, started by bash.exe scripts/start-llm.sh', root: ROOT, manage: true, holdsGpu: false, holding: null, owed: false },
      { id: 'screenplayer', name: 'screenplayer', kind: 'ollama', serves: 'Ollama (qwen3.6:27b)', root: 'C:\\Users\\o\\screenplayer', manage: true, holdsGpu: false, holding: null, owed: false },
    ])
    expect(v.port).toBe(8081)
    expect(v.ollama).toEqual({ url: 'http://127.0.0.1:1', manage: true })
  })

  it('an app whose server is on the model port holds the GPU, and the row says what it holds', async () => {
    const v = await readAppsView(deps({ portHolder: async () => ({ appId: 'dndai', pid: 4242 }) }))
    expect(v.apps[0]).toMatchObject({ holdsGpu: true, holding: 'port 8081 (pid 4242)' })
    expect(v.apps[1].holdsGpu).toBe(false)
  })

  it('an Ollama app holds the GPU when Ollama has one of its models loaded, `:latest` or not', async () => {
    const v = await readAppsView(deps({ ollamaLoaded: async () => [{ name: 'qwen3.6:27b', vramMib: 17408 }] }))
    expect(v.apps[1]).toMatchObject({ holdsGpu: true, holding: 'qwen3.6:27b in Ollama, 17.0 GB of GPU memory' })
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [], ollamaApps: [{ ...screenplayer, models: ['qwen3.6'] }] }))
    const latest = await readAppsView(deps({ ollamaLoaded: async () => [{ name: 'qwen3.6:latest', vramMib: 17408 }] }))
    expect(latest.apps[0].holdsGpu).toBe(true)
  })

  it('an app CynCo stopped and owes its server says so', async () => {
    writeFileSync(record, JSON.stringify([{ appId: 'dndai', name: 'dndai', root: ROOT, port: 8081, at: '2026-11-11T18:00:00.000Z', by: 'the chat engine', launch: dndai.launch }]))
    expect((await readAppsView(deps())).apps[0].owed).toBe(true)
  })

  it('no registry yet: an empty list, not an error; a probe that throws is not holding', async () => {
    rmSync(registry)
    expect((await readAppsView(deps())).apps).toEqual([])
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [dndai] }))
    const v = await readAppsView(deps({ portHolder: async () => { throw new Error('powershell is gone') } }))
    expect(v.apps[0].holdsGpu).toBe(false)
  })
})

describe('setAppManagedApi', () => {
  it('switches one app and keeps the rest of the file', async () => {
    const r = await setAppManagedApi(deps(), 'screenplayer', { manage: false })
    expect(r.status).toBe(200)
    const reg = loadRegistry(registry)
    expect(reg.ollamaApps[0].manage).toBe(false)
    expect(reg.apps[0].manage).toBe(true)
    expect(reg.ollama.url).toBe('http://127.0.0.1:1')
    expect((r.json as any).apps.find((a: any) => a.id === 'screenplayer').manage).toBe(false)
  })

  it('refuses a body that is not { manage: boolean } and an app it does not know, and writes nothing', async () => {
    const before = readFileSync(registry, 'utf-8')
    expect((await setAppManagedApi(deps(), 'dndai', { manage: 'no' })).status).toBe(400)
    expect((await setAppManagedApi(deps(), 'dndai', null)).status).toBe(400)
    expect((await setAppManagedApi(deps(), 'nobody', { manage: false })).status).toBe(404)
    expect(readFileSync(registry, 'utf-8')).toBe(before)
  })
})

describe('/api/apps on the dashboard server', () => {
  const dirs: string[] = []
  const servers: DashboardServer[] = []
  afterEach(() => { for (const s of servers.splice(0)) s.stop() })
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  async function start() {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-apps-srv-'))
    dirs.push(dir)
    const tokens = loadOrCreateTokens(dir)
    const server = new DashboardServer({ port: 0, tokens, deps: { apps: deps() }, proxyPort: 0 })
    servers.push(server)
    const until = Date.now() + 2000
    while ((server.getPort() === 0 || !server.proxyListener()) && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    const desk = `http://127.0.0.1:${server.getPort()}`
    const bearer = (scope: 'inference' | 'management') => ({ Authorization: `Bearer ${tokens.tokenFor(scope)}` })
    /** As `tailscale serve` forwards it: every client on the proxy listener is remote. */
    const remote = (path: string, method: string, headers: Record<string, string>, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.proxyListener()!.port, path, method,
          headers: { Host: 'pc.tail1234.ts.net', ...(body ? { 'Content-Length': String(Buffer.byteLength(body)), 'Content-Type': 'application/json' } : {}), ...headers } },
          res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
        req.on('error', reject)
        req.end(body)
      })
    return { desk, bearer, remote }
  }
  const put = (base: string, headers: Record<string, string>) =>
    fetch(`${base}/api/apps/screenplayer`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ manage: false }) })

  it('reading needs only the read token; no token reads nothing', async () => {
    const s = await start()
    const ok = await fetch(`${s.desk}/api/apps`, { headers: s.bearer('inference') })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as any).apps.map((a: any) => a.name)).toEqual(['dndai', 'screenplayer'])
    expect((await fetch(`${s.desk}/api/apps`)).status).toBe(401)
  })

  it('switching `manage` is management: the read token is refused and nothing is written; the management token at the desk switches it', async () => {
    const s = await start()
    expect((await put(s.desk, s.bearer('inference'))).status).toBe(403)
    expect(loadRegistry(registry).ollamaApps[0].manage).toBe(true)
    const done = await put(s.desk, s.bearer('management'))
    expect(done.status).toBe(200)
    expect(loadRegistry(registry).ollamaApps[0].manage).toBe(false)
  })

  it('a remote client cannot change it whatever it presents, the management token included', async () => {
    const s = await start()
    const body = JSON.stringify({ manage: false })
    for (const scope of ['inference', 'management'] as const) {
      const status = await s.remote('/api/apps/screenplayer', 'PUT', s.bearer(scope), body)
      expect([401, 403]).toContain(status)
    }
    expect(loadRegistry(registry).ollamaApps[0].manage).toBe(true)
  })

  it('an unknown path under /api/apps is 404 after the token check, and a method that is not GET or PUT too', async () => {
    const s = await start()
    expect((await fetch(`${s.desk}/api/apps/x/y`, { headers: s.bearer('inference') })).status).toBe(404)
    expect((await fetch(`${s.desk}/api/apps`, { method: 'DELETE', headers: s.bearer('management') })).status).toBe(404)
  })
})

describe('the page', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
  function extractFunction(src: string, name: string): string {
    const startAt = src.indexOf('function ' + name + '(')
    if (startAt < 0) throw new Error('function ' + name + ' not found in index.html')
    let depth = 0
    for (let i = src.indexOf('{', startAt); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startAt, i + 1) }
    }
    throw new Error('unbalanced braces for ' + name)
  }
  const appRowModel = new Function(`${extractFunction(html, 'appRowModel')}\nreturn appRowModel;`)() as (app: any, remote: boolean) => any

  it('a row says the name, how the app serves its model, what it holds now, and whether CynCo manages it', () => {
    const row = appRowModel({ id: 'dndai', name: 'dndai', serves: 'its own model server, started by bash.exe scripts/start-llm.sh', manage: true, holdsGpu: true, holding: 'port 8081 (pid 4242)', owed: false }, false)
    expect(row).toEqual({ name: 'dndai', serves: 'its own model server, started by bash.exe scripts/start-llm.sh', gpu: 'holds the GPU now: port 8081 (pid 4242)', managed: 'managed by CynCo', button: 'Stop managing' })
  })

  it('an app that is owed its server says so; one CynCo does not manage offers to manage it', () => {
    expect(appRowModel({ name: 'dndai', serves: 's', manage: true, holdsGpu: false, holding: null, owed: true }, false).gpu).toBe('stopped for CynCo; its server is started again when CynCo is done')
    expect(appRowModel({ name: 'x', serves: 's', manage: false, holdsGpu: false, holding: null, owed: false }, false)).toMatchObject({ gpu: 'not holding the GPU', managed: 'not managed', button: 'Manage' })
  })

  it('a remote page reads the same row with no switch', () => {
    expect(appRowModel({ name: 'x', serves: 's', manage: true, holdsGpu: false, holding: null, owed: false }, true).button).toBeNull()
  })

  it('the panel is in the page and the switch goes to PUT /api/apps/<id>', () => {
    expect(html).toContain('id="appsPanel"')
    expect(html).toMatch(/fetch\('\/api\/apps\/' \+ encodeURIComponent\(id\), \{ method: 'PUT'/)
  })
})
