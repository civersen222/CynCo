// engine/__tests__/llama/provider.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { LlamaCppProvider } from '../../llama/provider.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('LlamaCppProvider', () => {
  it('has correct name', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.name).toBe('llama-cpp')
  })

  it('getBaseUrl returns primary when no adapter active', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.getBaseUrl()).toBe('http://127.0.0.1:8081')
  })

  it('activeAdapter returns null by default', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.activeAdapter()).toBeNull()
  })

  it('getBaseUrl returns adapterUrl when adapter is active and URL configured', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      adapterUrl: 'http://192.168.1.50:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    // Simulate adapter being active by calling the internal setter
    p._setActiveAdapter('s3-lora')
    expect(p.getBaseUrl()).toBe('http://192.168.1.50:8081')
    expect(p.activeAdapter()).toBe('s3-lora')
  })

  it('getBaseUrl returns primary after unloadAdapter', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      adapterUrl: 'http://192.168.1.50:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    p._setActiveAdapter('s3-lora')
    expect(p.getBaseUrl()).toBe('http://192.168.1.50:8081')
    p._clearActiveAdapter()
    expect(p.getBaseUrl()).toBe('http://127.0.0.1:8081')
    expect(p.activeAdapter()).toBeNull()
  })

  it('listModels scans modelsDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-list-'))
    try {
      // Create two model dirs
      fs.mkdirSync(path.join(tmpDir, 'qwen3.6'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'qwen3.6', 'model.gguf'), 'x')
      fs.mkdirSync(path.join(tmpDir, 'llama3'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'llama3', 'model.gguf'), 'x')

      const p = new LlamaCppProvider({
        primaryUrl: 'http://127.0.0.1:8081',
        modelName: 'qwen3.6',
        modelsDir: tmpDir,
      })

      const models = p.listModelsSync()
      expect(models).toHaveLength(2)
      const names = models.map(m => m.name)
      expect(names).toContain('qwen3.6')
      expect(names).toContain('llama3')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getCompletionsUrl uses getBaseUrl', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.getCompletionsUrl()).toBe('http://127.0.0.1:8081/v1/chat/completions')
  })
})
