// engine/__tests__/llama/processManager.test.ts
import { describe, expect, it } from 'bun:test'
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
