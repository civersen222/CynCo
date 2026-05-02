import { describe, expect, it } from 'bun:test'
import { createProvider } from '../../providers/factory.js'
import { OllamaProvider } from '../../ollama/client.js'
import { OpenAICompatProvider } from '../../providers/openaiCompat.js'
import { LlamaCppProvider } from '../../llama/provider.js'

describe('createProvider factory', () => {
  it('creates OllamaProvider for ollama type', () => {
    const p = createProvider('ollama', 'http://localhost:11434')
    expect(p).toBeInstanceOf(OllamaProvider)
    expect(p.name).toBe('ollama')
  })

  it('creates OpenAICompatProvider for lmstudio type', () => {
    const p = createProvider('lmstudio', 'http://localhost:1234')
    expect(p).toBeInstanceOf(OpenAICompatProvider)
    expect(p.name).toBe('lmstudio')
  })

  it('creates OpenAICompatProvider for vllm type', () => {
    const p = createProvider('vllm', 'http://gpu:8000', 'mykey')
    expect(p).toBeInstanceOf(OpenAICompatProvider)
    expect(p.name).toBe('vllm')
  })

  it('creates OpenAICompatProvider for llamacpp type', () => {
    const p = createProvider('llamacpp', 'http://localhost:8000')
    expect(p).toBeInstanceOf(OpenAICompatProvider)
    expect(p.name).toBe('llamacpp')
  })

  it('creates LlamaCppProvider for llama-cpp type', () => {
    const p = createProvider('llama-cpp', 'http://127.0.0.1:8081')
    expect(p).toBeInstanceOf(LlamaCppProvider)
    expect(p.name).toBe('llama-cpp')
  })

  it('creates OpenAICompatProvider for openai-compat type', () => {
    const p = createProvider('openai-compat', 'http://custom:9000')
    expect(p).toBeInstanceOf(OpenAICompatProvider)
    expect(p.name).toBe('custom')
  })

  it('defaults to OllamaProvider for unknown type', () => {
    const p = createProvider('unknown' as any, 'http://localhost:11434')
    expect(p).toBeInstanceOf(OllamaProvider)
  })
})
