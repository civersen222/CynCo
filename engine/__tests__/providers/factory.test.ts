import { describe, expect, it } from 'bun:test'
import { createProvider, providerFromName, PROVIDER_TYPES } from '../../providers/factory.js'
import { OllamaProvider } from '../../ollama/client.js'
import { LlamaCppProvider } from '../../llama/provider.js'

describe('createProvider factory', () => {
  it('creates OllamaProvider for ollama type', () => {
    const p = createProvider('ollama', 'http://localhost:11434')
    expect(p).toBeInstanceOf(OllamaProvider)
    expect(p.name).toBe('ollama')
  })

  it('creates LlamaCppProvider for llama-cpp type', () => {
    const p = createProvider('llama-cpp', 'http://127.0.0.1:8081')
    expect(p).toBeInstanceOf(LlamaCppProvider)
    expect(p.name).toBe('llama-cpp')
  })

  // It used to answer any name it did not know with an Ollama client.
  it('a name forced past the type is refused, not turned into an Ollama client', () => {
    expect(() => createProvider('unknown' as any, 'http://localhost:11434')).toThrow(/"unknown" is not a provider CynCo has/)
  })
})

/**
 * Until 2026-11-17 `ProviderType` also named lmstudio, llamacpp, vllm and openai-compat, and a
 * profile or LOCALCODE_PROVIDER could ask for them. None was ever built: every name but
 * llama-cpp went down the Ollama path, so `provider: vllm` ran the Ollama client against its
 * base URL and nothing said so (the 2026-11-17 work-order triage; decision sheet row 4).
 */
describe('providerFromName: a name CynCo does not have is refused where the configuration is read', () => {
  it('the two providers CynCo has', () => {
    expect([...PROVIDER_TYPES]).toEqual(['ollama', 'llama-cpp'])
    expect(providerFromName('ollama')).toEqual({ ok: true, provider: 'ollama' })
    expect(providerFromName('llama-cpp')).toEqual({ ok: true, provider: 'llama-cpp' })
    expect(providerFromName('  ollama ')).toEqual({ ok: true, provider: 'ollama' })
  })

  it('the three names that ran as Ollama are refused, with how to keep what they did', () => {
    for (const name of ['lmstudio', 'vllm', 'openai-compat']) {
      const r = providerFromName(name)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toContain(`provider "${name}" is not one of CynCo's`)
        expect(r.reason).toContain('set the provider to "ollama" with the same base URL')
      }
    }
  })

  it('the near-miss spelling is told the real one', () => {
    const r = providerFromName('llamacpp')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('its own llama-server is spelled "llama-cpp"')
  })

  it('any other name is refused with the two it may be', () => {
    const r = providerFromName('openai')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('provider "openai" is not one of CynCo\'s')
      expect(r.reason).toContain('"llama-cpp" (its own llama-server) and "ollama"')
    }
    expect(providerFromName('Ollama').ok).toBe(false)
    expect(providerFromName('').ok).toBe(false)
  })
})
