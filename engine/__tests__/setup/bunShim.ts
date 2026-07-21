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
import { spawn as nodeSpawn } from 'child_process'
import { globSync } from 'fs'
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

function makeBunServe(options: BunWSServerOptions): BunServerLike {
  // Map from raw http.IncomingMessage to upgrade callback
  const pendingUpgrades = new Map<http.IncomingMessage, () => void>()

  const httpServer = http.createServer(async (req, res) => {
    // Build a minimal WHATWG Request for the fetch handler
    const url = `http://localhost:${options.port}${req.url ?? '/'}`
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v
      else if (Array.isArray(v)) headers[k] = v.join(', ')
    }

    let bodyChunks: Buffer[] = []
    await new Promise<void>(resolve => {
      req.on('data', (c: Buffer) => bodyChunks.push(c))
      req.on('end', resolve)
    })
    const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined

    const request = new Request(url, {
      method: req.method ?? 'GET',
      headers,
      body: body && body.length > 0 ? body : undefined,
    })

    // Provide upgrade function — marks this request for WS upgrade.
    // Like real Bun, upgrade() fails for plain HTTP requests; real WS
    // handshakes never reach this handler (ws handles the 'upgrade' event).
    let upgradeRequested = false
    const isWsUpgrade = (req.headers['upgrade'] ?? '').toLowerCase() === 'websocket'
    const serverLike: BunServerLike = {
      upgrade: (_req: Request) => {
        if (!isWsUpgrade) return false
        upgradeRequested = true
        return true
      },
      stop: () => { httpServer.close() },
    }

    const response = await options.fetch(request, serverLike)

    if (upgradeRequested) {
      // The WebSocketServer's upgrade listener will handle it
      return
    }

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

  const wss = new WebSocketServer({ server: httpServer })

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
  // exclusive: false → SO_REUSEADDR on Windows, allowing bind when prior
  // connections are in TIME_WAIT (common in rapid test re-runs).
  httpServer.listen({ port: options.port, host: bindHost, exclusive: false })

  // Expose the actual bound port (useful when port=0 for OS-assigned ephemeral ports).
  const getPort = () => (httpServer.address() as any)?.port ?? options.port

  return {
    hostname: bindHost,
    upgrade: () => false,
    stop: () => {
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

// Install global Bun shim if not already defined (i.e. running under vitest).
// Each property is added defensively so a partial pre-existing Bun global
// (e.g. another setup file) still gains the members it lacks.
{
  const target: any = (globalThis as any).Bun ?? ((globalThis as any).Bun = {})
  if (typeof target.serve === 'undefined') target.serve = makeBunServe
  if (typeof target.spawn === 'undefined') target.spawn = makeBunSpawn
  if (typeof target.Glob === 'undefined') target.Glob = GlobShim
  if (typeof target.YAML === 'undefined') target.YAML = bunYaml
}
