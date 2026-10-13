/**
 * A ComfyUI stand-in on a real `node:http` server (port 0), faithful to the
 * routes and shapes engine/imagegen uses: /system_stats, /models/checkpoints,
 * /object_info/<class> ({} for a class it lacks), POST /prompt (a canonical
 * uuid prompt_id is honoured; 400 with node_errors on request), /history/<id>
 * ({} while pending, then an entry with outputs and timestamped
 * status.messages), /view (PNG bytes, or an oversized / non-PNG body),
 * POST /interrupt and POST /queue. Every request lands in `calls`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** A real 1×1 PNG. */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export const BUILTIN_CLASSES = ['CLIPTextEncode', 'CheckpointLoaderSimple', 'EmptyLatentImage', 'KSampler', 'SaveImage', 'VAEDecode']

export type MockMode = {
  /** /system_stats: a ComfyUI answer, an HTTP 404, or a 200 that is not ComfyUI's. */
  stats: 'ok' | '404' | 'not-comfy'
  checkpoints: string[]
  /** Node classes /object_info knows. */
  nodes: string[]
  /** /history answers {} this many times per prompt before the entry. */
  pendingPolls: number
  /** /history never has an entry. */
  neverFinish: boolean
  /** POST /prompt answers 400 with this body. */
  refuse: unknown | null
  /** The finished entry reports an execution_error / an interruption. */
  executionError: { node_id: string; node_type: string; exception_message: string; exception_type?: string } | null
  interrupted: boolean
  /** The entry's outputs name this file (and subfolder) instead of cynco/<prefix>_00001_.png. */
  filename: string | null
  subfolder: string | null
  /** The entry has no image outputs. */
  noOutputs: boolean
  /** /view: the PNG, a body with Content-Length over the cap, the same without Content-Length, or a non-PNG. */
  view: 'png' | 'oversized-cl' | 'oversized-chunked' | 'not-png'
  oversizedBytes: number
  /** Answer /prompt with a server-made id, as an older ComfyUI does. */
  ignoreClientId: boolean
  /** Delay every answer to this path prefix, ms. */
  delay: Record<string, number>
}

export type MockCall = { method: string; path: string; query: Record<string, string>; body: unknown }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MockComfy = {
  url: string
  port: number
  mode: MockMode
  calls: MockCall[]
  /** The prompt texts (node "6".inputs.text) in POST order. */
  prompts: string[]
  /** The most prompts ever submitted and not yet finished at once. */
  maxInFlight: number
  close(): Promise<void>
}

export async function startMockComfy(overrides: Partial<MockMode> = {}): Promise<MockComfy> {
  const mode: MockMode = {
    stats: 'ok', checkpoints: ['juggernautXL_v9.safetensors', 'sd15.safetensors'], nodes: [...BUILTIN_CLASSES],
    pendingPolls: 1, neverFinish: false, refuse: null, executionError: null, interrupted: false,
    filename: null, subfolder: null, noOutputs: false, view: 'png', oversizedBytes: 4096, ignoreClientId: false, delay: {},
    ...overrides,
  }
  const calls: MockCall[] = []
  const prompts: string[] = []
  const polls = new Map<string, number>()
  const pending = new Map<string, { prefix: string; startedAt: number }>()
  const finished = new Set<string>()
  const mock: MockComfy = { url: '', port: 0, mode, calls, prompts, maxInFlight: 0, close: async () => {} }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req: IncomingMessage) => new Promise<unknown>(resolve => {
    const parts: Buffer[] = []
    req.on('data', c => parts.push(c))
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8')
      try { resolve(text ? JSON.parse(text) : null) } catch (e) { resolve({ unparsed: text, error: String(e) }) }
    })
  })

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://mock')
    const body = req.method === 'POST' ? await readBody(req) : null
    calls.push({ method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body })
    const delay = Object.entries(mode.delay).find(([p]) => u.pathname.startsWith(p))?.[1]
    if (delay) await new Promise(r => setTimeout(r, delay))

    if (u.pathname === '/system_stats') {
      if (mode.stats === '404') return json(res, 404, { error: 'not found' })
      if (mode.stats === 'not-comfy') return json(res, 200, { hello: 'world' })
      return json(res, 200, {
        system: { os: 'nt', comfyui_version: '0.3.60', python_version: '3.12', pytorch_version: '2.7.0', embedded_python: true, argv: ['main.py', '--listen'] },
        devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4070 Ti SUPER : cudaMallocAsync', type: 'cuda', index: 0, vram_total: 17171480576, vram_free: 15000000000 }],
      })
    }
    if (u.pathname === '/models/checkpoints') return json(res, 200, mode.checkpoints)
    if (u.pathname.startsWith('/object_info/')) {
      const cls = decodeURIComponent(u.pathname.slice('/object_info/'.length))
      return json(res, 200, mode.nodes.includes(cls) ? { [cls]: { input: {}, output: ['IMAGE'], name: cls } } : {})
    }
    if (u.pathname === '/prompt' && req.method === 'POST') {
      const b = body as { prompt?: Record<string, { class_type: string; inputs: Record<string, unknown> }>; prompt_id?: unknown; client_id?: unknown }
      if (mode.refuse) return json(res, 400, mode.refuse)
      const id = !mode.ignoreClientId && typeof b?.prompt_id === 'string' && UUID_RE.test(b.prompt_id) ? b.prompt_id : randomUUID()
      const save = Object.values(b?.prompt ?? {}).find(n => n.class_type === 'SaveImage')
      const text = Object.values(b?.prompt ?? {}).find(n => n.class_type === 'CLIPTextEncode')?.inputs.text
      prompts.push(typeof text === 'string' ? text : '')
      pending.set(id, { prefix: String(save?.inputs.filename_prefix ?? 'ComfyUI'), startedAt: Date.now() })
      mock.maxInFlight = Math.max(mock.maxInFlight, pending.size)
      return json(res, 200, { prompt_id: id, number: prompts.length, node_errors: {} })
    }
    if (u.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(u.pathname.slice('/history/'.length))
      const job = pending.get(id)
      if (!job || mode.neverFinish) return json(res, 200, {})
      const n = (polls.get(id) ?? 0) + 1
      polls.set(id, n)
      if (n <= mode.pendingPolls) return json(res, 200, {})
      pending.delete(id)
      finished.add(id)
      const t0 = job.startedAt, t1 = Date.now()
      const messages: unknown[] = [['execution_start', { prompt_id: id, timestamp: t0 }], ['execution_cached', { nodes: [], prompt_id: id, timestamp: t0 }]]
      let status_str = 'success'
      if (mode.executionError) {
        status_str = 'error'
        messages.push(['execution_error', { prompt_id: id, ...mode.executionError, exception_type: mode.executionError.exception_type ?? 'RuntimeError', traceback: [], current_inputs: {}, current_outputs: {}, timestamp: t1 }])
      } else if (mode.interrupted) {
        status_str = 'error'
        messages.push(['execution_interrupted', { prompt_id: id, node_id: '3', node_type: 'KSampler', executed: [], timestamp: t1 }])
      } else {
        messages.push(['execution_success', { prompt_id: id, timestamp: t0 + 1234 }])
      }
      const filename = mode.filename ?? `${job.prefix.split('/').pop()}_00001_.png`
      const subfolder = mode.subfolder ?? (job.prefix.includes('/') ? job.prefix.split('/')[0] : '')
      const outputs = mode.noOutputs || status_str === 'error' ? {} : { '9': { images: [{ filename, subfolder, type: 'output' }] } }
      return json(res, 200, { [id]: { prompt: [], outputs, status: { status_str, completed: status_str === 'success', messages }, meta: {} } })
    }
    if (u.pathname === '/view') {
      if (mode.view === 'not-png') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>nope</html>') }
      if (mode.view === 'oversized-cl') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(mode.oversizedBytes) })
        return res.end(Buffer.concat([PNG_1X1, Buffer.alloc(mode.oversizedBytes - PNG_1X1.length)]))
      }
      if (mode.view === 'oversized-chunked') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.write(PNG_1X1)
        for (let sent = PNG_1X1.length; sent < mode.oversizedBytes; sent += 1024) res.write(Buffer.alloc(1024))
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG_1X1.length) })
      return res.end(PNG_1X1)
    }
    if (u.pathname === '/interrupt' && req.method === 'POST') {
      const id = (body as { prompt_id?: string } | null)?.prompt_id
      if (id) { pending.delete(id) }
      return json(res, 200, {})
    }
    if (u.pathname === '/queue' && req.method === 'POST') {
      for (const id of ((body as { delete?: string[] } | null)?.delete ?? [])) pending.delete(id)
      return json(res, 200, {})
    }
    return json(res, 404, { error: `no route ${u.pathname}` })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  mock.port = port
  mock.url = `http://127.0.0.1:${port}`
  mock.close = () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
  return mock
}

/** A port nothing listens on: bound once, then closed. */
export async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>(resolve => s.close(() => resolve()))
  return port
}

/** Wait until `cond()` holds, polling every 10 ms; throws with `what` after `ms`. */
export async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** A file symlink needs a privilege on Windows; a directory junction does not. */
export function canSymlinkFiles(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'cynco-imagegen-link-'))
  try {
    writeFileSync(join(d, 'a'), '')
    symlinkSync(join(d, 'a'), join(d, 'b'))
    return true
  } catch (e) {
    console.log(`file symlinks need privileges here: ${(e as Error).message}`)
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

/** A hard link needs the two names on one filesystem, and some filesystems have none. */
export function canHardLinkFiles(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'cynco-imagegen-hardlink-'))
  try {
    writeFileSync(join(d, 'a'), '')
    linkSync(join(d, 'a'), join(d, 'b'))
    return true
  } catch (e) {
    console.log(`hard links are not possible here: ${(e as Error).message}`)
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}
