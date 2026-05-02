// engine/__tests__/llama/modelResolver.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveModel, resolveAdapter } from '../../llama/modelResolver.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('resolveModel', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns explicit MODEL_PATH when set', () => {
    const ggufPath = path.join(tmpDir, 'my-model.gguf')
    fs.writeFileSync(ggufPath, 'fake-gguf')
    const result = resolveModel('anything', tmpDir, ggufPath)
    expect(result).toBe(ggufPath)
  })

  it('throws if explicit MODEL_PATH does not exist', () => {
    expect(() => resolveModel('x', tmpDir, '/nonexistent/model.gguf'))
      .toThrow('does not exist')
  })

  it('finds GGUF in model subdirectory', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    const ggufPath = path.join(modelDir, 'qwen3.6-Q4_K_M.gguf')
    fs.writeFileSync(ggufPath, 'x'.repeat(100))
    const result = resolveModel('qwen3.6', tmpDir)
    expect(result).toBe(ggufPath)
  })

  it('picks largest GGUF when multiple exist', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    const small = path.join(modelDir, 'qwen3.6-Q2_K.gguf')
    const large = path.join(modelDir, 'qwen3.6-Q4_K_M.gguf')
    fs.writeFileSync(small, 'x'.repeat(50))
    fs.writeFileSync(large, 'x'.repeat(200))
    const result = resolveModel('qwen3.6', tmpDir)
    expect(result).toBe(large)
  })

  it('throws ModelNotFoundError when no GGUF found', () => {
    expect(() => resolveModel('nonexistent', tmpDir))
      .toThrow("No GGUF found for 'nonexistent'")
  })

  it('throws when model dir exists but has no GGUF files', () => {
    const modelDir = path.join(tmpDir, 'empty-model')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'readme.txt'), 'not a gguf')
    expect(() => resolveModel('empty-model', tmpDir))
      .toThrow("No GGUF found for 'empty-model'")
  })
})

describe('resolveAdapter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-adapter-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves adapter by name', () => {
    const adapterPath = path.join(tmpDir, 's3-lora.gguf')
    fs.writeFileSync(adapterPath, 'fake-adapter')
    const result = resolveAdapter('s3-lora', tmpDir)
    expect(result).toBe(adapterPath)
  })

  it('throws AdapterNotFoundError when missing', () => {
    expect(() => resolveAdapter('nonexistent', tmpDir))
      .toThrow("LoRA adapter 'nonexistent' not found")
  })
})
