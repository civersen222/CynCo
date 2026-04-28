import { describe, expect, it } from 'bun:test'
import {
  ConnectionError, ModelNotFoundError, ModelLoadError,
  TimeoutError, GenerationError, isConnectionError,
} from '../../ollama/errors.js'

describe('errors', () => {
  it('ConnectionError has helpful message', () => {
    const err = new ConnectionError('http://localhost:11434')
    expect(err.message).toContain('Cannot connect to Ollama')
    expect(err.message).toContain('ollama serve')
    expect(err.name).toBe('ConnectionError')
  })

  it('ModelNotFoundError lists available models', () => {
    const err = new ModelNotFoundError('qwen3:32b', ['llama3.1:8b', 'phi4:14b'])
    expect(err.message).toContain('qwen3:32b')
    expect(err.message).toContain('llama3.1:8b')
    expect(err.message).toContain('ollama pull qwen3:32b')
  })

  it('ModelLoadError mentions reason', () => {
    const err = new ModelLoadError('qwen3:70b', 'out of memory')
    expect(err.message).toContain('qwen3:70b')
    expect(err.message).toContain('out of memory')
  })

  it('TimeoutError has duration', () => {
    const err = new TimeoutError(120000)
    expect(err.message).toContain('120000')
  })

  it('GenerationError wraps cause', () => {
    const err = new GenerationError('invalid JSON', { cause: new Error('parse') })
    expect(err.message).toContain('invalid JSON')
  })

  it('isConnectionError type guard works', () => {
    expect(isConnectionError(new ConnectionError('http://localhost:11434'))).toBe(true)
    expect(isConnectionError(new Error('random'))).toBe(false)
  })
})
