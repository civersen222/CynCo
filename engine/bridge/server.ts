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

  constructor(options: WSServerOptions) {
    this._port = options.port
    // Bind loopback only by default — the bridge carries full conversation
    // and tool traffic and must not be exposed on the network. Note this is a
    // floor, not the defence: a browser on this machine is already inside
    // loopback. See the upgrade gates below.
    this._hostname = process.env.LOCALCODE_BRIDGE_HOST || '127.0.0.1'
    this.tokens = options.tokens
    this.onCommand = options.onCommand
    this.start()
  }

  get port(): number { return this._port }
  get connected(): boolean { return this._connected }
  getHostname(): string { return this._hostname }

  private start() {
    // Try the requested port, then fall back to +1, +2 if it's stuck in TIME_WAIT/CLOSE_WAIT
    const portsToTry = [this._port, this._port + 1, this._port + 2]
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
      }
    }
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
