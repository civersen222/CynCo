/**
 * Measure the checkpoint cost the running llama-server actually pays and hold
 * the derived model (checkpointCost.ts) to it.
 *
 * llama-server logs every checkpoint it creates with its token position and
 * size. Two such lines far enough apart give an affine fit; three give a check.
 * The fit is persisted per model file so the NEXT start derives --cache-ram
 * from what this machine measured, not from a formula — and a formula that is
 * off by more than 15% is said out loud once, because that is F91's shape: a
 * budget computed from a wrong per-token cost that nobody re-measured.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CheckpointCostModel } from './checkpointCost.js'

export type CheckpointPoint = { tokens: number; mib: number }

const LINE = /created context checkpoint .*?n_tokens = (\d+).*?size = ([\d.]+) MiB/

export function parseCheckpointLine(line: string): CheckpointPoint | null {
  const m = LINE.exec(line)
  if (!m) return null
  return { tokens: Number(m[1]), mib: Number(m[2]) }
}

/** Least-squares affine fit mib = base + kibPerToken*tokens/1024. Null without a real spread. */
export function fitAffine(points: CheckpointPoint[]): { baseMib: number; kibPerToken: number } | null {
  if (points.length < 2) return null
  const n = points.length
  const mx = points.reduce((s, p) => s + p.tokens, 0) / n
  const my = points.reduce((s, p) => s + p.mib, 0) / n
  const sxx = points.reduce((s, p) => s + (p.tokens - mx) ** 2, 0)
  if (sxx === 0) return null
  const sxy = points.reduce((s, p) => s + (p.tokens - mx) * (p.mib - my), 0)
  const slopeMibPerToken = sxy / sxx
  return { baseMib: my - slopeMibPerToken * mx, kibPerToken: slopeMibPerToken * 1024 }
}

export const CALIBRATION_FILE = 'checkpoint-calibration.json'
type Stored = Record<string, { baseMib: number; kibPerToken: number; points: number; at: string }>

export class CheckpointCalibrator {
  private points: CheckpointPoint[] = []
  private warned = false
  fit: { baseMib: number; kibPerToken: number } | null = null

  constructor(private opts: {
    model: CheckpointCostModel
    modelKey: string
    storeDir: string
    warn: (msg: string) => void
    /** Minimum token distance between the first and last observation before a fit is trusted. */
    minTokenSpread?: number
    tolerance?: number
  }) {}

  observe(line: string): void {
    const p = parseCheckpointLine(line)
    if (!p) return
    this.points.push(p)
    if (this.points.length > 64) this.points = this.points.slice(-64)
    const spread = Math.max(...this.points.map(x => x.tokens)) - Math.min(...this.points.map(x => x.tokens))
    if (spread < (this.opts.minTokenSpread ?? 2000)) return
    const fit = fitAffine(this.points)
    if (!fit) return
    this.fit = fit
    this.persist(fit)
    this.compare(fit)
  }

  private compare(fit: { baseMib: number; kibPerToken: number }): void {
    if (this.warned) return
    const tol = this.opts.tolerance ?? 0.15
    const m = this.opts.model
    const offBase = Math.abs(fit.baseMib - m.baseMib) / Math.max(1, m.baseMib)
    const offSlope = Math.abs(fit.kibPerToken - m.kibPerToken) / Math.max(0.001, m.kibPerToken)
    if (offBase > tol || offSlope > tol) {
      this.warned = true
      this.opts.warn(
        `[llama-cpp] checkpoint cost model (${m.source}) is off: predicted ${m.baseMib.toFixed(1)} MiB + ${m.kibPerToken.toFixed(2)} KiB/token, ` +
        `measured ${fit.baseMib.toFixed(1)} MiB + ${fit.kibPerToken.toFixed(2)} KiB/token over ${this.points.length} checkpoints. ` +
        `The measured fit is stored and will drive --cache-ram on the next start.`,
      )
    }
  }

  private persist(fit: { baseMib: number; kibPerToken: number }): void {
    try {
      mkdirSync(this.opts.storeDir, { recursive: true })
      const file = join(this.opts.storeDir, CALIBRATION_FILE)
      const stored: Stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {}
      stored[this.opts.modelKey] = { ...fit, points: this.points.length, at: new Date().toISOString() }
      writeFileSync(file, JSON.stringify(stored, null, 2))
    } catch (e) {
      this.opts.warn(`[llama-cpp] could not persist checkpoint calibration: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  static loadStored(storeDir: string, modelKey: string): CheckpointCostModel | null {
    try {
      const file = join(storeDir, CALIBRATION_FILE)
      if (!existsSync(file)) return null
      const stored: Stored = JSON.parse(readFileSync(file, 'utf-8'))
      const s = stored[modelKey]
      if (!s || !(s.kibPerToken > 0) || !(s.baseMib >= 0)) return null
      return { baseMib: s.baseMib, kibPerToken: s.kibPerToken, source: 'calibrated',
        detail: `measured on this machine from ${s.points} checkpoints at ${s.at}`, globalLayers: 0, localLayers: 0, ssmLayers: 0 }
    } catch { return null }
  }
}
