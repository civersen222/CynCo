/**
 * What one llama-server context checkpoint costs in host memory, as a function
 * of the model's architecture — the number `--cache-ram` is derived from.
 *
 * A checkpoint is affine in the tokens it covers: a ctx-independent part (the
 * recurrent state of every SSM layer in a hybrid model, plus the window-sized
 * KV of every sliding-window layer) and a per-token part. Both come straight
 * from the GGUF header. Validated 2026-09-03 against the values processManager
 * carried from measurement (F91 write-up): Qwen3.8-27B derives 150.45 MiB +
 * 4.00 KiB/token against 149.65 + 4.02 measured from llama-server's own
 * `created context checkpoint` lines.
 *
 * The per-token term is ONE global-attention layer's f16 KV per token — the
 * relation the Qwen3.8 measurement shows (4096 B vs 4.02 KiB). It is an
 * empirical relation, not a derivation from llama.cpp's source, which is why
 * checkpointCalibration.ts watches the live server and corrects this model
 * when reality disagrees (F89: never invented, always measured).
 */
import type { GgufMeta } from './gguf.js'

export type CheckpointCostModel = {
  baseMib: number
  kibPerToken: number
  source: 'gguf' | 'measured-default' | 'calibrated'
  detail: string
  globalLayers: number
  localLayers: number
  ssmLayers: number
}

/** The constants processManager.ts carried before this module, measured on Qwen3.8-27B-NVFP4-MTP. */
export const MEASURED_DEFAULT_COST: CheckpointCostModel = {
  baseMib: 149.65,
  kibPerToken: 4.02,
  source: 'measured-default',
  detail: 'affine fit of three llama-server checkpoint lines on Qwen3.8-27B (2026-08-18)',
  globalLayers: 0, localLayers: 0, ssmLayers: 0,
}

const MIB = 2 ** 20

export function checkpointCostFromMeta(meta: GgufMeta, kvBytesPerElem = 2): CheckpointCostModel {
  const missing: string[] = []
  if (meta.blockCount <= 0) missing.push('block_count')
  if (meta.headCountKv <= 0) missing.push('attention.head_count_kv')
  if (meta.keyLength <= 0) missing.push('attention.key_length')
  if (meta.valueLength <= 0) missing.push('attention.value_length')
  if (missing.length) {
    return { ...MEASURED_DEFAULT_COST, detail: `header lacks ${missing.join(', ')}; using the measured default` }
  }
  const perTokenLayerBytes = meta.headCountKv * (meta.keyLength + meta.valueLength) * kvBytesPerElem
  const pattern = meta.slidingWinPattern > 0 ? meta.slidingWinPattern : 6
  let globalLayers = 0, localLayers = 0, ssmLayers = 0
  let constBytes = 0
  for (let i = 0; i < meta.blockCount; i++) {
    if (meta.fullAttnInterval > 0 && ((i + 1) % meta.fullAttnInterval) !== 0) { ssmLayers++; continue }
    const isGlobal = meta.slidingWindow <= 0 || ((i + 1) % pattern) === 0
    if (isGlobal) globalLayers++
    else { localLayers++; constBytes += perTokenLayerBytes * meta.slidingWindow }
  }
  if (ssmLayers > 0 && meta.ssmInnerSize > 0) {
    const recElems = meta.ssmInnerSize * meta.ssmStateSize + meta.ssmInnerSize * Math.max(0, meta.ssmConvKernel - 1)
    constBytes += ssmLayers * recElems * 4 // recurrent state is f32
  }
  return {
    baseMib: constBytes / MIB,
    kibPerToken: perTokenLayerBytes / 1024,
    source: 'gguf',
    detail: `${meta.architecture}: ${globalLayers} global-attention, ${localLayers} sliding-window, ${ssmLayers} recurrent layers; kv_heads=${meta.headCountKv} k=${meta.keyLength} v=${meta.valueLength}`,
    globalLayers, localLayers, ssmLayers,
  }
}

/** Host memory one checkpoint costs at the far end of a `ctxSize` window. */
export function worstCheckpointMib(ctxSize: number, model: CheckpointCostModel): number {
  return model.baseMib + (ctxSize * model.kibPerToken) / 1024
}

/**
 * The `--cache-ram` budget (MiB) a context and checkpoint count require: one
 * complete slot's worth of checkpoints, rounded up to whole GiB, never below
 * 1 GiB. Moved here from processManager.ts unchanged in shape; the cost model
 * is now an input instead of two file-level constants.
 */
export function derivedCacheRamMib(ctxSize: number, ctxCheckpoints: number, model: CheckpointCostModel): number {
  const totalMib = worstCheckpointMib(ctxSize, model) * ctxCheckpoints
  return Math.max(1024, Math.ceil(totalMib / 1024) * 1024)
}
