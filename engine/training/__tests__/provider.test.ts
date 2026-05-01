import { describe, test, expect } from 'bun:test'
import { OllamaProvider } from '../../ollama/client.js'
import type { Provider, ModelCapabilities, ModelInfo, CompletionRequest } from '../../provider.js'
import type { CompletionResponse, StreamEvent } from '../../types.js'

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

  describe('A mock provider CAN implement adapter methods', () => {
    class MockAdapterProvider implements Provider {
      readonly name = 'mock-adapter'
      private _activeAdapter: string | null = null

      listModels(): Promise<ModelInfo[]> {
        return Promise.resolve([])
      }

      probeCapabilities(_model: string): Promise<ModelCapabilities> {
        return Promise.resolve({
          tier: 'advanced',
          toolUse: 'native',
          thinking: 'none',
          vision: false,
          jsonMode: true,
          contextLength: 8192,
          streaming: true,
        })
      }

      complete(_request: CompletionRequest): Promise<CompletionResponse> {
        return Promise.resolve({ content: '', model: 'mock', usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' })
      }

      async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
        // no-op
      }

      healthCheck(): Promise<boolean> {
        return Promise.resolve(true)
      }

      async loadAdapter(adapterId: string): Promise<void> {
        this._activeAdapter = adapterId
      }

      async unloadAdapter(): Promise<void> {
        this._activeAdapter = null
      }

      activeAdapter(): string | null {
        return this._activeAdapter
      }
    }

    const mock = new MockAdapterProvider()

    test('activeAdapter returns null before loading', () => {
      expect(mock.activeAdapter()).toBeNull()
    })

    test('loadAdapter sets the active adapter', async () => {
      await mock.loadAdapter('s3-lora')
      expect(mock.activeAdapter()).toBe('s3-lora')
    })

    test('unloadAdapter clears the active adapter', async () => {
      await mock.unloadAdapter()
      expect(mock.activeAdapter()).toBeNull()
    })

    test('mock satisfies the Provider interface', () => {
      const p: Provider = mock
      expect(typeof p.loadAdapter).toBe('function')
      expect(typeof p.unloadAdapter).toBe('function')
      expect(typeof p.activeAdapter).toBe('function')
    })
  })
})
