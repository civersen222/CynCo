// engine/__tests__/llama/processManager.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildServerArgs, ProcessManager } from '../../llama/processManager.js'

describe('buildServerArgs', () => {
  it('builds default args', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(args).toContain('--model')
    expect(args).toContain('/models/qwen.gguf')
    expect(args).toContain('--port')
    expect(args).toContain('8081')
    expect(args).toContain('--n-gpu-layers')
    expect(args).toContain('999')
    expect(args).toContain('--flash-attn')
    expect(args).toContain('on')
    expect(args).toContain('--ctx-size')
    expect(args).toContain('32768')
    expect(args).toContain('--batch-size')
    expect(args).toContain('2048')
    expect(args).toContain('--host')
    expect(args).toContain('127.0.0.1')
  })

  it('respects custom config', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 9090,
      ctxSize: 65536,
      batchSize: 4096,
      gpuLayers: 40,
      flashAttn: false,
      threads: 8,
    })
    expect(args).toContain('9090')
    expect(args).toContain('65536')
    expect(args).toContain('4096')
    expect(args).toContain('40')
    expect(args).toContain('--flash-attn')
    expect(args).toContain('off')
    expect(args).toContain('--threads')
    expect(args).toContain('8')
  })

  it('adds --lora flag when adapter specified', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
      loraPath: '/adapters/s3-lora.gguf',
    })
    expect(args).toContain('--lora')
    expect(args).toContain('/adapters/s3-lora.gguf')
  })

  it('adds speculative decoding flags when specType is set', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen-mtp.gguf',
      port: 8081,
      specType: 'draft-mtp',
      specDraftN: 2,
    })
    expect(args).toContain('--spec-type')
    expect(args).toContain('draft-mtp')
    expect(args).toContain('--spec-draft-n-max')
    expect(args).toContain('2')
  })

  it('defaults specDraftN to 2 when specType is set but specDraftN is not', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen-mtp.gguf',
      port: 8081,
      specType: 'draft-mtp',
    })
    expect(args).toContain('--spec-draft-n-max')
    expect(args).toContain('2')
  })

  it('does not add spec flags when specType is not set', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(args).not.toContain('--spec-type')
    expect(args).not.toContain('--spec-draft-n-max')
  })

  describe('cache-ram and reasoning-budget env config', () => {
    let savedCacheRam: string | undefined
    let savedReasoningBudget: string | undefined

    beforeEach(() => {
      savedCacheRam = process.env.LOCALCODE_CACHE_RAM
      savedReasoningBudget = process.env.LOCALCODE_REASONING_BUDGET
      delete process.env.LOCALCODE_CACHE_RAM
      delete process.env.LOCALCODE_REASONING_BUDGET
    })

    afterEach(() => {
      if (savedCacheRam === undefined) {
        delete process.env.LOCALCODE_CACHE_RAM
      } else {
        process.env.LOCALCODE_CACHE_RAM = savedCacheRam
      }
      if (savedReasoningBudget === undefined) {
        delete process.env.LOCALCODE_REASONING_BUDGET
      } else {
        process.env.LOCALCODE_REASONING_BUDGET = savedReasoningBudget
      }
    })

    it('defaults cache-ram to 0 and reasoning-budget to 256 when env unset', () => {
      const args = buildServerArgs({ modelPath: '/models/qwen.gguf', port: 8081 })
      const cacheIdx = args.indexOf('--cache-ram')
      expect(cacheIdx).toBeGreaterThanOrEqual(0)
      expect(args[cacheIdx + 1]).toBe('0')
      const budgetIdx = args.indexOf('--reasoning-budget')
      expect(budgetIdx).toBeGreaterThanOrEqual(0)
      expect(args[budgetIdx + 1]).toBe('256')
    })

    it('uses LOCALCODE_CACHE_RAM when set', () => {
      process.env.LOCALCODE_CACHE_RAM = '2048'
      const args = buildServerArgs({ modelPath: '/models/qwen.gguf', port: 8081 })
      const idx = args.indexOf('--cache-ram')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('2048')
    })

    it('uses LOCALCODE_REASONING_BUDGET when set', () => {
      process.env.LOCALCODE_REASONING_BUDGET = '512'
      const args = buildServerArgs({ modelPath: '/models/qwen.gguf', port: 8081 })
      const idx = args.indexOf('--reasoning-budget')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('512')
    })
  })
})

describe('ProcessManager', () => {
  it('constructs with config', () => {
    const pm = new ProcessManager({
      binaryPath: '/bin/llama-server',
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(pm.port).toBe(8081)
    expect(pm.isRunning()).toBe(false)
  })
})
