/**
 * GGUF header reader — metadata only, never the tensors.
 *
 * Why: llama-server's checkpoint and KV costs are properties of the model's
 * ARCHITECTURE (how many layers keep a KV cache, how many keep a recurrent
 * state, how wide each is), and the header states all of them. Until now the
 * engine carried one affine fit measured on one model; a different GGUF got
 * the wrong budget silently. Ported in spirit from Quartermaster's gguf.go.
 *
 * Reads lazily from the file descriptor in 1 MiB steps: the header of a 20 GB
 * model is a few MiB (the tokenizer vocab is in there), so no whole-file read.
 */
import { openSync, readSync, closeSync, fstatSync } from 'fs'

export const GGUF_TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6,
  BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const

const SCALAR_BYTES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

export type GgufMeta = {
  architecture: string
  blockCount: number
  contextLength: number
  headCount: number
  headCountKv: number
  keyLength: number
  valueLength: number
  /** SWA window in tokens (gemma-style); 0 = no sliding window. */
  slidingWindow: number
  /** Every Nth layer is global when a window is set (llama.cpp default pattern 6). */
  slidingWinPattern: number
  /** Hybrid SSM (qwen35 / Qwen3.5-3.8): a full-attention layer every Nth; 0 = not hybrid. */
  fullAttnInterval: number
  ssmInnerSize: number
  ssmConvKernel: number
  ssmStateSize: number
  fileSizeBytes: number
}

class Cursor {
  private buf = Buffer.alloc(0)
  private filePos = 0 // file offset of buf[0]
  private pos = 0     // offset within buf
  constructor(private fd: number) {}
  private ensure(n: number): void {
    while (this.pos + n > this.buf.length) {
      const chunk = Buffer.alloc(1 << 20)
      const got = readSync(this.fd, chunk, 0, chunk.length, this.filePos + this.buf.length)
      if (got <= 0) throw new Error(`gguf: unexpected end of file at ${this.filePos + this.buf.length}`)
      this.buf = Buffer.concat([this.buf, chunk.subarray(0, got)])
    }
    // Drop consumed bytes so a multi-MB vocab does not pin the whole header.
    if (this.pos > (4 << 20)) {
      this.buf = this.buf.subarray(this.pos); this.filePos += this.pos; this.pos = 0
    }
  }
  u32(): number { this.ensure(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v }
  u64(): number { this.ensure(8); const v = Number(this.buf.readBigUInt64LE(this.pos)); this.pos += 8; return v }
  bytes(n: number): Buffer { this.ensure(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v }
  skip(n: number): void { this.ensure(n); this.pos += n }
  str(): string { const n = this.u64(); return this.bytes(n).toString('utf-8') }
  scalar(type: number): number | string | boolean {
    switch (type) {
      case GGUF_TYPE.UINT8: return this.bytes(1).readUInt8(0)
      case GGUF_TYPE.INT8: return this.bytes(1).readInt8(0)
      case GGUF_TYPE.UINT16: return this.bytes(2).readUInt16LE(0)
      case GGUF_TYPE.INT16: return this.bytes(2).readInt16LE(0)
      case GGUF_TYPE.UINT32: return this.u32()
      case GGUF_TYPE.INT32: return this.bytes(4).readInt32LE(0)
      case GGUF_TYPE.FLOAT32: return this.bytes(4).readFloatLE(0)
      case GGUF_TYPE.BOOL: return this.bytes(1).readUInt8(0) !== 0
      case GGUF_TYPE.STRING: return this.str()
      case GGUF_TYPE.UINT64: return this.u64()
      case GGUF_TYPE.INT64: return Number(this.bytes(8).readBigInt64LE(0))
      case GGUF_TYPE.FLOAT64: return this.bytes(8).readDoubleLE(0)
      default: throw new Error(`gguf: unknown value type ${type}`)
    }
  }
  /** Skip an array value entirely (tokenizer vocab, merges, per-layer arrays). */
  skipArray(): void {
    const elemType = this.u32()
    const n = this.u64()
    if (elemType === GGUF_TYPE.STRING) { for (let i = 0; i < n; i++) { const len = this.u64(); this.skip(len) } return }
    if (elemType === GGUF_TYPE.ARRAY) { for (let i = 0; i < n; i++) this.skipArray(); return }
    const w = SCALAR_BYTES[elemType]
    if (w == null) throw new Error(`gguf: unknown array element type ${elemType}`)
    this.skip(n * w)
  }
}

export function readGgufMeta(path: string): GgufMeta {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const c = new Cursor(fd)
    const magic = c.bytes(4).toString('ascii')
    if (magic !== 'GGUF') throw new Error(`gguf: bad magic ${JSON.stringify(magic)} in ${path}`)
    const version = c.u32()
    if (version < 2) throw new Error(`gguf: unsupported version ${version}`)
    c.u64() // tensor count — not needed
    const kvCount = c.u64()
    const kv = new Map<string, number | string | boolean>()
    for (let i = 0; i < kvCount; i++) {
      const key = c.str()
      const type = c.u32()
      if (type === GGUF_TYPE.ARRAY) { c.skipArray(); continue }
      kv.set(key, c.scalar(type))
    }
    const arch = String(kv.get('general.architecture') ?? '')
    const num = (k: string): number => { const v = kv.get(`${arch}.${k}`); return typeof v === 'number' ? v : 0 }
    return {
      architecture: arch,
      blockCount: num('block_count'),
      contextLength: num('context_length'),
      headCount: num('attention.head_count'),
      headCountKv: num('attention.head_count_kv'),
      keyLength: num('attention.key_length'),
      valueLength: num('attention.value_length'),
      slidingWindow: num('attention.sliding_window'),
      slidingWinPattern: num('attention.sliding_window_pattern'),
      fullAttnInterval: num('full_attention_interval'),
      ssmInnerSize: num('ssm.inner_size'),
      ssmConvKernel: num('ssm.conv_kernel'),
      ssmStateSize: num('ssm.state_size'),
      fileSizeBytes: size,
    }
  } finally {
    closeSync(fd)
  }
}
