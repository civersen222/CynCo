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
import { validateCommand } from '../bridge/commandSchema.js'
import { setParam, GOVERNANCE_PARAMS, exportParamMetadata } from '../vsm/governanceParams.js'
import { globalContract } from '../tools/contract.js'
import { ThinkingRecorder } from '../memory/thinkingRecorder.js'
import {
  loadTrajectories,
  summarizeCorpus,
  evaluateReadiness,
  GATE_MIN_USABLE,
} from '../training/datasetBuilder.js'
import type { TokenSet, TokenScope } from '../security/localToken.js'

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
  /** Override sessions directory for tests (defaults to ~/.cynco/sessions) */
  sessionsDir?: string
  /** Brain Tier 3: switch the activations consumer's readout layer */
  setBrainLayer?: (layer: number) => void
}

// ---------------------------------------------------------------------------
// What a browser may ask the engine to do
// ---------------------------------------------------------------------------
//
// The dashboard's `/ws` is gated at scope `inference` — the READ scope. It has
// to be: a browser cannot set headers on a WebSocket handshake, and the token
// is injected into the page's own HTML by the one ungated route, so it is the
// secret most likely to escape. That socket then landed on `handleCommand`, the
// same privileged entry point the header-authenticated TUI bridge uses, with no
// re-check of any kind. Two frames were enough:
//
//   {"type":"command","command":"/approve-all"}   → loop.setApproveAll(true)
//   {"type":"user.message","text":"..."}          → the agent runs
//
// `approvalGate` short-circuits on that flag (`if (approveAll) return true`),
// and `Bash`'s `tier: 'approval'` is the ONLY thing standing in front of an
// unsandboxed `exec()` with the full inherited environment — `bashSafety.ts`
// says of itself that it is a heuristic warning and not a sandbox. So the read
// token was an arbitrary-shell-command token.
//
// Raising the socket to `management` is not the fix: the Chat tab is a shipped
// feature and needs `user.message`. The boundary is where the restriction
// belongs, so the allowlist lives here — and it is an ALLOWlist, so a slash
// command added later is refused until someone puts it on this list on purpose
// rather than inheriting the browser's reach by default.

/**
 * Frame types a dashboard socket may send.
 *
 * All of them drive the agent or answer it; none of them change what the agent
 * is allowed to do. That is the line: `user.message` and the `vibe.*` family
 * start work and still face every approval prompt, whereas `/approve-all`
 * removes the prompts. The Chat tab and the Vibe tab both live on this side.
 */
const DASHBOARD_ALLOWED_TYPES: ReadonlySet<unknown> = new Set([
  'user.message',
  'abort',
  'approval.response',
  'ask.answer',
  'command',
  'vibe.start',
  'vibe.answer',
  'vibe.action',
  'vibe.escalation_response',
])

/**
 * Slash commands a dashboard socket may send.
 *
 * Every entry is either read-only (`/tools`, `/spend`, `/context`, `/s5`,
 * `/governance`) or a canned `user.message` / workflow selection the Chat tab
 * itself issues (`/git`, `/diff`, and the workflow verbs the page's own input
 * handler forwards) — none of which grant more than `user.message` already
 * does, and `user.message` is the feature.
 *
 * Absent, deliberately: `/approve-all` (the finding above), `/skill` (installs
 * and deletes on disk), `/quit` and `/exit` (kill the engine), `/model`
 * (rewrites live config), `/reset` (clears the governance kill switch), `/undo`
 * (rewrites the working tree), `/compact` (destroys conversation history),
 * `/commit` (writes git history), `/export`, `/analyze` and the `/audit-*`
 * family (start and stamp audit records).
 */
const DASHBOARD_ALLOWED_SLASH: ReadonlySet<unknown> = new Set([
  // read-only reports
  '/tools', '/spend', '/context', '/s5', '/governance',
  // canned prompts — no more privileged than typing the same sentence
  '/git', '/diff',
  // workflow selection, which constrains the agent rather than freeing it
  '/tdd', '/debug', '/review', '/plan', '/brainstorm', '/critique', '/research', '/cancel',
])

/**
 * Null when a dashboard socket may forward `frame` to the engine, otherwise the
 * reason to log and refuse on.
 *
 * Exported and pure so it is specified on its own terms: this is the whole of
 * the boundary, and a boundary only reachable through a live WebSocket is a
 * boundary nothing can cheaply prove.
 *
 * Two questions in order, and they are different questions. First: may a
 * browser send this KIND of frame — the allowlists below, which are about
 * authority. Then: is this frame the SHAPE that kind is declared to have —
 * `validateCommand`, the same check the bridge entrance runs. Authority first
 * because a well-formed `/approve-all` is exactly the frame finding #1 was
 * about, and it must be refused for what it is, not for how it is spelled.
 */
export function dashboardCommandRefusal(frame: unknown): string | null {
  if (typeof frame !== 'object' || frame === null) return 'frame is not an object'
  const { type, command } = frame as { type?: unknown; command?: unknown }
  // Both sets are typed over `unknown` on purpose. Set membership does not
  // coerce, so a number, an array, or an object with a flattering `toString`
  // is simply not a member — which means this one check answers both "is it a
  // string" and "is it a permitted one". A `typeof` guard in front of it would
  // be a second mechanism for a single rule, and the mechanism that never gets
  // to answer is the one no test can ever observe failing.
  if (!DASHBOARD_ALLOWED_TYPES.has(type)) {
    return `frame type ${JSON.stringify(type) ?? String(type)} is not allowed from the dashboard`
  }
  if (type === 'command' && !DASHBOARD_ALLOWED_SLASH.has(command)) {
    return `slash command ${JSON.stringify(command) ?? String(command)} is not allowed from the dashboard`
  }
  const shape = validateCommand(frame)
  return shape.ok ? null : shape.reason
}

// ---------------------------------------------------------------------------
// No CORS grant
// ---------------------------------------------------------------------------
//
// Every response used to carry `Access-Control-Allow-Origin: *`. That header is
// precisely the grant that lets a cross-origin page READ a reply, and the replies
// here include /api/sessions/<id>/transcript — the raw session journal, so every
// file the Read tool pulled in, every diff, every Bash output — plus /api/thinking,
// which is the model's reasoning. Any page open in any browser on this machine
// could chain /api/thinking/sessions into the transcript route and exfiltrate the
// lot on a page load. Binding to loopback does not help; the browser is already
// inside loopback.
//
// The dashboard page is served from this origin, so it needs no grant at all.
// Absent beats narrow: there is no legitimate cross-origin reader to name.
//
// This does NOT protect the POST /config/* routes, and it never did. An attacker
// sends Content-Type: text/plain to make the request "simple" (no preflight), the
// request lands, and req.json() parses the body regardless of the declared type.
// The response is unreadable but the mutation already happened. Only a token or
// an Origin check stops that; the management-scope gate below is what does it.

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// ---------------------------------------------------------------------------
// Session-id validation (no path separators, no shell-special chars)
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[\w.-]+$/

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
  /** Last broadcast per replayable type, resent to late-joining clients.
   *  brain.tier fires once at engine startup — browsers always connect later. */
  private readonly replayCache = new Map<string, string>()
  private static readonly REPLAY_TYPES = new Set(['brain.tier'])
  private deps: DashboardDeps
  private _port: number
  private _hostname: string
  private indexHtml: string
  /**
   * Required, and deliberately not optional-with-a-default. A missing token
   * store must be a compile error at the call site, never a dashboard that
   * quietly starts up serving transcripts to anyone who asks.
   */
  private tokens: TokenSet

  constructor({ port = 9161, deps = {}, tokens }: { port?: number; deps?: DashboardDeps; tokens: TokenSet }) {
    this.deps = deps
    this.tokens = tokens
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
      // Note: after Bun.serve() this.server.port reflects the actual bound port
      // (important when port=0 is used for OS-assigned ephemeral ports in tests).
      fetch: async (req, server) => {
        const url = new URL(req.url)
        const pathname = url.pathname
        const method = req.method

        // WebSocket upgrade at /ws. The stream carries the same conversation
        // content as the transcript route, so it takes the same scope — but a
        // browser cannot set headers on a WebSocket handshake, which is why this
        // one route reads the token from the query string. Refused before
        // server.upgrade: an accepted-then-closed socket has already run `open`.
        if (pathname === '/ws') {
          const denied = this.requireScope(req, 'inference', { allowQueryToken: true })
          if (denied) return denied
          const success = server.upgrade(req)
          if (success) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // A preflight with no Access-Control-* headers in the reply is a refusal:
        // the browser fails the CORS check and never sends the real request. The
        // dashboard page is same-origin and never preflights.
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204 })
        }

        // GET / is the one ungated route: it is how the inference token reaches
        // the page, so it cannot itself require one. With no ACAO on the reply a
        // cross-origin page cannot read what it delivers — that is what makes
        // this safe, and why the CORS removal had to come first.
        if (method === 'GET' && pathname === '/') {
          return this.serveIndex()
        }

        // Everything else is gated, including unknown paths: a 404 that answers
        // before the token check turns the route table into public information.
        const scope: TokenScope = method === 'GET' ? 'inference' : 'management'
        const denied = this.requireScope(req, scope)
        if (denied) return denied

        // GET routes
        if (method === 'GET') {
          switch (pathname) {
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
                  // Opt-in, matching callModel.ts (grammar is default-off until
                  // the stream translator handles server-side parsed output)
                  enabled: process.env.LOCALCODE_GRAMMAR_ENABLED === 'true',
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
                const trajDir = join(homedir(), '.cynco', 'trajectories')
                const rewDir = join(homedir(), '.cynco', 'rewards')

                // loadSnapshots: false — this endpoint is polled and a snapshot
                // runs to 2 MB. Eligibility only needs the file to exist.
                const trajectories = loadTrajectories(trajDir, rewDir, { loadSnapshots: false })
                const stats = summarizeCorpus(trajectories)
                const readiness = evaluateReadiness(stats)
                const totalTurns = trajectories.reduce((sum, t) => sum + t.turns.length, 0)

                return jsonResponse({
                  tasks: stats.totalTasks,
                  turns: totalTurns,
                  rewards: stats.tasksWithRewards,
                  usableExamples: stats.usableExamples,
                  negativeExamples: stats.negativeExamples,
                  legacyExcluded: stats.legacyExcluded,
                  // null, not 0, when nothing was averaged — a client must not
                  // be able to render an unmeasured corpus as "0.000".
                  avgReward: stats.usableExamples > 0 ? stats.avgReward : null,
                  targetExamples: GATE_MIN_USABLE,
                  readyForSFT: readiness.ready,
                  conditions: readiness.conditions,
                  progress: Math.min(1, stats.usableExamples / GATE_MIN_USABLE),
                })
              } catch (e) {
                // Counts are null, not 0. A corpus that could not be read must
                // not render identically to an empty one — "0 usable examples"
                // would be a measurement nobody took.
                return jsonResponse({
                  error: e instanceof Error ? e.message : String(e),
                  tasks: null, turns: null, rewards: null, usableExamples: null,
                  negativeExamples: null, legacyExcluded: null, avgReward: null,
                  targetExamples: GATE_MIN_USABLE,
                  readyForSFT: false, conditions: [], progress: null,
                })
              }
            }
            case '/api/thinking/sessions': {
              return jsonResponse(ThinkingRecorder.listSessions(this.deps.sessionsDir))
            }
            case '/api/thinking/turns': {
              const sid = url.searchParams.get('session') ?? ''
              return this.getThinkingTurns(sid)
            }
            case '/api/thinking': {
              const sid = url.searchParams.get('session') ?? ''
              const turnStr = url.searchParams.get('turn') ?? ''
              const turnNum = Number(turnStr)
              if (!SESSION_ID_RE.test(sid)) return jsonResponse({ error: 'invalid session id' }, 400)
              if (!turnStr || Number.isNaN(turnNum)) return jsonResponse({ error: 'invalid turn' }, 400)
              return this.getThinkingTurn(sid, turnNum)
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
            case '/api/brain/layer': {
              const layer = body.layer
              if (typeof layer !== 'number' || !Number.isInteger(layer) || layer < 0 || layer > 200) {
                return jsonResponse({ error: 'invalid layer' }, 400)
              }
              if (!this.deps.setBrainLayer) return jsonResponse({ error: 'no consumer' }, 503)
              this.deps.setBrainLayer(layer)
              return jsonResponse({ ok: true })
            }
            default:
              return jsonResponse({ error: 'Not found' }, 404)
          }
        }

        return jsonResponse({ error: 'Method not allowed' }, 405)
      },
      websocket: {
        open: (ws: ServerWebSocket<unknown>) => {
          this.clients.add(ws)
          for (const json of this.replayCache.values()) {
            try { ws.send(json) } catch (err) { console.log('[dashboard] replay send failed:', err) }
          }
        },
        message: (ws: ServerWebSocket<unknown>, message: string | Buffer) => {
          // Forward commands from dashboard chat to engine — but only the ones
          // a read-scoped browser is allowed to send. See
          // DASHBOARD_ALLOWED_SLASH above for why this list exists.
          if (!this.deps.onCommand) return
          // Answer the sender, not just this process's stdout. F32: the bridge
          // had the same shape and it cost thirteen minutes of a mission that
          // was never accepted — a client cannot tell "refused" from "still
          // thinking" unless the refusal is on the wire it is already reading.
          const refuse = (reason: string) => {
            console.warn(`[dashboard] REFUSED command frame: ${reason}`)
            try {
              ws.send(JSON.stringify({ type: 'session.error', error: `command frame refused: ${reason}` }))
            } catch (err) { console.log('[dashboard] refusal send failed:', err) }
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(typeof message === 'string' ? message : message.toString())
          } catch {
            refuse('frame is not valid JSON')
            return
          }
          const refusal = dashboardCommandRefusal(parsed)
          if (refusal !== null) {
            refuse(refusal)
            return
          }
          console.log(`[dashboard] Forwarding command: ${(parsed as { type: string }).type}`)
          this.deps.onCommand(parsed)
        },
        close: (ws: ServerWebSocket<unknown>) => {
          this.clients.delete(ws)
        },
      },
    })
  }

  // ── Authorization ───────────────────────────────────────────────

  /**
   * Null when the caller holds `scope`, otherwise the refusal to return.
   *
   * 401 and 403 are different answers and must not render identically: 401 says
   * "I do not know who you are", 403 says "I do, and you may not do this". The
   * second is the one that matters here — the inference token is handed to a
   * browser page in its own HTML, so it is the secret most likely to escape, and
   * it must not carry configuration rights with it.
   *
   * `allowQueryToken` exists for /ws alone. Query strings reach access logs,
   * shell history and Referer headers, so nothing that can use a header is
   * permitted to use the query string instead.
   */
  private requireScope(
    req: Request,
    scope: TokenScope,
    { allowQueryToken = false }: { allowQueryToken?: boolean } = {},
  ): Response | null {
    const authz = req.headers.get('authorization') ?? ''
    let presented = authz.startsWith('Bearer ') ? authz.slice(7) : null
    if (presented === null && allowQueryToken) {
      presented = new URL(req.url).searchParams.get('token')
    }

    if (presented === null) return jsonResponse({ error: 'token required' }, 401)
    if (this.tokens.verify(presented, scope)) return null
    // A real token lacking the scope is told so; anything else is not
    // acknowledged as a token at all.
    if (this.tokens.isKnown(presented)) {
      return jsonResponse({ error: `scope '${scope}' required` }, 403)
    }
    return jsonResponse({ error: 'token required' }, 401)
  }

  // ── GET Handlers ────────────────────────────────────────────────

  /**
   * The page, with the inference token injected at request time.
   *
   * Injected rather than baked in at startup so the served copy always matches
   * the current token file, and rather than fetched by the page from an endpoint
   * — an endpoint handing out tokens to anyone who asks is the hole this closes.
   */
  private serveIndex(): Response {
    const token = this.tokens.tokenFor('inference') ?? ''
    const inject = `<script>
window.__CYNCO_TOKEN = ${JSON.stringify(token)};
(function () {
  var raw = window.fetch;
  function sameOrigin(input) {
    // A relative URL, or an absolute one naming this origin. Anything else is a
    // third party and must not receive our token.
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    return u.indexOf('//') === -1 || u.indexOf(location.origin) === 0;
  }
  function withAuth(init, input, secret) {
    init = Object.assign({}, init);
    var h = new Headers(init.headers || (input && input.headers) || {});
    h.set('Authorization', 'Bearer ' + secret);
    init.headers = h;
    return init;
  }
  window.fetch = function (input, init) {
    if (!sameOrigin(input)) return raw(input, init);
    return raw(input, withAuth(init, input, window.__CYNCO_TOKEN)).then(function (res) {
      // 403 means the route wants the management scope, which is never handed to
      // a page: the engine prints it once at startup and it is pasted by hand.
      // Held in sessionStorage so one paste covers a sitting and none survives
      // the tab closing.
      if (res.status !== 403) return res;
      var t = sessionStorage.getItem('cynco_management_token');
      if (!t) {
        t = window.prompt('Management token (printed by the engine at startup):');
        if (!t) return res;
        t = t.trim();
        sessionStorage.setItem('cynco_management_token', t);
      }
      return raw(input, withAuth(init, input, t)).then(function (retry) {
        // A stored token that is still refused is the wrong one. Drop it so the
        // next attempt asks again rather than failing silently forever.
        if (retry.status === 403) sessionStorage.removeItem('cynco_management_token');
        return retry;
      });
    });
  };
})();
</script>`
    // Before any other script so no call site can run unauthenticated. If the
    // page has no <head>, prepending still puts it first.
    const body = this.indexHtml.includes('<head>')
      ? this.indexHtml.replace('<head>', `<head>${inject}`)
      : inject + this.indexHtml
    return htmlResponse(body)
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
    // Both siblings — getThinkingTurns and getThinkingTurn — have always done
    // this. This one had drifted, and joined ~/.cynco/sessions to whatever the
    // URL carried, so `..%2f..%2f` reached any .jsonl on disk. 400 rather than an
    // empty 200: "no such session" and "that is not a session id" are different
    // answers and must not render the same.
    if (!SESSION_ID_RE.test(sessionId)) return jsonResponse({ error: 'invalid session id' }, 400)
    try {
      const sessionDir = this.deps.sessionsDir ?? join(homedir(), '.cynco', 'sessions')
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

  private getThinkingTurns(sessionId: string): Response {
    if (!SESSION_ID_RE.test(sessionId)) return jsonResponse({ error: 'invalid session id' }, 400)
    const turns = ThinkingRecorder.readTurns(sessionId, this.deps.sessionsDir)
    if (turns.length === 0) return jsonResponse({ error: 'Not found' }, 404)
    return jsonResponse(turns.map(({ text: _text, ...index }) => index))
  }

  private getThinkingTurn(sessionId: string, turn: number): Response {
    if (!SESSION_ID_RE.test(sessionId)) return jsonResponse({ error: 'invalid session id' }, 400)
    const rec = ThinkingRecorder.readTurn(sessionId, turn, this.deps.sessionsDir)
    if (!rec) return jsonResponse({ error: 'Not found' }, 404)
    return jsonResponse(rec)
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
    const json = JSON.stringify(event)
    const type = (event as { type?: string }).type
    if (type && DashboardServer.REPLAY_TYPES.has(type)) this.replayCache.set(type, json)
    if (this.clients.size === 0) return
    for (const ws of this.clients) {
      try { ws.send(json) } catch {}
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  stop(): void {
    this.server.stop()
  }

  getPort(): number {
    // Prefer the server's actual bound port (non-zero when port=0 was requested).
    return this.server.port ?? this._port
  }

  getHostname(): string {
    return this._hostname
  }
}
