/**
 * Tier 3 consumer: polls the patched llama-server's /activations ring,
 * runs J-lens readouts on the selected layer via the sidecar, and broadcasts
 * brain.workspace messages to the dashboard (direct broadcast, not protocol).
 * Tier auto-detection (spec D5): start() probes both dependencies and reports
 * the achieved tier; every failure path degrades silently with a log line.
 */
import type { JlensClient, JlensTop } from './jlensClient.js'

export function decodeB64Floats(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

type Entry = { cursor: number; layer: number; pos: number; token: number; values_b64: string }

export type ConsumerOpts = {
  activationsUrl: string            // e.g. `${primaryUrl}/activations`
  jlens: JlensClient
  broadcast: (msg: Record<string, unknown>) => void
  layer: number                     // selected readout layer (dashboard can switch later)
  stride?: number                   // read out every Nth position (default 4)
  fetchFn?: typeof fetch
  intervalMs?: number               // default 100
}

export type BrainTier = 'live' | 'record-only' | 'entropy-only'

export class ActivationsConsumer {
  cursor = 0
  layer: number
  private readonly stride: number
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly fetchFn: typeof fetch
  private inFlight = false

  constructor(private opts: ConsumerOpts) {
    this.layer = opts.layer
    this.stride = opts.stride ?? 4
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** Probe deps, report tier, start polling if the tap is up. */
  async start(): Promise<BrainTier> {
    const tapUp = await this.pollOnce()
    const lensUp = (await this.opts.jlens.health()) !== null
    const tier: BrainTier = tapUp && lensUp ? 'live' : tapUp ? 'record-only' : 'entropy-only'
    console.log(`[brain] tier: ${tier} (tap=${tapUp} lens=${lensUp})`)
    this.opts.broadcast({ type: 'brain.tier', tier })
    if (tapUp) this.timer = setInterval(() => { void this.pollOnce() }, this.opts.intervalMs ?? 100)
    return tier
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One drain + readout pass. Returns whether the tap responded. */
  async pollOnce(): Promise<boolean> {
    if (this.inFlight) return true  // previous drain still running — skip, cursor stays consistent
    this.inFlight = true
    try {
      let data: { cursor: number; n_embd: number; entries: Entry[] }
      try {
        const r = await this.fetchFn(`${this.opts.activationsUrl}?since=${this.cursor}`, {
          signal: AbortSignal.timeout(3000),
        })
        if (!r.ok) return false
        data = await r.json() as typeof data
      } catch {
        return false  // tap down: normal for unpatched servers — stay quiet, degrade
      }
      for (const e of data.entries ?? []) {
        if (e.cursor > this.cursor) this.cursor = e.cursor
        if (e.layer !== this.layer) continue
        if (e.pos % this.stride !== 0) continue
        let h: Float32Array
        try {
          h = decodeB64Floats(e.values_b64)
        } catch (err) {
          console.log(`[brain] malformed activation payload at cursor ${e.cursor}: ${err}`)
          continue
        }
        const top = await this.opts.jlens.readout(this.layer, h)
        if (!top) continue
        this.opts.broadcast({ type: 'brain.workspace', layer: e.layer, pos: e.pos, token: e.token, top })
      }
      return true
    } finally {
      this.inFlight = false
    }
  }
}
