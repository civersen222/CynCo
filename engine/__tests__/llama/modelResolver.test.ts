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

  it('strips Ollama tag from model name (qwen3.6:latest → qwen3.6)', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    const ggufPath = path.join(modelDir, 'qwen3.6-Q4_K_M.gguf')
    fs.writeFileSync(ggufPath, 'x'.repeat(100))
    const result = resolveModel('qwen3.6:latest', tmpDir)
    expect(result).toBe(ggufPath)
  })

  it('uses model_file exactly when provided', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6-27b-q6k')
    fs.mkdirSync(modelDir, { recursive: true })
    const wanted = path.join(modelDir, 'Qwen3.6-27B-Q6_K.gguf')
    const other = path.join(modelDir, 'Qwen3.6-35B-Q4_K_M.gguf')
    fs.writeFileSync(wanted, 'x'.repeat(50))
    fs.writeFileSync(other, 'x'.repeat(200)) // larger — must NOT be chosen
    const result = resolveModel('qwen3.6-27b-q6k', tmpDir, undefined, 'Qwen3.6-27B-Q6_K.gguf')
    expect(result).toBe(wanted)
  })

  it('throws when model_file is given but missing', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6-27b-q6k')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'something-else.gguf'), 'x')
    expect(() => resolveModel('qwen3.6-27b-q6k', tmpDir, undefined, 'Qwen3.6-27B-Q6_K.gguf'))
      .toThrow('Qwen3.6-27B-Q6_K.gguf')
  })

  it('throws and lists candidates when multiple ggufs and no model_file', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'a-Q2_K.gguf'), 'x'.repeat(50))
    fs.writeFileSync(path.join(modelDir, 'b-Q4_K_M.gguf'), 'x'.repeat(200))
    expect(() => resolveModel('qwen3.6', tmpDir))
      .toThrow(/multiple .gguf|set model_file/i)
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
