/**
 * WebSocket server for CynCo headless mode.
 *
 * Accepts a single TUI client connection and bridges events
 * between the TS engine and the Python Textual frontend.
 */

import type { EngineEvent, TUICommand } from './protocol.js'
import { serializeEvent, parseCommand } from './protocol.js'

export type WSServerOptions = {
  port: number
  onCommand?: (command: TUICommand) => void
}

export class LocalCodeWSServer {
  private server: any = null
  private client: any = null
  private _port: number
  private _connected = false
  private onCommand: ((command: TUICommand) => void) | undefined

  constructor(options: WSServerOptions) {
    this._port = options.port
    this.onCommand = options.onCommand
    this.start()
  }

  get port(): number { return this._port }
  get connected(): boolean { return this._connected }

  private start() {
    // Try the requested port, then fall back to +1, +2 if it's stuck in TIME_WAIT/CLOSE_WAIT
    const portsToTry = [this._port, this._port + 1, this._port + 2]
    let lastError: any
    for (const port of portsToTry) {
      try {
        this.server = Bun.serve({
          port,
          fetch(req, server) {
            const success = server.upgrade(req)
            if (success) return undefined
            return new Response('WebSocket upgrade required', { status: 426 })
          },
          websocket: {
            open: (ws: any) => {
              this.client = ws
              this._connected = true
            },
            message: (_ws: any, message: string | Buffer) => {
              const text = typeof message === 'string' ? message : message.toString()
              const command = parseCommand(text)
              if (command && this.onCommand) {
                this.onCommand(command)
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
    if (this.client && this._connected) {
      this.client.send(serializeEvent(event))
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
    this.client = null
    this._connected = false
  }
}
