/**
 * CynCo Governance Dashboard Server — HTTP routes + WebSocket broadcast.
 *
 * Serves the dashboard UI, exposes REST endpoints for governance data,
 * and broadcasts engine events over WebSocket to connected dashboard clients.
 *
 * Uses Node.js http + ws for compatibility with both Bun runtime and
 * vitest test runner (Bun.serve is unavailable in vitest).
 *
 * This is Level 4 visibility: every governance parameter, prediction,
 * contract, and audit event is inspectable and tunable from a browser.
 */

import { join, dirname } from 'path'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { EngineEvent } from '../bridge/protocol.js'
import { setParam, GOVERNANCE_PARAMS, exportParamMetadata } from '../vsm/governanceParams.js'
import { globalContract } from '../tools/contract.js'

// ---------------------------------------------------------------------------
// DashboardDeps — optional callbacks into the engine
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  getGovernanceReport?: () => any
  getPredictionStats?: () => any
  getGovernance?: () => any
  getToolScorer?: () => any
  getS4Reflector?: () => any
  applyEngineConfig?: (patches: Record<string, unknown>) => { applied: Record<string, unknown>; errors: { field: string; message: string }[] }
  setToolRouting?: (enabled: boolean) => void
  getToolRouting?: () => boolean
}

// ---------------------------------------------------------------------------
// CORS headers applied to every response
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
  res.end(body)
}

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateNumber(value: unknown, min: number, max: number, field: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { ok: false, error: `${field} must be a number` }
  }
  if (value < min || value > max) {
    return { ok: false, error: `${field} must be between ${min} and ${max}` }
  }
  return { ok: true, value }
}

function validateBoolean(value: unknown, field: string): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof value !== 'boolean') {
    return { ok: false, error: `${field} must be a boolean` }
  }
  return { ok: true, value }
}

function validateInteger(value: unknown, min: number, max: number, field: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
    return { ok: false, error: `${field} must be an integer` }
  }
  if (value < min || value > max) {
    return { ok: false, error: `${field} must be between ${min} and ${max}` }
  }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Resolve this file's directory for serving index.html
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// DashboardServer
// ---------------------------------------------------------------------------

export class DashboardServer {
  private httpServer: ReturnType<typeof createServer>
  private wss: WebSocketServer
  private clients: Set<WebSocket> = new Set()
  private deps: DashboardDeps
  private _port: number

  constructor({ port = 9161, deps = {} }: { port?: number; deps?: DashboardDeps } = {}) {
    this.deps = deps
    this._port = port

    // Create HTTP server
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res)
    })

    // Create WebSocket server on /ws path
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' })
    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      ws.on('close', () => {
        this.clients.delete(ws)
      })
      // Read-only — ignore incoming messages
    })

    // Start listening (synchronous-ish via listen callback)
    this.httpServer.listen(port)
  }

  // ── Request Router ──────────────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const urlStr = req.url ?? '/'
    const method = req.method ?? 'GET'

    // Parse URL (handle relative URLs)
    let pathname: string
    try {
      const url = new URL(urlStr, `http://localhost:${this._port}`)
      pathname = url.pathname
    } catch {
      pathname = urlStr
    }

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    // GET routes
    if (method === 'GET') {
      switch (pathname) {
        case '/':
          return this.serveIndex(res)
        case '/api/governance':
          return this.getGovernance(res)
        case '/api/predictions':
          return this.getPredictions(res)
        case '/api/contracts':
          return this.getContracts(res)
        case '/api/params':
          return this.getParams(res)
        case '/api/history':
          return this.getHistory(res)
        default:
          return sendJson(res, { error: 'Not found' }, 404)
      }
    }

    // POST routes — need to read body
    if (method === 'POST') {
      let bodyChunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { bodyChunks.push(chunk) })
      req.on('end', () => {
        const raw = Buffer.concat(bodyChunks).toString('utf-8')
        let body: Record<string, unknown>
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return sendJson(res, { error: 'Invalid JSON body' }, 400)
        }

        switch (pathname) {
          case '/config/engine':
            return this.postConfigEngine(body, res)
          case '/config/governance':
            return this.postConfigGovernance(body, res)
          case '/config/tools':
            return this.postConfigTools(body, res)
          case '/config/system':
            return this.postConfigSystem(body, res)
          default:
            return sendJson(res, { error: 'Not found' }, 404)
        }
      })
      return
    }

    sendJson(res, { error: 'Method not allowed' }, 405)
  }

  // ── GET Handlers ────────────────────────────────────────────────

  private serveIndex(res: ServerResponse): void {
    try {
      const htmlPath = join(__dirname, 'index.html')
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf-8')
        return sendHtml(res, html)
      }
    } catch {}
    // Fallback when index.html doesn't exist yet (Task 7)
    sendHtml(res,
      '<!DOCTYPE html><html><head><title>CynCo Governance Dashboard</title></head>' +
      '<body><h1>CynCo Governance Dashboard</h1><p>Dashboard UI not yet built. Coming soon.</p></body></html>'
    )
  }

  private getGovernance(res: ServerResponse): void {
    const report = this.deps.getGovernanceReport?.() ?? null
    sendJson(res, report)
  }

  private getPredictions(res: ServerResponse): void {
    const stats = this.deps.getPredictionStats?.() ?? null
    sendJson(res, stats)
  }

  private getContracts(res: ServerResponse): void {
    if (globalContract.isActive()) {
      return sendJson(res, {
        active: true,
        status: globalContract.getStatus(),
        complete: globalContract.isComplete(),
        pending: globalContract.pendingCount(),
        failed: globalContract.failedCount(),
        enforcementEnabled: globalContract.isEnforcementEnabled(),
      })
    }
    sendJson(res, null)
  }

  private getParams(res: ServerResponse): void {
    sendJson(res, exportParamMetadata())
  }

  private getHistory(res: ServerResponse): void {
    try {
      const eventsPath = join(homedir(), '.cynco', 'audit-log', 'events.jsonl')
      if (!existsSync(eventsPath)) {
        return sendJson(res, [])
      }
      const content = readFileSync(eventsPath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.length > 0)
      // Return last 1000 entries
      const last1000 = lines.slice(-1000)
      const entries = last1000.map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      sendJson(res, entries)
    } catch {
      sendJson(res, [])
    }
  }

  // ── POST Handlers ───────────────────────────────────────────────

  private postConfigEngine(body: Record<string, unknown>, res: ServerResponse): void {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    const KNOWN_FIELDS = new Set(['temperature', 'contextLength', 'timeout', 'maxOutputTokens'])

    for (const [key, value] of Object.entries(body)) {
      if (!KNOWN_FIELDS.has(key)) {
        errors.push({ field: key, message: `Unknown engine config field: ${key}` })
        continue
      }

      switch (key) {
        case 'temperature': {
          const r = validateNumber(value, 0, 2, 'temperature')
          if (r.ok) applied[key] = r.value
          else errors.push({ field: key, message: r.error })
          break
        }
        case 'contextLength': {
          const r = validateNumber(value, 1024, 2097152, 'contextLength')
          if (r.ok) applied[key] = r.value
          else errors.push({ field: key, message: r.error })
          break
        }
        case 'timeout': {
          const r = validateNumber(value, 1000, 600000, 'timeout')
          if (r.ok) applied[key] = r.value
          else errors.push({ field: key, message: r.error })
          break
        }
        case 'maxOutputTokens': {
          const r = validateNumber(value, 1, 128000, 'maxOutputTokens')
          if (r.ok) applied[key] = r.value
          else errors.push({ field: key, message: r.error })
          break
        }
      }
    }

    // Apply validated patches via deps callback
    if (Object.keys(applied).length > 0 && this.deps.applyEngineConfig) {
      const result = this.deps.applyEngineConfig(applied)
      // Merge any additional errors from the engine
      errors.push(...result.errors)
      return sendJson(res, { applied: result.applied, errors })
    }

    sendJson(res, { applied, errors })
  }

  private postConfigGovernance(body: Record<string, unknown>, res: ServerResponse): void {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    for (const [key, value] of Object.entries(body)) {
      if (!GOVERNANCE_PARAMS.has(key)) {
        errors.push({ field: key, message: `Unknown governance parameter: ${key}` })
        continue
      }

      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push({ field: key, message: `${key} must be a number` })
        continue
      }

      const param = GOVERNANCE_PARAMS.get(key)!
      if (value < param.min || value > param.max) {
        errors.push({ field: key, message: `${key} must be between ${param.min} and ${param.max}` })
        continue
      }

      setParam(key, value, 'dashboard')
      applied[key] = value
    }

    sendJson(res, { applied, errors })
  }

  private postConfigTools(body: Record<string, unknown>, res: ServerResponse): void {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    const KNOWN_FIELDS = new Set(['trustDecayThreshold', 'toolRouting'])

    for (const [key, value] of Object.entries(body)) {
      if (!KNOWN_FIELDS.has(key)) {
        errors.push({ field: key, message: `Unknown tools config field: ${key}` })
        continue
      }

      switch (key) {
        case 'trustDecayThreshold': {
          const r = validateNumber(value, 0, 1, 'trustDecayThreshold')
          if (r.ok) {
            this.deps.getToolScorer?.()?.setDemotionThreshold?.(r.value)
            applied[key] = r.value
          } else {
            errors.push({ field: key, message: r.error })
          }
          break
        }
        case 'toolRouting': {
          const r = validateBoolean(value, 'toolRouting')
          if (r.ok) {
            this.deps.setToolRouting?.(r.value)
            applied[key] = r.value
          } else {
            errors.push({ field: key, message: r.error })
          }
          break
        }
      }
    }

    sendJson(res, { applied, errors })
  }

  private postConfigSystem(body: Record<string, unknown>, res: ServerResponse): void {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    const KNOWN_FIELDS = new Set(['ablation', 'contractEnforcement', 's4ReflectionFrequency'])

    for (const [key, value] of Object.entries(body)) {
      if (!KNOWN_FIELDS.has(key)) {
        errors.push({ field: key, message: `Unknown system config field: ${key}` })
        continue
      }

      switch (key) {
        case 'ablation': {
          const r = validateBoolean(value, 'ablation')
          if (r.ok) {
            const gov = this.deps.getGovernance?.()
            if (gov) {
              if (r.value) gov.pause?.()
              else gov.resume?.()
            }
            applied[key] = r.value
          } else {
            errors.push({ field: key, message: r.error })
          }
          break
        }
        case 'contractEnforcement': {
          const r = validateBoolean(value, 'contractEnforcement')
          if (r.ok) {
            globalContract.setEnforcementEnabled(r.value)
            applied[key] = r.value
          } else {
            errors.push({ field: key, message: r.error })
          }
          break
        }
        case 's4ReflectionFrequency': {
          const r = validateInteger(value, 1, 20, 's4ReflectionFrequency')
          if (r.ok) {
            this.deps.getS4Reflector?.()?.setFrequency?.(r.value)
            applied[key] = r.value
          } else {
            errors.push({ field: key, message: r.error })
          }
          break
        }
      }
    }

    sendJson(res, { applied, errors })
  }

  // ── WebSocket Broadcast ─────────────────────────────────────────

  broadcast(event: EngineEvent): void {
    if (this.clients.size === 0) return
    const json = JSON.stringify(event)
    for (const ws of this.clients) {
      try { ws.send(json) } catch {}
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  stop(): void {
    this.wss.close()
    this.httpServer.close()
  }

  getPort(): number {
    return this._port
  }
}
