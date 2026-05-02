import { describe, expect, it } from 'bun:test'
import {
  BinaryNotFoundError,
  ModelNotFoundError,
  ServerStartError,
  AdapterNotFoundError,
  isBinaryNotFoundError,
  isModelNotFoundError,
} from '../../llama/errors.js'

describe('llama errors', () => {
  it('BinaryNotFoundError includes resolution paths', () => {
    const err = new BinaryNotFoundError(['/a/llama-server', '/b/llama-server'])
    expect(err.message).toContain('llama-server')
    expect(err.message).toContain('/a/llama-server')
    expect(err.searchedPaths).toHaveLength(2)
    expect(err.name).toBe('BinaryNotFoundError')
  })

  it('ModelNotFoundError includes model name and directory', () => {
    const err = new ModelNotFoundError('qwen3.6', '/home/user/.cynco/models/qwen3.6')
    expect(err.message).toContain('qwen3.6')
    expect(err.message).toContain('.cynco/models')
    expect(err.model).toBe('qwen3.6')
    expect(err.name).toBe('ModelNotFoundError')
  })

  it('ServerStartError includes port and reason', () => {
    const err = new ServerStartError(8081, 'CUDA not found')
    expect(err.message).toContain('8081')
    expect(err.message).toContain('CUDA not found')
    expect(err.port).toBe(8081)
    expect(err.name).toBe('ServerStartError')
  })

  it('AdapterNotFoundError includes adapter name', () => {
    const err = new AdapterNotFoundError('s3-lora', '/home/user/.cynco/adapters/s3-lora.gguf')
    expect(err.message).toContain('s3-lora')
    expect(err.adapterName).toBe('s3-lora')
    expect(err.name).toBe('AdapterNotFoundError')
  })

  it('type guards work', () => {
    const binErr = new BinaryNotFoundError([])
    const modelErr = new ModelNotFoundError('x', '/y')
    expect(isBinaryNotFoundError(binErr)).toBe(true)
    expect(isBinaryNotFoundError(modelErr)).toBe(false)
    expect(isModelNotFoundError(modelErr)).toBe(true)
    expect(isModelNotFoundError(new Error('nope'))).toBe(false)
  })
})
