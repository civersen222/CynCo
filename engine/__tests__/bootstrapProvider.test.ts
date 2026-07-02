/**
 * Regression: llama-cpp setup failure must be FATAL, not a silent Ollama
 * fallback. The 2026-07-02 live-session breakage: a stale model name made
 * GGUF resolution fail, the engine silently fell back to Ollama with the
 * wrong model + context budget, then every request timed out with no
 * visible cause. bootstrapProvider must throw instead.
 */
import { describe, it, expect, vi } from 'vitest'
import type { LocalCodeConfig } from '../config.js'

vi.mock('../llama/binaryManager.js', () => ({
  resolveBinary: vi.fn(() => 'C:/fake/bin/llama-server.exe'),
  downloadBinary: vi.fn(async () => 'C:/fake/bin/llama-server.exe'),
}))

vi.mock('../llama/modelResolver.js', () => ({
  resolveModel: vi.fn(() => {
    throw new Error("No GGUF found for 'stale-model:latest'")
  }),
}))

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn(() => ({ name: 'ollama-fallback' })),
}))

import { bootstrapProvider } from '../bootstrapProvider.js'
import { createProvider } from '../providers/factory.js'

describe('bootstrapProvider llama-cpp failure path', () => {
  it('throws on llama-cpp setup failure instead of falling back to Ollama', async () => {
    const config = {
      provider: 'llama-cpp',
      model: 'stale-model:latest',
      baseUrl: 'http://localhost:11434',
      port: 8081,
    } as unknown as LocalCodeConfig

    await expect(bootstrapProvider(config)).rejects.toThrow(/No GGUF found/)

    // The old bug: a silent createOllamaFallback() here. Must never happen.
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled()
  })
})
