/**
 * Bun.serve shim for vitest.
 *
 * Provides a minimal implementation of Bun.serve() using Node's http module
 * and the `ws` package, so tests that create DashboardServer / LocalCodeWSServer
 * can run under vitest without the Bun runtime.
 *
 * Only the subset of the API used in production code is implemented.
 */

import * as http from 'http'
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'child_process'
import { globSync, writeFileSync } from 'fs'
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws'
import { parse as parseYamlLib } from 'yaml'

interface BunWSServerOptions {
  port: number
  hostname?: string
  fetch: (req: Request, server: BunServerLike) => Promise<Response | undefined> | Response | undefined
  websocket?: {
    open?: (ws: BunWS) => void
    message?: (ws: BunWS, message: string | Buffer) => void
    close?: (ws: BunWS) => void
  }
}

interface BunServerLike {
  upgrade: (req: Request, extra?: any) => boolean
  stop: (force?: boolean) => void
  hostname?: string
  readonly port: number
}

interface BunWS {
  send: (data: string) => void
  close: () => void
  data: unknown
}

/**
 * Ports this shim currently holds.
 *
 * Real `Bun.serve` throws synchronously when the port is taken, which is what
 * production code catches in order to walk to the next free port. Node's
 * `httpServer.listen()` fails asynchronously on an 'error' event instead, so
 * under the shim that same conflict escaped as an uncaught EADDRINUSE and the
 * walk was untestable — the shim could not express the failure it stands in
 * for. Tracking our own bindings reproduces Bun's contract for the case that
 * matters here: two servers asking for one port inside one process.
 */
const boundPorts = new Set<number>()

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required',
}

function makeBunServe(options: BunWSServerOptions): BunServerLike {
  /** Rebuild a WHATWG Request from a raw Node request (headers only if no body). */
  function toRequest(req: http.IncomingMessage, body?: Buffer): Request {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v
      else if (Array.isArray(v)) headers[k] = v.join(', ')
    }
    return new Request(`http://localhost:${options.port}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers,
      body: body && body.length > 0 ? body : undefined,
    })
  }

  const httpServer = http.createServer(async (req, res) => {
    let bodyChunks: Buffer[] = []
    await new Promise<void>(resolve => {
      req.on('data', (c: Buffer) => bodyChunks.push(c))
      req.on('end', resolve)
    })
    const request = toRequest(req, bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined)

    // upgrade() fails for plain HTTP, as in real Bun. WebSocket handshakes do
    // not arrive here at all — Node routes them to the 'upgrade' event below.
    const serverLike: BunServerLike = {
      upgrade: (_req: Request) => false,
      stop: () => { httpServer.close() },
    }

    const response = await options.fetch(request, serverLike)

    if (response == null) {
      res.writeHead(200)
      res.end()
      return
    }

    // Stream headers
    const respHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => { respHeaders[k] = v })
    res.writeHead(response.status, respHeaders)

    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  })

  // `{ server: httpServer }` would make ws answer the handshake itself, and the
  // fetch handler would never see it. Production code does its authorization in
  // fetch, before calling server.upgrade — under that wiring every one of those
  // checks was unreachable from the test suite, so the WS bridge could have been
  // wide open and nothing here would have gone red. noServer + our own listener
  // reproduces Bun's order: fetch first, upgrade only if it asked for one.
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    let upgradeRequested = false
    const serverLike: BunServerLike = {
      upgrade: (_req: Request) => { upgradeRequested = true; return true },
      stop: () => { httpServer.close() },
    }

    let response: Response | undefined
    try {
      response = await options.fetch(toRequest(req), serverLike)
    } catch {
      upgradeRequested = false
      response = new Response('handler error', { status: 500 })
    }

    if (upgradeRequested) {
      wss.handleUpgrade(req, socket as any, head, ws => wss.emit('connection', ws, req))
      return
    }

    // Refused. Answer the handshake with the real status so the client can tell
    // 401 from 403 from 409 — `ws` surfaces this as 'unexpected-response'.
    const status = response?.status ?? 426
    const body = response ? await response.text() : 'WebSocket upgrade required'
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      `Connection: close\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
    socket.destroy()
  })

  wss.on('connection', (ws: WsWebSocket) => {
    const bunWs: BunWS = {
      send: (data: string) => ws.send(data),
      close: () => ws.close(),
      data: undefined,
    }

    options.websocket?.open?.(bunWs)

    ws.on('message', (data: Buffer | string) => {
      options.websocket?.message?.(bunWs, data as string | Buffer)
    })

    ws.on('close', () => {
      options.websocket?.close?.(bunWs)
    })
  })

  const bindHost = options.hostname ?? '0.0.0.0'
  // Match Bun: a taken port is a synchronous throw, not a later 'error' event.
  // Port 0 means "OS, pick one" and is never a conflict.
  if (options.port !== 0 && boundPorts.has(options.port)) {
    throw new Error(`Failed to start server. Is port ${options.port} in use?`)
  }
  // exclusive: false → SO_REUSEADDR on Windows, allowing bind when prior
  // connections are in TIME_WAIT (common in rapid test re-runs).
  httpServer.listen({ port: options.port, host: bindHost, exclusive: false })
  if (options.port !== 0) boundPorts.add(options.port)
  // A squatter outside this process still fails asynchronously. Surface it as a
  // console line rather than an uncaught exception that fails an unrelated test.
  httpServer.on('error', (err) => {
    if (options.port !== 0) boundPorts.delete(options.port)
    console.log(`[bunShim] listen failed on ${bindHost}:${options.port}: ${err}`)
  })

  // Expose the actual bound port (useful when port=0 for OS-assigned ephemeral ports).
  const getPort = () => (httpServer.address() as any)?.port ?? options.port

  return {
    hostname: bindHost,
    upgrade: () => false,
    stop: () => {
      if (options.port !== 0) boundPorts.delete(options.port)
      wss.close()
      httpServer.close()
    },
    get port() { return getPort() },
  }
}

/** Minimal Bun.spawn shim for vitest: spawns a real child process. */
function makeBunSpawn(
  cmd: string[],
  options: { cwd?: string; stdout?: string; stderr?: string }
) {
  let exitResolve: (code: number) => void
  const exitedPromise = new Promise<number>(resolve => { exitResolve = resolve })

  const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }

  const child = nodeSpawn(cmd[0], cmd.slice(1), {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })

  child.stdout?.on('data', (d: Buffer) => chunks.stdout.push(d))
  child.stderr?.on('data', (d: Buffer) => chunks.stderr.push(d))
  child.on('close', (code: number | null) => exitResolve!(code ?? 0))
  child.on('error', () => exitResolve!(1))

  const makeStream = (bufs: Buffer[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Data may not have arrived yet — resolve after process exits
        exitedPromise.then(() => {
          const data = Buffer.concat(bufs)
          if (data.length > 0) controller.enqueue(data)
          controller.close()
        })
      },
    })

  return {
    get stdout() { return makeStream(chunks.stdout) },
    get stderr() { return makeStream(chunks.stderr) },
    get exitCode() { return child.exitCode },
    exited: exitedPromise,
  }
}

/**
 * Minimal Bun.Glob shim for vitest, backed by Node's fs.globSync.
 * Production code uses `new Bun.Glob(pattern).scan({ cwd, absolute })`.
 * Bun yields forward-slash paths; fs.globSync yields native separators on
 * Windows, so we normalize to forward slashes to match Bun's behavior.
 */
class GlobShim {
  constructor(private readonly pattern: string) {}

  async *scan(opts: { cwd?: string; absolute?: boolean } = {}): AsyncGenerator<string> {
    const cwd = opts.cwd ?? process.cwd()
    const matches = globSync(this.pattern, { cwd }) as string[]
    for (const m of matches) {
      const rel = m.split('\\').join('/')
      yield opts.absolute ? `${cwd.split('\\').join('/')}/${rel}` : rel
    }
  }
}

const bunYaml = { parse: (input: string) => parseYamlLib(input) }

/**
 * Minimal Bun.spawnSync shim: the subset the dashboard mission tests use
 * (`Bun.spawnSync(['git', ...], { env, cwd })` then `.stdout.toString()`).
 * Under vitest those two tests failed on every run with "Bun.spawnSync is not
 * a function" -- a test that cannot run is a test that never fails, and these
 * are the ones proving /api/mission counts commits from the mission repo
 * rather than the engine's own.
 */
function makeBunSpawnSync(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  const r = nodeSpawnSync(cmd[0], cmd.slice(1), {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv | undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })
  const exitCode = r.status ?? 1
  return {
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
    exitCode,
    success: exitCode === 0,
    pid: r.pid,
  }
}

/** Minimal Bun.write shim: string/Buffer to a path, resolving to bytes written. */
async function makeBunWrite(dest: string, data: string | Uint8Array): Promise<number> {
  writeFileSync(dest, data)
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

// Install global Bun shim if not already defined (i.e. running under vitest).
// Each property is added defensively so a partial pre-existing Bun global
// (e.g. another setup file) still gains the members it lacks.
{
  const target: any = (globalThis as any).Bun ?? ((globalThis as any).Bun = {})
  if (typeof target.serve === 'undefined') target.serve = makeBunServe
  if (typeof target.spawn === 'undefined') target.spawn = makeBunSpawn
  if (typeof target.spawnSync === 'undefined') target.spawnSync = makeBunSpawnSync
  if (typeof target.write === 'undefined') target.write = makeBunWrite
  if (typeof target.Glob === 'undefined') target.Glob = GlobShim
  if (typeof target.YAML === 'undefined') target.YAML = bunYaml
}
