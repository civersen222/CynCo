import { describe, expect, it } from 'bun:test'
import { OpenAICompatProvider } from '../../providers/openaiCompat.js'

describe('OpenAICompatProvider', () => {
  it('has correct name', () => {
    const p = new OpenAICompatProvider({ name: 'lmstudio', baseUrl: 'http://localhost:1234', apiKey: '' })
    expect(p.name).toBe('lmstudio')
  })

  it('builds correct request URL', () => {
    const p = new OpenAICompatProvider({ name: 'vllm', baseUrl: 'http://gpu-server:8000', apiKey: 'test-key' })
    expect(p.getCompletionsUrl()).toBe('http://gpu-server:8000/v1/chat/completions')
  })

  it('includes API key in headers when provided', () => {
    const p = new OpenAICompatProvider({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-xxx' })
    const headers = p.getHeaders()
    expect(headers['Authorization']).toBe('Bearer sk-xxx')
  })

  it('omits auth header when no API key', () => {
    const p = new OpenAICompatProvider({ name: 'local', baseUrl: 'http://localhost:8080', apiKey: '' })
    const headers = p.getHeaders()
    expect(headers['Authorization']).toBeUndefined()
  })
})
