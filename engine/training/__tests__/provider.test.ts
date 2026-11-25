import { beforeEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaProvider } from '../../ollama/client.js'
import { LlamaCppProvider } from '../../llama/provider.js'
import type { Provider } from '../../provider.js'

describe('Provider interface — LoRA adapter methods', () => {
  describe('OllamaProvider does not implement adapter methods', () => {
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })

    test('loadAdapter is undefined', () => {
      expect(provider.loadAdapter).toBeUndefined()
    })

    test('unloadAdapter is undefined', () => {
      expect(provider.unloadAdapter).toBeUndefined()
    })

    test('activeAdapter is undefined', () => {
      expect(provider.activeAdapter).toBeUndefined()
    })
  })

  // NOW.md (2026-11-24): this describe used to test a mock class it defined itself, so it said nothing about
  // the engine. It now tests the provider that implements the adapter methods, LlamaCppProvider, in its
  // two-machine form (an adapter URL), where loading an adapter routes requests and starts no process.
  describe('LlamaCppProvider implements the adapter methods', () => {
    const PRIMARY = 'http://127.0.0.1:1'
    const ADAPTER = 'http://127.0.0.1:2'
    const make = (adapterUrl?: string) =>
      new LlamaCppProvider({ primaryUrl: PRIMARY, adapterUrl, modelName: 'm', modelsDir: join(tmpdir(), 'cynco-provider-test-models-never-made') })
    let provider: LlamaCppProvider
    beforeEach(() => { provider = make(ADAPTER) })

    test('activeAdapter returns null before loading, and requests go to the primary server', () => {
      expect(provider.activeAdapter()).toBeNull()
      expect(provider.getCompletionsUrl()).toBe(`${PRIMARY}/v1/chat/completions`)
    })

    test('loadAdapter sets the active adapter and routes requests to the adapter server', async () => {
      await provider.loadAdapter('s3-lora')
      expect(provider.activeAdapter()).toBe('s3-lora')
      expect(provider.getCompletionsUrl()).toBe(`${ADAPTER}/v1/chat/completions`)
    })

    test('unloadAdapter clears the active adapter and routes back to the primary server', async () => {
      await provider.loadAdapter('s3-lora')
      await provider.unloadAdapter()
      expect(provider.activeAdapter()).toBeNull()
      expect(provider.getCompletionsUrl()).toBe(`${PRIMARY}/v1/chat/completions`)
    })

    test('with one machine and no process manager, loadAdapter refuses by name and changes nothing', async () => {
      const single = make()
      await expect(single.loadAdapter('s3-lora')).rejects.toThrow('Cannot load adapter: no ProcessManager configured and no LOCALCODE_ADAPTER_URL set')
      expect(single.activeAdapter()).toBeNull()
    })

    test('it satisfies the Provider interface with all three adapter methods', () => {
      const p: Provider = provider
      expect(typeof p.loadAdapter).toBe('function')
      expect(typeof p.unloadAdapter).toBe('function')
      expect(typeof p.activeAdapter).toBe('function')
    })
  })
})
