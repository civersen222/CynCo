/**
 * `meanDepth` is a LAYER INDEX, and the ledger README must never illustrate it
 * as a fraction.
 *
 * Found by the Phase 2 live smoke (F149): the README's `turns[].brain` and
 * `brainStats` examples carried `"meanDepth": 0.4` / `0.37`, sitting beside
 * `meanAgree`, which IS a fraction. The real row the smoke wrote reads 53.55 —
 * `convergenceOf` (engine/brain/layerConvergence.ts) returns the SHALLOWEST
 * probed layer that already agrees with the deepest one, falling back to the
 * deepest layer itself. Anyone reading the documented example would have read a
 * measured 53.55 as a broken agreement ratio of 5355 %.
 *
 * So: every `meanDepth` the README prints must lie inside the probed-layer
 * range, which no fraction can.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const README = join(process.cwd(), 'benchmark', 'cynco-ledger', 'README.md')
// engine/brain/activationsConsumer.ts's LLAMA_ACTIVATIONS_LAYERS default.
const SHALLOWEST_PROBE = 24
const DEEPEST_PROBE = 56

describe('ledger README: meanDepth is a layer index', () => {
  const text = readFileSync(README, 'utf-8')
  const values = [...text.matchAll(/"meanDepth"\s*:\s*([0-9.]+)/g)].map(m => Number(m[1]))

  it('documents meanDepth at all', () => {
    expect(values.length, 'no "meanDepth" example in the ledger README').toBeGreaterThan(0)
  })

  it('never prints a meanDepth outside the probed-layer range', () => {
    const bad = values.filter(v => !(v >= SHALLOWEST_PROBE && v <= DEEPEST_PROBE))
    expect(bad, `meanDepth is a layer index in [${SHALLOWEST_PROBE}, ${DEEPEST_PROBE}], ` +
      `not a fraction — these examples are out of range: ${bad.join(', ')}`).toEqual([])
  })

  it('says in words that it is a layer index', () => {
    expect(text).toMatch(/`meanDepth` is a LAYER INDEX/)
  })
})
