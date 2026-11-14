/**
 * WebSocket server for CynCo headless mode.
 *
 * Accepts a single TUI client connection and bridges events
 * between the TS engine and the Python Textual frontend.
 */

import type { EngineEvent, TUICommand } from './protocol.js'
import { serializeEvent, parseCommandResult } from './protocol.js'
import type { TokenSet } from '../security/localToken.js'

export type WSServerOptions = {
  port: number
  /**
   * Required, and deliberately not optional-with-a-default. A missing token
   * store must be a compile error at the call site, never a server that quietly
   * starts up ungated.
   */
  tokens: TokenSet
  onCommand?: (command: TUICommand) => void
  /**
   * F236: may the bridge take the next port when its own is held? Yes (the
   * default) for a second engine beside the live one. No for an engine in the
   * phone engine's seat (port 9160, the default home: `inPhoneEnginesSeat`):
   * 9162 is a port the phone, the doorman and dispatch never look at, so a
   * seat engine that walked there served nobody and left the seat to whatever
   * held it (2026-11-14: the phone engine on 9162 behind a bare stand-in).
   */
  walk?: boolean
}

/** How long a seat engine keeps asking for its own port before it refuses: a holder that just exited closes its listener in well under this. */
export const SEAT_RETRY_MS = 10_000
/** The pause between a seat engine's attempts. */
export const SEAT_PAUSE_MS = 250

/**
 * The ports to try, in order, and the pause after each failed attempt (F236).
 * A walking engine tries its port, +1 and +2 once each; a seat engine tries its
 * own port again and again for SEAT_RETRY_MS. Pure.
 */
export function bridgePortPlan(port: number, walk: boolean): { ports: number[]; pauseMs: number } {
  if (port === 0) return { ports: [0], pauseMs: 0 }
  if (walk) return { ports: [port, port + 1, port + 2], pauseMs: 0 }
  return { ports: Array.from({ length: SEAT_RETRY_MS / SEAT_PAUSE_MS + 1 }, () => port), pauseMs: SEAT_PAUSE_MS }
}

/** The phone engine's seat is held by another process; this engine refuses rather than walk (F236). */
export class SeatTakenError extends Error {
  constructor(readonly port: number, cause: unknown) {
    super(`[ws] Port ${port} in use — this engine is in the phone engine's seat and does not walk to another port, ` +
      `where the phone and dispatch would never find it. Another engine holds it (scripts\\cynco-services.ps1 status names the phone engine; ` +
      `a mission or desk engine says so in its own log). Last error: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SeatTakenError'
  }
}

export class LocalCodeWSServer {
  private server: any = null
  private client: any = null
  private _port: number
  private _hostname: string
  private _connected = false
  private onCommand: ((command: TUICommand) => void) | undefined
  private lastSessionReady: EngineEvent | null = null
  private tokens: TokenSet
  private readonly walk: boolean

  constructor(options: WSServerOptions) {
    this._port = options.port
    this.walk = options.walk ?? true
    // Bind loopback only by default — the bridge carries full conversation
    // and tool traffic and must not be exposed on the network. Note this is a
    // floor, not the defence: a browser on this machine is already inside
    // loopback. See the upgrade gates below.
    this._hostname = process.env.LOCALCODE_BRIDGE_HOST || '127.0.0.1'
    this.tokens = options.tokens
    this.onCommand = options.onCommand
    this.start()
  }

  /** The port actually bound: with `port: 0` the OS picks one, and callers (the dashboard's `+ 1`, tests) need the real number. */
  get port(): number { return this.server?.port || this._port }
  get connected(): boolean { return this._connected }
  getHostname(): string { return this._hostname }

  private start() {
    // Try the requested port, then fall back to +1, +2 if it's stuck in TIME_WAIT/CLOSE_WAIT.
    // Port 0 means "OS, pick one" and never needs the walk. A seat engine
    // (`walk: false`, F236) asks for its own port again for SEAT_RETRY_MS and
    // then refuses with SeatTakenError.
    const plan = bridgePortPlan(this._port, this.walk)
    const portsToTry = plan.ports
    let lastError: any
    for (const port of portsToTry) {
      try {
        this.server = Bun.serve({
          port,
          hostname: this._hostname,
          fetch: (req, server) => {
            // Every check happens BEFORE server.upgrade. An accepted-then-closed
            // socket has already run `open`, and `open` is where the TUI got
            // displaced — closing afterwards does not undo that.

            // (1) No browser may speak to this port. A page cannot suppress
            // Origin on a WebSocket handshake; the Python client never sends it.
            // The bridge has no browser client, so any Origin at all is hostile
            // or misrouted, and the value is not worth allowlisting.
            if (req.headers.get('origin') !== null) {
              return new Response('bridge does not accept browser clients', { status: 403 })
            }

            // (2) Prove you hold the secret this process minted. Covers every
            // non-browser caller, about which (1) says nothing.
            const authz = req.headers.get('authorization') ?? ''
            const presented = authz.startsWith('Bearer ') ? authz.slice(7) : null
            if (!this.tokens.verify(presented, 'bridge')) {
              return new Response('bridge token required', { status: 401 })
            }

            // (3) One client at a time, and the incumbent keeps the socket.
            // Replacing it silently left the TUI connected but deaf.
            if (this.client !== null) {
              return new Response('bridge already has a client', { status: 409 })
            }

            const success = server.upgrade(req)
            if (success) return undefined
            return new Response('WebSocket upgrade required', { status: 426 })
          },
          websocket: {
            open: (ws: any) => {
              this.client = ws
              this._connected = true
              if (this.lastSessionReady !== null) {
                ws.send(serializeEvent(this.lastSessionReady))
              }
            },
            message: (_ws: any, message: string | Buffer) => {
              const text = typeof message === 'string' ? message : message.toString()
              const parsed = parseCommandResult(text)
              if (!parsed.ok) {
                // Tell the sender. A refusal that goes only to this process's
                // stdout is, from the client's side, indistinguishable from an
                // engine that simply has not answered yet — so the client waits
                // out its whole timeout on work that was never accepted (F32).
                console.warn(`[bridge] REFUSED command frame: ${parsed.reason}`)
                this.emit({
                  type: 'session.error',
                  error: `command frame refused: ${parsed.reason}`,
                })
                return
              }
              if (this.onCommand) {
                this.onCommand(parsed.command)
              }
            },
            close: () => {
              this.client = null
              this._connected = false
            },
          },
        })
        this._port = port
        if (port !== portsToTry[0]) {
          console.log(`[ws] Port ${portsToTry[0]} in use, using ${port} instead`)
        }
        return
      } catch (e) {
        lastError = e
        // Synchronous like Bun.serve itself: the engine's start waits on this bind.
        if (plan.pauseMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, plan.pauseMs)
      }
    }
    if (!this.walk && this._port !== 0) throw new SeatTakenError(this._port, lastError)
    throw lastError
  }

  emit(event: EngineEvent): void {
    if (event.type === 'session.ready') {
      this.lastSessionReady = event
    }
    if (this.client && this._connected) {
      this.client.send(serializeEvent(event))
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      // stop(true): force-close active WebSocket connections. The graceful
      // default waits for clients to disconnect — but at /quit time the
      // driver's socket is open, WAITING for us to close it (F131 residual 2:
      // both sides politely waited and the engine sat undead for 18h). An
      // engine that has been told to quit has no clients worth waiting for.
      this.server.stop(true)
      this.server = null
    }
    this.client = null
    this._connected = false
  }
}
