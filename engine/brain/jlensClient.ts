/**
 * Client for the jlens sidecar (Tier 2). Null-degradation everywhere: the
 * Brain never blocks or breaks decode when the sidecar is down (spec D5).
 */
export type JlensTop = { token: string; p: number }

export class JlensClient {
  constructor(
    private baseUrl: string = process.env.LOCALCODE_JLENS_URL ?? 'http://127.0.0.1:9163',
    private fetchFn: typeof fetch = fetch,
  ) {}

  async health(): Promise<{ ok: boolean; layers: number[] } | null> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (!r.ok) return null
      return await r.json() as { ok: boolean; layers: number[] }
    } catch (err) {
      console.log(`[brain] jlens health check failed: ${err}`)
      return null
    }
  }

  async readout(layer: number, h: Float32Array, k = 25): Promise<JlensTop[] | null> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/readout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layer, h: Array.from(h), k }),
        signal: AbortSignal.timeout(5000),
      })
      if (!r.ok) return null
      const data = await r.json() as { top: JlensTop[] }
      return Array.isArray(data.top) ? data.top : null
    } catch (err) {
      console.log(`[brain] jlens readout failed: ${err}`)
      return null
    }
  }
}
