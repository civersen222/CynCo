// engine/__tests__/llama/processManager.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildServerArgs, ProcessManager, validateChatTemplate } from '../../llama/processManager.js'

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

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

  it('adds --chat-template-file when chatTemplateFile is set', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
      chatTemplateFile: '/models/qwen/chat_template.jinja',
    })
    expect(args).toContain('--chat-template-file')
    expect(args).toContain('/models/qwen/chat_template.jinja')
  })

  it('does not add --chat-template-file when chatTemplateFile is not set', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(args).not.toContain('--chat-template-file')
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

    it('omits cache-ram and defaults reasoning-budget to 256 when env unset', () => {
      const args = buildServerArgs({ modelPath: '/models/qwen.gguf', port: 8081 })
      expect(args).not.toContain('--cache-ram')
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

describe('buildServerArgs — config-driven cacheRam/reasoningBudget', () => {
  afterEach(() => {
    delete process.env.LOCALCODE_CACHE_RAM
    delete process.env.LOCALCODE_REASONING_BUDGET
  })

  it('emits the canonical MTP profile args', () => {
    const args = buildServerArgs({
      modelPath: '/m/Qwen3.6-27B-Q6_K.gguf',
      port: 8081,
      ctxSize: 65536,
      specType: 'draft-mtp',
      specDraftN: 3,
    })
    expect(argValue(args, '--ctx-size')).toBe('65536')
    expect(argValue(args, '--spec-type')).toBe('draft-mtp')
    expect(argValue(args, '--spec-draft-n-max')).toBe('3')
  })

  it('uses config cacheRam/reasoningBudget over env and default', () => {
    process.env.LOCALCODE_CACHE_RAM = '9999'
    process.env.LOCALCODE_REASONING_BUDGET = '9999'
    const args = buildServerArgs({
      modelPath: '/m/x.gguf', port: 8081,
      cacheRam: 0, reasoningBudget: 256,
    })
    expect(argValue(args, '--cache-ram')).toBe('0')
    expect(argValue(args, '--reasoning-budget')).toBe('256')
  })

  it('falls back to env then default when config omits them', () => {
    const a1 = buildServerArgs({ modelPath: '/m/x.gguf', port: 8081 })
    expect(a1).not.toContain('--cache-ram')
    expect(argValue(a1, '--reasoning-budget')).toBe('256')
    process.env.LOCALCODE_CACHE_RAM = '2048'
    const a2 = buildServerArgs({ modelPath: '/m/x.gguf', port: 8081 })
    expect(argValue(a2, '--cache-ram')).toBe('2048')
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

  it('templateWarning starts null before any validation (P1.8)', () => {
    // startProcess spawns a real llama-server, so the set-on-failure path is
    // exercised at runtime only; the field contract is tested here.
    const pm = new ProcessManager({
      binaryPath: '/bin/llama-server',
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(pm.templateWarning).toBeNull()
  })
})

describe('buildServerArgs — checkpoint caching (prefill elimination)', () => {
  const base = { modelPath: '/models/qwen.gguf', port: 8081 }

  let savedCtxCheckpoints: string | undefined
  let savedCheckpointMinStep: string | undefined
  let savedUbatchSize: string | undefined
  let savedCacheRam: string | undefined

  beforeEach(() => {
    savedCtxCheckpoints = process.env.LOCALCODE_CTX_CHECKPOINTS
    savedCheckpointMinStep = process.env.LOCALCODE_CHECKPOINT_MIN_STEP
    savedUbatchSize = process.env.LOCALCODE_UBATCH_SIZE
    savedCacheRam = process.env.LOCALCODE_CACHE_RAM
    delete process.env.LOCALCODE_CTX_CHECKPOINTS
    delete process.env.LOCALCODE_CHECKPOINT_MIN_STEP
    delete process.env.LOCALCODE_UBATCH_SIZE
    delete process.env.LOCALCODE_CACHE_RAM
  })

  afterEach(() => {
    if (savedCtxCheckpoints === undefined) {
      delete process.env.LOCALCODE_CTX_CHECKPOINTS
    } else {
      process.env.LOCALCODE_CTX_CHECKPOINTS = savedCtxCheckpoints
    }
    if (savedCheckpointMinStep === undefined) {
      delete process.env.LOCALCODE_CHECKPOINT_MIN_STEP
    } else {
      process.env.LOCALCODE_CHECKPOINT_MIN_STEP = savedCheckpointMinStep
    }
    if (savedUbatchSize === undefined) {
      delete process.env.LOCALCODE_UBATCH_SIZE
    } else {
      process.env.LOCALCODE_UBATCH_SIZE = savedUbatchSize
    }
    if (savedCacheRam === undefined) {
      delete process.env.LOCALCODE_CACHE_RAM
    } else {
      process.env.LOCALCODE_CACHE_RAM = savedCacheRam
    }
  })

  it('adds checkpoint and ubatch defaults', () => {
    const args = buildServerArgs(base)
    expect(argValue(args, '--ctx-checkpoints')).toBe('64')
    expect(argValue(args, '--checkpoint-min-step')).toBe('256')
    expect(argValue(args, '--ubatch-size')).toBe('2048')
  })

  it('omits --cache-ram by default so the llama.cpp default applies', () => {
    const args = buildServerArgs(base)
    expect(args).not.toContain('--cache-ram')
  })

  it('honors explicit cacheRam config', () => {
    const args = buildServerArgs({ ...base, cacheRam: 4096 })
    expect(argValue(args, '--cache-ram')).toBe('4096')
  })

  it('honors LOCALCODE_CACHE_RAM env when config unset', () => {
    process.env.LOCALCODE_CACHE_RAM = '2048'
    const args = buildServerArgs(base)
    expect(argValue(args, '--cache-ram')).toBe('2048')
  })

  it('honors config overrides for checkpoint/ubatch flags', () => {
    const args = buildServerArgs({ ...base, ctxCheckpoints: 128, checkpointMinStep: 512, ubatchSize: 1024 })
    expect(argValue(args, '--ctx-checkpoints')).toBe('128')
    expect(argValue(args, '--checkpoint-min-step')).toBe('512')
    expect(argValue(args, '--ubatch-size')).toBe('1024')
  })

  it('honors env overrides for checkpoint/ubatch flags', () => {
    process.env.LOCALCODE_CTX_CHECKPOINTS = '32'
    process.env.LOCALCODE_CHECKPOINT_MIN_STEP = '2048'
    process.env.LOCALCODE_UBATCH_SIZE = '512'
    const args = buildServerArgs(base)
    expect(argValue(args, '--ctx-checkpoints')).toBe('32')
    expect(argValue(args, '--checkpoint-min-step')).toBe('2048')
    expect(argValue(args, '--ubatch-size')).toBe('512')
  })

  it('falls back to default when LOCALCODE_UBATCH_SIZE is garbage', () => {
    process.env.LOCALCODE_UBATCH_SIZE = 'abc'
    const args = buildServerArgs(base)
    expect(argValue(args, '--ubatch-size')).toBe('2048')
  })
})

describe('buildServerArgs — native tool calling (P1.8)', () => {
  it('buildServerArgs includes --jinja for native tool calling (P1.8)', () => {
    const args = buildServerArgs({ modelPath: 'm.gguf', port: 8080 })
    expect(args).toContain('--jinja')
  })
})

describe('validateChatTemplate', () => {
  it('returns ok when the server template mentions tools', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      chat_template: '{% if tools %}...{% endif %}',
    }), { status: 200 })
    const result = await validateChatTemplate('http://127.0.0.1:8080', fetchImpl as any)
    expect(result.ok).toBe(true)
  })

  it('returns ok:false with reason when the template has no tool support', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      chat_template: '{{ messages }}',
    }), { status: 200 })
    const result = await validateChatTemplate('http://127.0.0.1:8080', fetchImpl as any)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('tool')
  })

  it('returns ok:false without throwing when /props is unreachable', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
    const result = await validateChatTemplate('http://127.0.0.1:8080', fetchImpl as any)
    expect(result.ok).toBe(false)
  })
})

describe('spawn env passthrough (Brain Tier 3)', () => {
  // startProcess spawns a real llama-server, so we lock in the env contract
  // statically: the spawn env must spread process.env so vars like
  // LLAMA_ACTIVATIONS_LAYERS set in the parent reach the child server.
  it('spawn env spreads process.env (LLAMA_ACTIVATIONS_LAYERS reaches child)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(require.resolve('../../llama/processManager.ts'), 'utf-8')
    expect(src).toContain('const env = { ...process.env }')
    expect(src).toMatch(/spawn\(this\.binaryPath, args, \{[\s\S]*?env,[\s\S]*?\}\)/)
  })
})
