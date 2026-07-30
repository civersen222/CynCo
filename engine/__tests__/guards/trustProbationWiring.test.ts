import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ToolScorer } from '../../tools/toolScorer.js'

/**
 * BLOCKING wire-check: tool demotion must not be an absorbing state.
 *
 * `ToolScorer.load` already forgives a demoted tool, and its comment states the
 * reason precisely — an estimate no new evidence can reach is a verdict, not a
 * measurement. But it forgives at process start, and the unit of work here is a
 * session: one mission runs inside one session, so a tool withheld at iteration
 * 20 stays withheld through the end of the task.
 *
 * Measured on Gilded UI Wave 1. Bash reached 2 successes of 8 — confidence 0.30
 * against a 0.35 threshold — and `[trust] Demoted tools excluded: Bash` repeated
 * on 31 consecutive iterations with nothing able to bring it back. The task's own
 * contract assertion was "the verification command exits 0", which needs a shell.
 * (An earlier version of this comment added "and governance reported toolOK=1
 * throughout". That was false and written without measuring — the run's
 * governance lines carry both 1.00 and 0.95, so the failures WERE registered.
 * `getSuccessRate` is a 20-call window over ALL tools and has no vocabulary for
 * one broken tool; the per-tool signal, `ToolScorer`, caught it at 0.30.)
 *
 * The run also showed the exclusion is unenforced — Bash executed five times
 * inside that window, because the model can name a tool the advertised list
 * omitted and the executor runs it anyway. That gap is what kept the estimate
 * moving, so closing it without probation would create a real absorbing state.
 * Whether to enforce is a separate decision; the way back has to exist first.
 *
 * `excludeForIteration` has its own unit tests, and they would all pass if the
 * loop went on calling the pure `getDemotedTools` instead — which is the same
 * two-well-tested-halves failure that finding (ag) turned out to be. So the
 * connection is asserted here, at the source of the live path.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

describe('trust probation wiring guard', () => {
  it('the loop filters with the probation-advancing call, not the pure query', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    // The filter is fed by the advancing call...
    expect(src).toMatch(/const demoted = scorer \? new Set\(scorer\.excludeForIteration\(\)\)/)
    // ...and the set it produces is what gets removed from the tool list.
    expect(src).toMatch(/toolDefs\.filter\(t => !demoted\.has\(t\.name\)\)/)
  })

  /**
   * The advancing call must happen exactly once per iteration. Calling it twice
   * would double-count probation and halve the exclusion; calling it zero times
   * is the original defect. The pure query is still legitimate elsewhere — the
   * best-of-N metadata reports the set without deciding when a tool returns.
   */
  it('advances probation once per iteration and leaves the pure query for readers', () => {
    const src = read('engine/bridge/conversationLoop.ts')
    const advancing = src.match(/scorer\.excludeForIteration\(\)/g) ?? []
    expect(advancing.length).toBe(1)
    // The reporting reader stays side-effect free.
    expect(src).toMatch(/demotedTools: this\.executor\.getToolScorer\?\.\(\)\?\.getDemotedTools\(\)/)
  })

  /**
   * The behaviour itself, asserted against the real class rather than the source
   * text: a tool that is broken forever must still come back periodically, or
   * the mission it is running inside cannot recover.
   */
  it('a demoted tool is offered again within a single session', () => {
    const scorer = new ToolScorer()
    for (let i = 0; i < 5; i++) scorer.record('Bash', false)

    let offers = 0
    for (let i = 0; i < 40; i++) {
      if (!scorer.excludeForIteration().includes('Bash')) offers++
    }
    expect(offers).toBeGreaterThan(1)
  })
})
