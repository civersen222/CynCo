import { describe, it, expect } from 'vitest'
import { checkpointCostFromMeta, MEASURED_DEFAULT_COST, worstCheckpointMib, derivedCacheRamMib } from '../../llama/checkpointCost.js'
import type { GgufMeta } from '../../llama/gguf.js'

const qwen38: GgufMeta = {
  architecture: 'qwen35', blockCount: 65, contextLength: 262144, headCount: 24, headCountKv: 4,
  keyLength: 256, valueLength: 256, slidingWindow: 0, slidingWinPattern: 0, fullAttnInterval: 4,
  ssmInnerSize: 6144, ssmConvKernel: 4, ssmStateSize: 128, fileSizeBytes: 19694390752,
}

describe('checkpointCostFromMeta', () => {
  it('derives the Qwen3.8 recurrent-state constant within 1% of the measured intercept', () => {
    // 49 SSM layers x (6144*128 + 6144*3) elements x 4 bytes = 150.45 MiB; measured 149.65.
    const m = checkpointCostFromMeta(qwen38)
    expect(m.source).toBe('gguf')
    expect(m.baseMib).toBeCloseTo(150.45, 1)
    expect(Math.abs(m.baseMib - MEASURED_DEFAULT_COST.baseMib) / MEASURED_DEFAULT_COST.baseMib).toBeLessThan(0.01)
    expect(m.ssmLayers).toBe(49)
    expect(m.globalLayers).toBe(16)
  })

  it('derives the per-token slope as one global layer of f16 KV (4.00 KiB on Qwen3.8; measured 4.02)', () => {
    const m = checkpointCostFromMeta(qwen38)
    expect(m.kibPerToken).toBeCloseTo(4.0, 2)
    expect(Math.abs(m.kibPerToken - MEASURED_DEFAULT_COST.kibPerToken) / MEASURED_DEFAULT_COST.kibPerToken).toBeLessThan(0.01)
  })

  it('prices a sliding-window model: local layers contribute a window-sized constant', () => {
    const gemmaish: GgufMeta = { ...qwen38, architecture: 'gemma3', blockCount: 12, fullAttnInterval: 0,
      ssmInnerSize: 0, ssmConvKernel: 0, ssmStateSize: 0, slidingWindow: 1024, slidingWinPattern: 6, headCountKv: 8, keyLength: 256, valueLength: 256 }
    const m = checkpointCostFromMeta(gemmaish)
    // 12 layers, every 6th global -> 2 global, 10 local. Local const = 10 * 8 * 512 * 2 bytes * 1024 tokens.
    expect(m.globalLayers).toBe(2)
    expect(m.localLayers).toBe(10)
    expect(m.baseMib).toBeCloseTo((10 * 8 * 512 * 2 * 1024) / 2 ** 20, 3)
  })

  it('falls back to the measured default when core dims are missing, and says so', () => {
    const m = checkpointCostFromMeta({ ...qwen38, headCountKv: 0 })
    expect(m.source).toBe('measured-default')
    expect(m.baseMib).toBe(MEASURED_DEFAULT_COST.baseMib)
    expect(m.detail).toMatch(/head_count_kv/)
  })

  it('worstCheckpointMib and derivedCacheRamMib follow the model they are given', () => {
    const m = checkpointCostFromMeta(qwen38)
    expect(worstCheckpointMib(131072, m)).toBeCloseTo(m.baseMib + (131072 * m.kibPerToken) / 1024, 3)
    // Whole GiB, at least 1 GiB, monotonic in ctx.
    expect(derivedCacheRamMib(131072, 32, m) % 1024).toBe(0)
    expect(derivedCacheRamMib(131072, 32, m)).toBeGreaterThan(derivedCacheRamMib(65536, 32, m))
    // The value a real server has been proved to accept at the default (processManager.test.ts pins 21504).
    expect(derivedCacheRamMib(131072, 32, MEASURED_DEFAULT_COST)).toBe(21504)
  })
})
