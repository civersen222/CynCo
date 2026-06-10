/**
 * CynCo Governance Dashboard Server — HTTP routes + WebSocket broadcast.
 *
 * Serves the dashboard UI, exposes REST endpoints for governance data,
 * and broadcasts engine events over WebSocket to connected dashboard clients.
 *
 * Uses Bun.serve() with native WebSocket support — matching the pattern
 * used in engine/bridge/server.ts.
 *
 * This is Level 4 visibility: every governance parameter, prediction,
 * contract, and audit event is inspectable and tunable from a browser.
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import type { Server, ServerWebSocket } from 'bun'
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
  getSessionInfo?: () => { model: string; contextLength: number; tier?: string } | null
  applyEngineConfig?: (patches: Record<string, unknown>) => { applied: Record<string, unknown>; errors: { field: string; message: string }[] }
  setToolRouting?: (enabled: boolean) => void
  getToolRouting?: () => boolean
  onCommand?: (command: any) => void
}

// ---------------------------------------------------------------------------
// CORS headers applied to every response
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  })
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
// DashboardServer
// ---------------------------------------------------------------------------

export class DashboardServer {
  private server: Server
  private clients: Set<ServerWebSocket<unknown>> = new Set()
  private deps: DashboardDeps
  private _port: number
  private _hostname: string
  private indexHtml: string

  constructor({ port = 9161, deps = {} }: { port?: number; deps?: DashboardDeps } = {}) {
    this.deps = deps
    this._port = port
    this._hostname = process.env.LOCALCODE_DASHBOARD_HOST || '127.0.0.1'

    // Read index.html once at startup
    const __dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
    const htmlPath = join(__dir, 'index.html')
    if (existsSync(htmlPath)) {
      this.indexHtml = readFileSync(htmlPath, 'utf-8')
    } else {
      this.indexHtml =
        '<!DOCTYPE html><html><head><title>CynCo Governance Dashboard</title></head>' +
        '<body><h1>CynCo Governance Dashboard</h1><p>Dashboard UI not yet built. Coming soon.</p></body></html>'
    }

    this.server = Bun.serve({
      port,
      hostname: this._hostname,
      fetch: async (req, server) => {
        const url = new URL(req.url)
        const pathname = url.pathname
        const method = req.method

        // WebSocket upgrade at /ws
        if (pathname === '/ws') {
          const success = server.upgrade(req)
          if (success) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // Handle CORS preflight
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS })
        }

        // GET routes
        if (method === 'GET') {
          switch (pathname) {
            case '/':
              return this.serveIndex()
            case '/api/governance':
              return this.getGovernance()
            case '/api/predictions':
              return this.getPredictions()
            case '/api/contracts':
              return this.getContracts()
            case '/api/params':
              return this.getParams()
            case '/api/history':
              return this.getHistory()
            case '/api/sessions':
              return this.getSessions()
            case '/api/session':
              return jsonResponse(this.deps.getSessionInfo?.() ?? null)
            case '/api/subsystems': {
              const recorder = (() => { try { return require('../training/trajectoryRecorder.js').getTrajectoryRecorder() } catch { return null } })()
              return jsonResponse({
                grammar: {
                  enabled: process.env.LOCALCODE_GRAMMAR_ENABLED !== 'false',
                  provider: 'llama-cpp',
                },
                bestOfN: {
                  enabled: process.env.LOCALCODE_BEST_OF_N === 'true',
                  count: parseInt(process.env.LOCALCODE_BEST_OF_N_COUNT ?? '2', 10),
                  turnCap: parseInt(process.env.LOCALCODE_BEST_OF_N_TURN_CAP ?? '15', 10),
                },
                trajectory: {
                  enabled: process.env.LOCALCODE_TRAJECTORY_ENABLED !== 'false',
                  activeTaskId: recorder?.taskId ?? null,
                },
                varietyControl: {
                  enabled: process.env.LOCALCODE_VARIETY_CONTROL !== 'false',
                },
              })
            }
            case '/api/training': {
              try {
                const { loadTrajectories } = require('../training/datasetBuilder.js')
                const { homedir } = require('os')
                const { join } = require('path')
                const { readdirSync, readFileSync, existsSync } = require('fs')
                const trajDir = join(homedir(), '.cynco', 'trajectories')
                const rewDir = join(homedir(), '.cynco', 'rewards')
                const dsDir = join(homedir(), '.cynco', 'datasets')
                const trajFiles = existsSync(trajDir) ? readdirSync(trajDir).filter((f: string) => f.endsWith('.jsonl')).length : 0
                const rewFiles = existsSync(rewDir) ? readdirSync(rewDir).filter((f: string) => f.endsWith('.json')).length : 0
                let totalTurns = 0
                if (existsSync(trajDir)) {
                  for (const f of readdirSync(trajDir).filter((f: string) => f.endsWith('.jsonl'))) {
                    totalTurns += readFileSync(join(trajDir, f), 'utf-8').trim().split('\n').length
                  }
                }
                let sftExamples = 0
                const sftPath = join(dsDir, 'sft.jsonl')
                if (existsSync(sftPath)) {
                  sftExamples = readFileSync(sftPath, 'utf-8').trim().split('\n').length
                }
                const readyForSFT = sftExamples >= 300
                const targetExamples = 300
                return jsonResponse({
                  tasks: trajFiles,
                  turns: totalTurns,
                  rewards: rewFiles,
                  sftExamples,
                  targetExamples,
                  readyForSFT,
                  progress: Math.min(1, sftExamples / targetExamples),
                })
              } catch {
                return jsonResponse({ tasks: 0, turns: 0, rewards: 0, sftExamples: 0, targetExamples: 300, readyForSFT: false, progress: 0 })
              }
            }
            default: {
              // Handle parameterized routes
              if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/measurements')) {
                const sid = pathname.replace('/api/sessions/', '').replace('/measurements', '')
                return this.getSessionMeasurements(sid)
              }
              if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/transcript')) {
                const sid = pathname.replace('/api/sessions/', '').replace('/transcript', '')
                return this.getSessionTranscript(sid)
              }
              return jsonResponse({ error: 'Not found' }, 404)
            }
          }
        }

        // POST routes
        if (method === 'POST') {
          let body: Record<string, unknown>
          try {
            body = await req.json() as Record<string, unknown>
          } catch {
            return jsonResponse({ error: 'Invalid JSON body' }, 400)
          }

          switch (pathname) {
            case '/config/engine':
              return this.postConfigEngine(body)
            case '/config/governance':
              return this.postConfigGovernance(body)
            case '/config/tools':
              return this.postConfigTools(body)
            case '/config/system':
              return this.postConfigSystem(body)
            default:
              return jsonResponse({ error: 'Not found' }, 404)
          }
        }

        return jsonResponse({ error: 'Method not allowed' }, 405)
      },
      websocket: {
        open: (ws: ServerWebSocket<unknown>) => {
          this.clients.add(ws)
        },
        message: (_ws: ServerWebSocket<unknown>, message: string | Buffer) => {
          // Forward commands from dashboard chat to engine
          if (this.deps.onCommand) {
            try {
              const text = typeof message === 'string' ? message : message.toString()
              const parsed = JSON.parse(text)
              if (parsed && parsed.type) {
                console.log(`[dashboard] Forwarding command: ${parsed.type}`)
                this.deps.onCommand(parsed)
              }
            } catch {}
          }
        },
        close: (ws: ServerWebSocket<unknown>) => {
          this.clients.delete(ws)
        },
      },
    })
  }

  // ── GET Handlers ────────────────────────────────────────────────

  private serveIndex(): Response {
    return htmlResponse(this.indexHtml)
  }

  private getGovernance(): Response {
    const report = this.deps.getGovernanceReport?.() ?? null
    return jsonResponse(report)
  }

  private getPredictions(): Response {
    const stats = this.deps.getPredictionStats?.() ?? null
    return jsonResponse(stats)
  }

  private getContracts(): Response {
    if (globalContract.isActive()) {
      return jsonResponse({
        active: true,
        status: globalContract.getStatus(),
        complete: globalContract.isComplete(),
        pending: globalContract.pendingCount(),
        failed: globalContract.failedCount(),
        enforcementEnabled: globalContract.isEnforcementEnabled(),
      })
    }
    return jsonResponse(null)
  }

  private getParams(): Response {
    return jsonResponse(exportParamMetadata())
  }

  private getHistory(): Response {
    try {
      const eventsPath = join(homedir(), '.cynco', 'audit-log', 'events.jsonl')
      if (!existsSync(eventsPath)) {
        return jsonResponse([])
      }
      const content = readFileSync(eventsPath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.length > 0)
      // Return last 1000 entries
      const last1000 = lines.slice(-1000)
      const entries = last1000.map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      return jsonResponse(entries)
    } catch {
      return jsonResponse([])
    }
  }

  private getSessions(): Response {
    try {
      const gov = this.deps.getGovernance?.() as any
      const db = gov?.getGovernanceDb?.()
      if (!db) return jsonResponse([])
      const sessions = db.getRecentSessions(50)
      return jsonResponse(sessions)
    } catch {
      return jsonResponse([])
    }
  }

  private getSessionMeasurements(sessionId: string): Response {
    try {
      const gov = this.deps.getGovernance?.() as any
      const db = gov?.getGovernanceDb?.()
      if (!db) return jsonResponse([])
      const measurements = db.getMeasurements(sessionId)
      return jsonResponse(measurements)
    } catch {
      return jsonResponse([])
    }
  }

  private getSessionTranscript(sessionId: string): Response {
    try {
      const sessionDir = join(homedir(), '.cynco', 'sessions')
      const sessionFile = join(sessionDir, `${sessionId}.jsonl`)
      if (!existsSync(sessionFile)) return jsonResponse([])
      const lines = readFileSync(sessionFile, 'utf-8').trim().split('\n')
      const entries = lines.slice(-500).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      return jsonResponse(entries)
    } catch {
      return jsonResponse([])
    }
  }

  // ── POST Handlers ───────────────────────────────────────────────

  private postConfigEngine(body: Record<string, unknown>): Response {
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
      return jsonResponse({ applied: result.applied, errors })
    }

    return jsonResponse({ applied, errors })
  }

  private postConfigGovernance(body: Record<string, unknown>): Response {
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

    return jsonResponse({ applied, errors })
  }

  private postConfigTools(body: Record<string, unknown>): Response {
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

    return jsonResponse({ applied, errors })
  }

  private postConfigSystem(body: Record<string, unknown>): Response {
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

    return jsonResponse({ applied, errors })
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
    this.server.stop()
  }

  getPort(): number {
    return this._port
  }

  getHostname(): string {
    return this._hostname
  }
}
