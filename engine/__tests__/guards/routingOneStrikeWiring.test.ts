import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { shouldUseRouting, setRoutingEnabled } from '../../tools/toolRouter.js'

/**
 * BLOCKING wire-check: the two-stage tool router must be asked at most once per
 * session, not once per iteration.
 *
 * Stage 1 sends only `select_category`. If the model calls it, the stage-2 tool
 * list is narrowed and the saving is roughly the omitted schemas — on the order
 * of 2000 tokens, about 1s at the measured ~0.5 ms/token prefill. If the model
 * ignores it, the loop falls through to the full tool list and the stage-1 call
 * bought nothing while costing a full prefill of the whole conversation plus a
 * full generation.
 *
 * Measured on the Gilded UI Wave 1 run (96 model calls): 56 stage-1 calls,
 * 75,184 prompt tokens and 5,205 generated tokens, 175.4s of model time — 32% of
 * the run — and `[routing] Category selected` printed ZERO times. The fall-through
 * was silent, so the loss repeated every iteration for the whole run.
 *
 * The realistic regression is not deleting the guard but resetting the flag: a
 * per-iteration `routingDeclined = false` restores the old behaviour while the
 * guard expression still reads correctly. So this asserts the flag is set once
 * and never cleared, in addition to being consulted.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const src = readFileSync(join(repoRoot, 'engine/bridge/conversationLoop.ts'), 'utf-8')

describe('two-stage routing one-strike wiring guard', () => {
  it('the stage-1 call is guarded by the declined flag', () => {
    const cond = src.match(/if \([^)]*shouldUseRouting\([^)]*\)[^)]*\) \{/)
    expect(cond, 'the shouldUseRouting call site moved or changed shape').not.toBeNull()
    expect(cond![0]).toContain('!this.routingDeclined')
  })

  it('an ignored selector sets the flag', () => {
    expect(src).toContain('this.routingDeclined = true')
  })

  it('nothing clears the flag, so one refusal lasts the session', () => {
    // The declaration initialises it; any OTHER assignment to false would make
    // the guard true again on the next iteration and restore the 32% loss.
    const resets = [...src.matchAll(/(?<!private )routingDeclined\s*=\s*false/g)]
    expect(
      resets.length,
      'routingDeclined is assigned false somewhere — a per-iteration reset defeats the guard while leaving it readable',
    ).toBe(0)
    expect(src).toMatch(/private routingDeclined = false/)
  })

  it('routing is attempted at all for the local context sizes we run', () => {
    // If this ever goes false by default, the guard above is dead code and the
    // measurement that motivated it no longer applies — fail loudly rather than
    // leave a test that passes for the wrong reason.
    setRoutingEnabled(null)
    expect(shouldUseRouting(65536)).toBe(true)
    expect(shouldUseRouting(32768)).toBe(true)
  })
})
