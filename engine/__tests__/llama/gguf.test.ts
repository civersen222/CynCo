/**
 * The checkpoint budget (--cache-ram) depends on the model's architecture, and
 * the GGUF header states it. These tests pin the reader against a synthetic
 * header shaped like Qwen3.8's (measured 2026-09-03) and, when the real file is
 * present, against the real header.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { readGgufMeta, GGUF_TYPE } from '../../llama/gguf.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

/** Minimal GGUF v3 writer: header + KV pairs, zero tensors. */
function ggufBytes(kv: Array<[string, number, unknown]>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const str = (s: string) => { const body = Buffer.from(s, 'utf-8'); return Buffer.concat([u64(body.length), body]) }
  parts.push(Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(kv.length))
  for (const [key, type, value] of kv) {
    parts.push(str(key), u32(type))
    switch (type) {
      case GGUF_TYPE.UINT32: parts.push(u32(value as number)); break
      case GGUF_TYPE.FLOAT32: { const b = Buffer.alloc(4); b.writeFloatLE(value as number); parts.push(b); break }
      case GGUF_TYPE.STRING: parts.push(str(value as string)); break
      case GGUF_TYPE.ARRAY: {
        // array of strings, the shape tokenizer.ggml.tokens takes
        const items = value as string[]
        parts.push(u32(GGUF_TYPE.STRING), u64(items.length), ...items.map(str))
        break
      }
      default: throw new Error(`test writer: unsupported type ${type}`)
    }
  }
  return Buffer.concat(parts)
}

describe('readGgufMeta', () => {
  it('reads the qwen35 hybrid dims from a synthetic header, skipping tokenizer arrays', () => {
    const d = mkdtempSync(join(tmpdir(), 'gguf-')); dirs.push(d)
    const p = join(d, 'm.gguf')
    writeFileSync(p, ggufBytes([
      ['general.architecture', GGUF_TYPE.STRING, 'qwen35'],
      ['tokenizer.ggml.tokens', GGUF_TYPE.ARRAY, ['a', 'b', 'c']],
      ['qwen35.block_count', GGUF_TYPE.UINT32, 65],
      ['qwen35.context_length', GGUF_TYPE.UINT32, 262144],
      ['qwen35.attention.head_count', GGUF_TYPE.UINT32, 24],
      ['qwen35.attention.head_count_kv', GGUF_TYPE.UINT32, 4],
      ['qwen35.attention.key_length', GGUF_TYPE.UINT32, 256],
      ['qwen35.attention.value_length', GGUF_TYPE.UINT32, 256],
      ['qwen35.rope.freq_base', GGUF_TYPE.FLOAT32, 10000000],
      ['qwen35.full_attention_interval', GGUF_TYPE.UINT32, 4],
      ['qwen35.ssm.inner_size', GGUF_TYPE.UINT32, 6144],
      ['qwen35.ssm.conv_kernel', GGUF_TYPE.UINT32, 4],
      ['qwen35.ssm.state_size', GGUF_TYPE.UINT32, 128],
    ]))
    const m = readGgufMeta(p)
    expect(m.architecture).toBe('qwen35')
    expect(m.blockCount).toBe(65)
    expect(m.headCountKv).toBe(4)
    expect(m.keyLength).toBe(256)
    expect(m.valueLength).toBe(256)
    expect(m.fullAttnInterval).toBe(4)
    expect(m.ssmInnerSize).toBe(6144)
    expect(m.ssmConvKernel).toBe(4)
    expect(m.ssmStateSize).toBe(128)
    expect(m.contextLength).toBe(262144)
    expect(m.slidingWindow).toBe(0)
    expect(m.fileSizeBytes).toBeGreaterThan(0)
  })

  it('leaves absent dims at 0 instead of guessing', () => {
    const d = mkdtempSync(join(tmpdir(), 'gguf-')); dirs.push(d)
    const p = join(d, 'dense.gguf')
    writeFileSync(p, ggufBytes([
      ['general.architecture', GGUF_TYPE.STRING, 'llama'],
      ['llama.block_count', GGUF_TYPE.UINT32, 32],
      ['llama.attention.head_count_kv', GGUF_TYPE.UINT32, 8],
      ['llama.attention.key_length', GGUF_TYPE.UINT32, 128],
      ['llama.attention.value_length', GGUF_TYPE.UINT32, 128],
    ]))
    const m = readGgufMeta(p)
    expect(m.fullAttnInterval).toBe(0)
    expect(m.ssmInnerSize).toBe(0)
    expect(m.slidingWindow).toBe(0)
  })

  it('rejects a file that is not GGUF', () => {
    const d = mkdtempSync(join(tmpdir(), 'gguf-')); dirs.push(d)
    const p = join(d, 'x.gguf'); writeFileSync(p, 'not a gguf at all')
    expect(() => readGgufMeta(p)).toThrow(/magic/)
  })

  const real = join(homedir(), '.cynco', 'models', 'qwen3.8-27b-nvfp4', 'Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf')
  it.skipIf(!existsSync(real))('reads the real Qwen3.8 header (measured 2026-09-03)', () => {
    const m = readGgufMeta(real)
    expect(m.architecture).toBe('qwen35')
    expect(m.blockCount).toBe(65)
    expect(m.headCountKv).toBe(4)
    expect(m.fullAttnInterval).toBe(4)
    expect(m.ssmInnerSize).toBe(6144)
  })
})
