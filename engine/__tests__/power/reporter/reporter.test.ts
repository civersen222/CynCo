/**
 * The box reporter: its sources (each may fail), the sample, the bounded
 * outbox and the loop. Every server here is a stand-in on 127.0.0.1 on a port
 * the OS chooses; nothing reaches the live engine, model port or embed service.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { daemonHasWork, getJson, holderReader, modelRows, readBusyClaim, readDaemonUp, readEngine, readInferenceToken, readModelPort, readServices, type FetchLike } from '../../../power/reporter/engineFacts.js'
import { ticksBetween } from '../../../power/reporter/idle.js'
import { Outbox } from '../../../power/reporter/outbox.js'
import { fingerprint, gatherSample, type Sources } from '../../../power/reporter/sample.js'
import { cached, createReporter, main, watcherUrl, GAP_MS, LOOK_MS, type ReporterState } from '../../../power/reporter/main.js'
import type { EngineRow, Sample, WatchEvent, WatchRecord } from '../../../power/reporter/types.js'
import type { PortTree } from '../../../apps/portTree.js'
import type { LocalApp } from '../../../apps/registry.js'

const realFetch: FetchLike = (url, init) => fetch(url, init)
const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise(r => s.close(() => r(null))) })

type Route = (req: { url: string; auth: string; body: string }) => { status?: number; json?: unknown } | undefined
async function standIn(route: Route): Promise<string> {
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const got = route({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body }) ?? { status: 404, json: { error: 'not found' } }
      res.writeHead(got.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(got.json ?? {}))
    })
  })
  servers.push(srv)
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
}
/** An address nothing listens on: a server that was opened and closed again. */
async function deadAddress(): Promise<string> {
  const url = await standIn(() => ({}))
  await new Promise(r => servers.pop()!.close(() => r(null)))
  return url
}

const NOW = Date.parse('2026-11-12T03:00:00Z')

describe('the engine, read from its dashboard', () => {
  it('reads the model state, whether a turn runs, and what the engine has open', async () => {
    const url = await standIn(r => r.url === '/api/session' && r.auth === 'Bearer s3' ? { json: { modelState: 'warm', processing: true, activity: [{ kind: 'turn', since: NOW - 42_000 }, { kind: 'request', label: 'complete', since: NOW - 3_000 }, { junk: 1 }] } } : { status: 401 })
    expect(await readEngine(realFetch, url, 's3', NOW)).toEqual({ up: true, modelState: 'warm', processing: true, open: [{ kind: 'turn', sinceS: 42 }, { kind: 'request', label: 'complete', sinceS: 3 }] })
  })

  it('an engine that does not report its activity yet gives open: null, not an empty list', async () => {
    const url = await standIn(() => ({ json: { modelState: 'cold', processing: false } }))
    expect(await readEngine(realFetch, url, 's3', NOW)).toEqual({ up: true, modelState: 'cold', processing: false, open: null })
  })

  it('a refused token, or no token, still says the dashboard is up; nothing listening says it is not', async () => {
    const refusing = await standIn(r => r.url === '/manifest.webmanifest' ? { json: {} } : { status: 401 })
    expect(await readEngine(realFetch, refusing, 'wrong', NOW)).toEqual({ up: true, modelState: null, processing: null, open: null })
    expect(await readEngine(realFetch, refusing, null, NOW)).toEqual({ up: true, modelState: null, processing: null, open: null })
    expect(await readEngine(realFetch, await deadAddress(), 's3', NOW)).toEqual({ up: false, modelState: null, processing: null, open: null })
  })

  it('getJson gives up after its time and says no answer', async () => {
    const never: FetchLike = (_u, init) => new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
    expect(await getJson(never, 'http://127.0.0.1:1/x', 30)).toEqual({ ok: false, status: 0, body: null })
  })
})

describe('the inference token is read and never written', () => {
  it('finds the shared secret, skips a paired device, and a missing or broken file is null with nothing created', () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-tok-'))
    expect(readInferenceToken(home)).toBeNull()
    expect(existsSync(join(home, 'tokens.json'))).toBe(false)
    const file = join(home, 'tokens.json')
    writeFileSync(file, JSON.stringify({ version: 1, tokens: [
      { name: 'device-1a2b3c4d', scopes: ['inference'], secret: 'phone' },
      { name: 'bridge', scopes: ['bridge'], secret: 'b' },
      { name: 'dashboard', scopes: ['inference'], secret: 'shared' },
    ] }))
    const before = statSync(file).mtimeMs
    expect(readInferenceToken(home)).toBe('shared')
    expect(statSync(file).mtimeMs).toBe(before)
    writeFileSync(file, '{torn')
    expect(readInferenceToken(home)).toBeNull()
    expect(readFileSync(file, 'utf-8')).toBe('{torn')
  })
})

describe('the model port', () => {
  it('names the model and says whether a slot is working', async () => {
    const url = await standIn(r => r.url === '/health' ? { json: { status: 'ok' } }
      : r.url === '/props' ? { json: { model_path: 'C:\\Users\\x\\.cynco\\models\\q\\Qwen3.8-27B-NVFP4.gguf' } }
      : r.url === '/slots' ? { json: [{ id: 0, is_processing: false }, { id: 1, is_processing: true }] } : undefined)
    expect(await readModelPort(realFetch, Number(new URL(url).port))).toEqual({ up: true, name: 'Qwen3.8-27B-NVFP4.gguf', busy: true })
  })

  it('a server that does not show its slots is loaded with use unknown; one still loading is there; none is down', async () => {
    const noSlots = await standIn(r => r.url === '/health' ? { json: {} } : r.url === '/props' ? { json: {} } : { status: 501 })
    expect(await readModelPort(realFetch, Number(new URL(noSlots).port))).toEqual({ up: true, name: null, busy: null })
    const loading = await standIn(() => ({ status: 503, json: { error: 'loading model' } }))
    expect((await readModelPort(realFetch, Number(new URL(loading).port))).up).toBe(true)
    expect(await readModelPort(realFetch, Number(new URL(await deadAddress()).port))).toEqual({ up: false, name: null, busy: null })
  })

  it('model rows: use comes from the slots, else from the engine own open work, and a one-shot is use', () => {
    const eng = (open: EngineRow['open'], processing = false): EngineRow => ({ up: true, modelState: 'warm', processing, open })
    const m = { up: true, name: 'q.gguf', busy: null }
    expect(modelRows(8081, { ...m, busy: false }, { unit: 'engine', detail: '' }, eng([{ kind: 'turn', sinceS: 1 }]), [])).toEqual([{ server: 'llama:8081', name: 'q.gguf', busy: false }])
    expect(modelRows(8081, m, { unit: 'engine', detail: '' }, eng([]), [])![0]!.busy).toBe(false)
    expect(modelRows(8081, m, { unit: 'engine', detail: '' }, eng([{ kind: 'request', sinceS: 1 }]), [])![0]!.busy).toBe(true)
    expect(modelRows(8081, m, { unit: 'engine', detail: '' }, eng(null), [])![0]!.busy).toBeNull()
    expect(modelRows(8081, m, { unit: 'app:dndai', detail: '' }, eng([]), [])![0]!.busy).toBeNull()
    expect(modelRows(8081, m, { unit: 'oneshot:digest', detail: '' }, null, [])![0]!.busy).toBe(true)
    expect(modelRows(8081, { up: false, name: null, busy: null }, null, null, [{ server: 'ollama', name: 'qwen3:14b', busy: null }])).toEqual([{ server: 'ollama', name: 'qwen3:14b', busy: null }])
    expect(modelRows(8081, null, null, null, [])).toBeNull()
  })
})

describe('the services something depends on', () => {
  const up: EngineRow = { up: true, modelState: 'cold', processing: false, open: [] }

  it('embeddings are wanted while the engine is up, the daemon while there is a mission', async () => {
    const embed = await standIn(r => r.url === '/health' ? { json: { status: 'ok' } } : undefined)
    const got = await readServices(up, { fetchImpl: realFetch, embedUrl: embed, daemonUp: async () => false, daemonHasWork: () => true })
    expect(got).toEqual([
      { name: 'dashboard', up: true, wanted: true, by: 'the phone and the desk page' },
      { name: 'embed', up: true, wanted: true, by: 'the engine (code and project search)' },
      { name: 'daemon', up: false, wanted: true, by: 'the scheduled jobs' },
    ])
  })

  it('embeddings down with the engine down is not wanted; a daemon that cannot be read is left out', async () => {
    const dead = await deadAddress()
    const got = await readServices({ ...up, up: false }, { fetchImpl: realFetch, embedUrl: dead, daemonUp: async () => null, daemonHasWork: () => true })
    expect(got).toEqual([
      { name: 'dashboard', up: false, wanted: true, by: 'the phone and the desk page' },
      { name: 'embed', up: false, wanted: false, by: 'the engine (code and project search)' },
    ])
    expect((await readServices(null, { fetchImpl: realFetch, embedUrl: dead, daemonUp: async () => true, daemonHasWork: () => false })).map(s => [s.name, s.wanted])).toEqual([['embed', false], ['daemon', false]])
  })

  it('the daemon is found by its command line, and an unreadable process list is null', async () => {
    const procs = [{ pid: 1, ppid: 0, exe: 'bun.exe', commandLine: 'bun engine\\main.ts' }, { pid: 2, ppid: 0, exe: 'bun.exe', commandLine: 'bun C:\\Users\\x\\localcode\\engine\\daemon\\main.ts' }]
    expect(await readDaemonUp(async () => procs)).toBe(true)
    expect(await readDaemonUp(async () => procs.slice(0, 1))).toBe(false)
    expect(await readDaemonUp(async () => { throw new Error('cim') })).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'cynco-m-'))
    expect(daemonHasWork(dir)).toBe(false)
    expect(daemonHasWork(join(dir, 'none'))).toBe(false)
  })
})

describe('who holds the GPU, by CynCo own reckoning', () => {
  const proc = (pid: number, name: string, commandLine = ''): PortTree['listener'] => ({ pid, name, commandLine, exe: '', createdAt: 0 } as unknown as PortTree['listener'])
  const engineTree: PortTree = { listener: proc(10, 'llama-server.exe'), ancestors: [proc(9, 'bun.exe', 'bun engine/main.ts')] }
  const appTree: PortTree = { listener: proc(20, 'llama-server.exe'), ancestors: [proc(19, 'bash.exe', 'bash scripts/start-llm.sh')] }
  const dndai = { id: 'dndai', name: 'dndai', root: 'C:/Users/x/dndai', script: 'scripts/start-llm.sh', manage: true } as unknown as LocalApp

  it('a one-shot wins; nothing on the port is none; a bun parent is the engine; a registered launcher is the app; else not CynCo', async () => {
    let busy: { triggerId: string; task: string } | null = { triggerId: 'digest-bronze-card', task: 'fantasy-digest' }
    let tree: PortTree | null = engineTree
    const read = holderReader(8081, { readBusy: () => busy, readTree: async () => tree, apps: () => [dndai], trustMs: 0 })
    expect(await read(true)).toEqual({ unit: 'oneshot:digest-bronze-card', detail: "the daemon's one-shot fantasy-digest" })
    busy = null
    expect((await read(false)).unit).toBe('none')
    expect((await read(true)).unit).toBe('engine')
    tree = appTree
    expect(await read(true)).toMatchObject({ unit: 'app:dndai' })
    tree = { listener: proc(30, 'llama-server.exe'), ancestors: [proc(29, 'cmd.exe', 'cmd /c other.cmd')] }
    expect((await read(true)).unit).toBe('foreign')
    tree = null
    expect((await read(true)).unit).toBe('unknown')
  })

  it('the one-shot claim is read and left alone: a claim whose process is gone is no claim, and the file is not deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-busy-'))
    const file = join(dir, 'gpu-busy.json')
    expect(readBusyClaim(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ task: 'fantasy-digest', triggerId: 'digest-bronze-card', startedAt: '2026-11-12T03:00:00Z', timeoutMs: 900000, pid: 4242 }))
    expect(readBusyClaim(file, () => true)).toEqual({ triggerId: 'digest-bronze-card', task: 'fantasy-digest' })
    expect(readBusyClaim(file, () => false)).toBeNull()
    expect(existsSync(file)).toBe(true) // the engine's reader would have removed it; an observer does not
    writeFileSync(file, '{torn')
    expect(readBusyClaim(file, () => true)).toBeNull()
  })

  it('one reading of the owner is trusted while the port stays up, and asked again after it went down or could not be read', async () => {
    let reads = 0
    let tree: PortTree | null = engineTree
    let t = 0
    const read = holderReader(8081, { readBusy: () => null, readTree: async () => { reads++; return tree }, apps: () => [], now: () => t, trustMs: 300_000 })
    await read(true); await read(true); t = 200_000; await read(true)
    expect(reads).toBe(1)
    t = 400_000; await read(true)
    expect(reads).toBe(2)
    await read(false); await read(true)
    expect(reads).toBe(3)
    tree = null; t = 800_000; await read(true); await read(true)
    expect(reads).toBe(5)
  })
})

function sources(over: Partial<Sources> = {}): Sources {
  return {
    idleS: async () => 12.4,
    gpus: async () => [{ i: 0, name: 'RTX 5090', tempC: 39, memUsedMib: 100, memTotalMib: 32607, utilPct: 0, procs: [] }],
    engine: async () => ({ up: true, modelState: 'cold', processing: false, open: [] }),
    modelPort: async () => ({ up: false, name: null, busy: null }),
    holder: async () => ({ unit: 'none', detail: '' }),
    services: async () => [{ name: 'embed', up: true, wanted: true, by: 'the engine' }],
    ollama: async () => [],
    ...over,
  }
}

describe('a sample', () => {
  it('a source that throws, and one that never answers, leave null and the sample still goes out', async () => {
    const said: string[] = []
    const s = await gatherSample(sources({
      gpus: async () => { throw new Error('nvidia-smi not found') },
      engine: () => new Promise(() => {}),
      idleS: async () => null,
    }), new Date(NOW), { modelPort: 8081, timeoutMs: 40, log: l => said.push(l) })
    expect(s).toMatchObject({ t: 'sample', at: '2026-11-12T03:00:00.000Z', idleS: null, gpus: null, engine: null, holder: { unit: 'none' } })
    expect(s.services).toHaveLength(1)
    expect(said.join('\n')).toContain('the GPUs could not be read: nvidia-smi not found')
    expect(said.join('\n')).toContain('the engine could not be read: no answer in 40 ms')
  })

  it('the fingerprint moves when a service goes down or a model loads, and not with temperature or idle time', async () => {
    const at = new Date(NOW)
    const a = await gatherSample(sources(), at, { modelPort: 8081 })
    const warmer = await gatherSample(sources({ idleS: async () => 900, gpus: async () => [{ i: 0, name: 'RTX 5090', tempC: 71, memUsedMib: 30000, memTotalMib: 32607, utilPct: 99, procs: ['x.exe'] }] }), at, { modelPort: 8081 })
    const down = await gatherSample(sources({ services: async () => [{ name: 'embed', up: false, wanted: true, by: 'the engine' }] }), at, { modelPort: 8081 })
    const loaded = await gatherSample(sources({ modelPort: async () => ({ up: true, name: 'q.gguf', busy: false }), holder: async () => ({ unit: 'engine', detail: '' }) }), at, { modelPort: 8081 })
    expect(fingerprint(warmer)).toBe(fingerprint(a))
    expect(fingerprint(down)).not.toBe(fingerprint(a))
    expect(fingerprint(loaded)).not.toBe(fingerprint(a))
    expect(a.idleS).toBe(12)
  })
})

const ev = (n: number): WatchEvent => ({ t: 'event', at: new Date(NOW + n * 1000).toISOString(), kind: 'job.run', key: `k${n}`, data: { n } })

describe('the outbox', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'cynco-out-')), 'outbox.jsonl')

  it('delivers to the watcher as one push body, and a healthy send leaves nothing on disk', async () => {
    const got: Array<{ v: number; box: string; records: WatchRecord[] }> = []
    const url = await standIn(r => { if (r.url === '/push') { got.push(JSON.parse(r.body)); return { json: { ok: true } } } return undefined })
    const f = file()
    const out = new Outbox({ url: url + '/', box: 'main', file: f, log: () => {} })
    out.add([ev(1), ev(2)])
    expect(await out.flush()).toBe('sent')
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ v: 1, box: 'main' })
    expect(got[0]!.records.map(r => (r as WatchEvent).key)).toEqual(['k1', 'k2'])
    expect(out.size()).toBe(0)
    expect(existsSync(f)).toBe(false)
    expect(await out.flush()).toBe('empty')
  })

  it('keeps what was not delivered, in order, across a restart, and sends it when the watcher is back', async () => {
    const f = file()
    const dead = await deadAddress()
    const said: string[] = []
    const out = new Outbox({ url: dead, box: 'main', file: f, log: l => said.push(l), timeoutMs: 500 })
    out.add([ev(1)])
    expect(await out.flush()).toBe('failed')
    out.add([ev(2)])
    expect(await out.flush()).toBe('failed')
    expect(said.join('\n')).toContain('2 record(s) kept for the next try')
    expect(readFileSync(f, 'utf-8').trim().split('\n')).toHaveLength(2)

    const got: string[] = []
    const url = await standIn(r => { got.push(...(JSON.parse(r.body).records as WatchEvent[]).map(x => x.key)); return { json: { ok: true } } })
    const again = new Outbox({ url, box: 'main', file: f, log: () => {} }) // a new process, same file
    expect(again.size()).toBe(2)
    again.add([ev(3)])
    expect(await again.flush()).toBe('sent')
    expect(got).toEqual(['k1', 'k2', 'k3'])
    expect(existsSync(f)).toBe(false)
  })

  it('is bounded: beyond max the oldest go, and how many were lost is itself reported', async () => {
    const got: WatchEvent[] = []
    let up = false
    const url = await standIn(r => { if (!up) return { status: 503 }; got.push(...(JSON.parse(r.body).records as WatchEvent[])); return { json: { ok: true } } })
    const out = new Outbox({ url, box: 'main', file: file(), max: 5, batch: 10, log: () => {}, now: () => new Date(NOW) })
    for (let i = 1; i <= 8; i++) out.add([ev(i)])
    expect(out.size()).toBe(5)
    expect(await out.flush()).toBe('failed')
    up = true
    expect(await out.flush()).toBe('sent')
    expect(got.filter(e => e.kind === 'job.run').map(e => e.key)).toEqual(['k5', 'k6', 'k7', 'k8'])
    const dropped = got.find(e => e.kind === 'reporter.dropped')!
    expect(dropped.data.n).toBe(3)
  })

  it('sends a backlog in batches, a batch the watcher calls bad is not sent again, and a wrong address loses nothing', async () => {
    const sizes: number[] = []
    const url = await standIn(r => { sizes.push(JSON.parse(r.body).records.length); return { json: { ok: true } } })
    const out = new Outbox({ url, box: 'main', file: file(), batch: 3, log: () => {} })
    out.add([1, 2, 3, 4, 5, 6, 7].map(ev))
    while ((await out.flush()) === 'sent' && out.size() > 0) { /* drain */ }
    expect(sizes).toEqual([3, 3, 1])

    const refusing = await standIn(() => ({ status: 400, json: { error: 'bad box name' } }))
    const bad = new Outbox({ url: refusing, box: 'main', file: file(), log: () => {} })
    bad.add([ev(1)])
    expect(await bad.flush()).toBe('failed')
    expect(bad.size()).toBe(0)

    const wrong = await standIn(() => ({ status: 404 }))
    const kept = new Outbox({ url: wrong, box: 'main', file: file(), log: () => {} })
    kept.add([ev(1)])
    expect(await kept.flush()).toBe('failed')
    expect(kept.size()).toBe(1)
  })

  it('a torn last line in the backlog file is skipped', () => {
    const f = file()
    writeFileSync(f, JSON.stringify(ev(1)) + '\n{"t":"event","at":"2026')
    expect(new Outbox({ url: 'http://127.0.0.1:1', box: 'main', file: f, log: () => {} }).size()).toBe(1)
  })
})

describe('the loop', () => {
  function rig(over: { sources?: Partial<Sources>; power?: () => Array<{ id: number; provider: string; at: string; data: Record<string, string> }> | null } = {}) {
    const added: WatchRecord[] = []
    const powerAsked: string[] = []
    let t = NOW
    const state: ReporterState = {}
    const saved: ReporterState[] = []
    const lines: string[][] = []
    const reporter = createReporter({
      sources: sources(over.sources),
      outbox: { add: r => { added.push(...r) }, flush: async () => 'empty' as const, size: () => 0 },
      readPower: async since => { powerAsked.push(since); return over.power ? over.power() : [] },
      engineLog: () => lines.shift() ?? [],
      jobs: () => [],
      state,
      saveState: s => saved.push({ ...s }),
      modelPort: 8081,
      now: () => new Date(t),
      log: () => {},
    })
    return { reporter, added, powerAsked, state, saved, lines, advance: (ms: number) => { t += ms }, samples: () => added.filter(r => r.t === 'sample') as Sample[], events: () => added.filter(r => r.t === 'event') as WatchEvent[] }
  }

  it('the first look says it started, reads three days of the System log and sends a sample', async () => {
    const r = rig()
    await r.reporter.tick()
    expect(r.events().map(e => e.kind)).toEqual(['reporter.start'])
    expect(r.powerAsked).toEqual(['2026-11-09T03:00:00.000Z'])
    expect(r.samples()).toHaveLength(1)
    expect(r.saved[r.saved.length - 1]).toMatchObject({ powerSince: '2026-11-09T03:00:00.000Z' })
  })

  it('pushes a sample on change at the next look and otherwise once a minute', async () => {
    let embedUp = true
    const r = rig({ sources: { services: async () => [{ name: 'embed', up: embedUp, wanted: true, by: 'the engine' }] } })
    await r.reporter.tick()
    r.advance(LOOK_MS); await r.reporter.tick()
    r.advance(LOOK_MS); await r.reporter.tick()
    expect(r.samples()).toHaveLength(1)
    embedUp = false
    r.advance(LOOK_MS); await r.reporter.tick()
    expect(r.samples()).toHaveLength(2)
    expect(r.samples()[1]!.services[0]!.up).toBe(false)
    r.advance(LOOK_MS); await r.reporter.tick()
    expect(r.samples()).toHaveLength(2)
    for (let i = 0; i < 4; i++) { r.advance(LOOK_MS); await r.reporter.tick() }
    expect(r.samples()).toHaveLength(3)
  })

  it('a look that comes minutes late reads the System log at once, and the sleep it finds is told once', async () => {
    const woke = [{ id: 1, provider: 'Microsoft-Windows-Power-Troubleshooter', at: '2026-11-12T03:20:01.000Z', data: { SleepTime: '2026-11-12T03:00:40.0000000Z', WakeTime: '2026-11-12T03:20:00.0000000Z', WakeSourceType: '1', WakeSourceText: '' } }]
    let rows: typeof woke = []
    const r = rig({ power: () => rows })
    await r.reporter.tick()
    r.advance(LOOK_MS); await r.reporter.tick()
    expect(r.powerAsked).toHaveLength(1)
    rows = woke
    r.advance(LOOK_MS + GAP_MS + 1000); await r.reporter.tick()
    expect(r.powerAsked).toHaveLength(2)
    expect(r.events().filter(e => e.kind.startsWith('power.')).map(e => e.key)).toEqual(['sleep:2026-11-12T03:00:40Z', 'wake:2026-11-12T03:20:00Z'])
    expect(r.state.powerSince).toBe('2026-11-12T03:18:01.000Z')
    r.advance(11 * 60_000); await r.reporter.tick() // the ten-minute read sees the same row again
    expect(r.events().filter(e => e.kind.startsWith('power.'))).toHaveLength(2)
  })

  it('a System log that cannot be read is asked for again at the next look, with the same window', async () => {
    let fail = true
    const r = rig({ power: () => fail ? null : [] })
    await r.reporter.tick()
    r.advance(LOOK_MS); await r.reporter.tick()
    expect(r.powerAsked).toEqual(['2026-11-09T03:00:00.000Z', '2026-11-09T03:00:00.000Z'])
    fail = false
    r.advance(LOOK_MS); await r.reporter.tick()
    r.advance(LOOK_MS); await r.reporter.tick()
    expect(r.powerAsked).toHaveLength(3)
  })

  it('the engine log lines it reads become events stamped with the look', async () => {
    const r = rig()
    r.lines.push(['[embed] No embedding endpoint answered at http://127.0.0.1:9165 (Unable to connect.)'])
    await r.reporter.tick()
    expect(r.events().find(e => e.kind === 'service.said_down')).toMatchObject({ at: '2026-11-12T03:00:00.000Z', data: { service: 'embed' } })
  })
})

describe('switches and small things', () => {
  it('with no watcher address the reporter says it is off and exits 0 without gathering anything', async () => {
    const said: string[] = []
    expect(await main([], {}, l => said.push(l))).toBe(0)
    expect(said).toEqual(['[watch] off: LOCALCODE_WATCHER_URL is not set, so nothing is gathered and nothing is sent'])
    expect(watcherUrl({ LOCALCODE_WATCHER_URL: '  ' })).toBeUndefined()
    expect(watcherUrl({ LOCALCODE_WATCHER_URL: 'http://100.110.117.10:9171' })).toBe('http://100.110.117.10:9171')
  })

  it('a box name that is not a plain name is refused before anything is created', async () => {
    const said: string[] = []
    expect(await main(['--box', '<b>x</b>'], { LOCALCODE_WATCHER_URL: 'http://127.0.0.1:1' }, l => said.push(l))).toBe(2)
    expect(said[0]).toContain('not a box name')
  })

  it('cached keeps an answer for its time', async () => {
    let n = 0, t = 0
    const c = cached(async () => ++n, 1000, () => t)
    expect([await c(), await c()]).toEqual([1, 1])
    t = 1500
    expect(await c()).toBe(2)
  })

  it('tick counts wrap at 32 bits', () => {
    expect(ticksBetween(5000, 2000)).toBe(3000)
    expect(ticksBetween(100, 0xffffff00)).toBe(356)
  })

  it('nothing that finds or kills "the engine" by its command line can take the reporter for it', () => {
    // The F215 class: a selector written when only one thing was started that way. These are the
    // patterns of dispatch-mission.sh and cynco-mission-driver.mjs (a -like on engine/main.ts),
    // cynco-widget.ps1 and cynco-services.ps1 (the engine and daemon rows).
    const launch = readFileSync(join(process.cwd(), 'scripts', 'run-box-reporter.cmd'), 'utf-8')
    const commandLine = launch.split(/\r?\n/).find(l => l.startsWith('bun '))!.split(' >>')[0]!
    expect(commandLine).toBe('bun engine\\power\\reporter\\main.ts')
    expect(commandLine.includes('engine/main.ts')).toBe(false)
    expect(/engine[\\/]main\.ts/.test(commandLine)).toBe(false)
    expect(/engine\\main\.ts(?!.*--run-task)/.test(commandLine)).toBe(false)
    expect(/engine\\daemon\\main/.test(commandLine)).toBe(false)
    // and the services script finds it by its own row
    const services = readFileSync(join(process.cwd(), 'scripts', 'cynco-services.ps1'), 'utf-8')
    const row = /Name = 'watch';[^\n]*Match = '([^']+)'/.exec(services)
    expect(row).not.toBeNull()
    expect(new RegExp(row![1]!).test(commandLine)).toBe(true)
    expect(services).toContain("scripts\\run-box-reporter.cmd")
  })

  it('the engine session answer carries what the engine has open (the first caller of activity.snapshot)', () => {
    const src = readFileSync(join(process.cwd(), 'engine', 'main.ts'), 'utf-8')
    const start = src.indexOf('getSessionInfo: () => {')
    const body = src.slice(start, src.indexOf('applyEngineConfig', start))
    expect(start).toBeGreaterThan(0)
    expect(body).toContain('activity: activity.snapshot()')
  })
})
