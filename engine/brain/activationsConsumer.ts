/**
 * Tier 3 consumer: polls the patched llama-server's /activations ring,
 * runs J-lens readouts on the selected layer via the sidecar, and broadcasts
 * brain.workspace messages to the dashboard (direct broadcast, not protocol).
 * Tier auto-detection (spec D5): start() probes both dependencies and reports
 * the achieved tier; every failure path degrades silently with a log line.
 */
import type { JlensClient, JlensTop } from './jlensClient.js'
import { ConvergenceAccumulator, type LayerTop } from './layerConvergence.js'

export function decodeB64Floats(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/** The layers the tap and the sidecar are both configured for. Must stay equal
 *  to `DEFAULT_LAYERS` in `jlens/jlens_service/config.py` — a layer the sidecar
 *  cannot read out would make every position incomplete and the window empty. */
export const DEFAULT_LAYERS = [24, 32, 40, 48, 56]

type Entry = { cursor: number; layer: number; pos: number; token: number; values_b64: string }

export type ConsumerOpts = {
  activationsUrl: string            // e.g. `${primaryUrl}/activations`
  jlens: JlensClient
  broadcast: (msg: Record<string, unknown>) => void
  layer: number                     // selected readout layer (dashboard can switch later)
  stride?: number                   // read out every Nth position (default 4)
  fetchFn?: typeof fetch
  intervalMs?: number               // default 100
  /** Whether the server was launched with activation taps (LLAMA_ACTIVATIONS_LAYERS).
   *  The patched binary serves /activations (empty forever) even with taps off,
   *  so a 200 alone must not count as tap up. Default true (external servers). */
  tapConfigured?: boolean
  /** How often to re-check the two dependencies while the tier is degraded.
   *  Default 10s. Only armed when tapConfigured — the env var cannot change
   *  inside a running process, so a false there is permanent by construction. */
  reprobeMs?: number
  /** Every layer the tap emits and the sidecar can read out. A position is
   *  scored for convergence only when all of them arrived. Default
   *  `DEFAULT_LAYERS`. */
  layers?: number[]
}

export type BrainTier = 'live' | 'record-only' | 'entropy-only'

export class ActivationsConsumer {
  cursor = 0
  layer: number
  private readonly stride: number
  private timer: ReturnType<typeof setInterval> | null = null
  private reprobeTimer: ReturnType<typeof setInterval> | null = null
  private readonly fetchFn: typeof fetch
  private inFlight = false
  private currentTier: BrainTier = 'entropy-only'
  private announced = false
  private readonly probedLayers: number[]
  private readonly acc: ConvergenceAccumulator

  constructor(private opts: ConsumerOpts) {
    this.layer = opts.layer
    this.stride = opts.stride ?? 4
    this.fetchFn = opts.fetchFn ?? fetch
    this.probedLayers = opts.layers ?? DEFAULT_LAYERS
    this.acc = new ConvergenceAccumulator(this.probedLayers)
  }

  /** The tier the last probe achieved. */
  tier(): BrainTier {
    return this.currentTier
  }

  /** Layer convergence over the positions accumulated since the last reset.
   *  Data only (Phase 2 ruling 1) — read by the status frame, never branched on. */
  convergence(): ReturnType<ConvergenceAccumulator['snapshot']> {
    return this.acc.snapshot()
  }

  /** Drop the window. Called at each model call so a frame describes its turn. */
  resetConvergence(): void {
    this.acc.reset()
  }

  /** Probe deps, report tier, start polling if the tap is up.
   *
   *  The tier used to be decided once here and never revisited, so a jlens
   *  sidecar started a minute after the engine left the dashboard reading
   *  `record-only` until the next restart — and the operator, seeing a stale
   *  badge, concluded the sidecar had failed. Re-probe on a timer instead.
   */
  async start(): Promise<BrainTier> {
    const tier = await this.evaluate()
    // No re-probe when the tap was never configured: LLAMA_ACTIVATIONS_LAYERS
    // is read from our own env at spawn, so it cannot become true later.
    if (this.opts.tapConfigured ?? true) {
      this.reprobeTimer = setInterval(() => { void this.evaluate() }, this.opts.reprobeMs ?? 10_000)
    }
    return tier
  }

  /** Probe both dependencies, announce the tier if it moved, and make the
   *  drain loop match. Idempotent — safe to call on a timer. */
  private async evaluate(): Promise<BrainTier> {
    const tapUp = (this.opts.tapConfigured ?? true) && await this.pollOnce()
    const lens = await this.opts.jlens.health()
    const lensUp = lens !== null
    const tier: BrainTier = tapUp && lensUp ? 'live' : tapUp ? 'record-only' : 'entropy-only'

    if (!this.announced || tier !== this.currentTier) {
      this.announced = true
      this.currentTier = tier
      console.log(`[brain] tier: ${tier} (tap=${tapUp} lens=${lensUp})`)
      // `tap`/`lens`/`tapConfigured` ride along so the dashboard can name the
      // dependency that is actually missing. It used to hardcode "unpatched
      // server" for every entropy-only, which is wrong whenever the binary is
      // patched but was launched with taps off — the common case, and one that
      // sent the operator looking at the wrong thing.
      this.opts.broadcast({
        type: 'brain.tier', tier,
        tap: tapUp, lens: lensUp, tapConfigured: this.opts.tapConfigured ?? true,
        layers: lens?.layers ?? [], layer: this.layer,
      })
    }

    if (tapUp && !this.timer) {
      this.timer = setInterval(() => { void this.pollOnce() }, this.opts.intervalMs ?? 100)
    } else if (!tapUp && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return tier
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.reprobeTimer) clearInterval(this.reprobeTimer)
    this.reprobeTimer = null
  }

  /** One layer's readout, degraded to null. `JlensClient` already null-degrades;
   *  this is the belt for any other lens implementation, so one bad layer costs
   *  its position and never throws into the poll loop. */
  private async readout(layer: number, h: Float32Array): Promise<JlensTop[] | null> {
    try {
      return await this.opts.jlens.readout(layer, h)
    } catch (err) {
      console.log(`[brain] readout failed for layer ${layer}: ${err}`)
      return null
    }
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
      // Group the batch by position first. The tap emits every probed layer of
      // a position together, so a complete position can be read out across all
      // of them in one pass and scored for convergence. A position whose layers
      // straddle two polls arrives incomplete and is simply not scored — rare,
      // and it costs one sample, never a wrong one.
      const order: number[] = []
      const byPos = new Map<number, Map<number, Float32Array>>()
      const selected = new Map<number, Entry>()
      for (const e of data.entries ?? []) {
        if (e.cursor > this.cursor) this.cursor = e.cursor
        if (e.pos % this.stride !== 0) continue
        let h: Float32Array
        try {
          h = decodeB64Floats(e.values_b64)
        } catch (err) {
          console.log(`[brain] malformed activation payload at cursor ${e.cursor}: ${err}`)
          continue
        }
        let layers = byPos.get(e.pos)
        if (!layers) { layers = new Map(); byPos.set(e.pos, layers); order.push(e.pos) }
        layers.set(e.layer, h)
        if (e.layer === this.layer) selected.set(e.pos, e)
      }

      for (const pos of order) {
        const layers = byPos.get(pos)!
        const sel = selected.get(pos)
        let selTop: JlensTop[] | null = null
        let selRead = false

        // Convergence needs every probed layer of this position.
        if (this.probedLayers.every(l => layers.has(l))) {
          const tops = await Promise.all(this.probedLayers.map(l => this.readout(l, layers.get(l)!)))
          const readouts = new Map<number, LayerTop>()
          for (const [i, l] of this.probedLayers.entries()) {
            const t = tops[i]
            if (t) readouts.set(l, t)
          }
          // A null readout on any layer makes the position unscoreable: the
          // deepest layer is the target and a missing shallower one would
          // silently shrink the denominator.
          if (readouts.size === this.probedLayers.length && this.currentTier === 'live') this.acc.add(pos, readouts)
          const i = this.probedLayers.indexOf(this.layer)
          if (i >= 0) { selTop = tops[i]; selRead = true }
        }

        // The single-layer workspace broadcast, unchanged — reusing the readout
        // already fetched above whenever the selected layer was one of them.
        if (!sel) continue
        if (!selRead) selTop = await this.readout(this.layer, layers.get(this.layer)!)
        if (!selTop) continue
        this.opts.broadcast({ type: 'brain.workspace', layer: sel.layer, pos: sel.pos, token: sel.token, top: selTop })
      }
      return true
    } finally {
      this.inFlight = false
    }
  }
}
