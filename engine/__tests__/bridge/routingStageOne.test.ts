import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { makeLoop } from '../projects/loopScaffold.js'
import { setRoutingEnabled, TOOL_CATEGORIES } from '../../tools/toolRouter.js'

/**
 * Two-stage tool routing, end to end: stage 1 offers only `select_category`;
 * when the model calls it, stage 2 offers only that category's tools.
 *
 * The stage-1 loop used to test `evt.type === 'tool_use'` on the events
 * `localCallModel` yields, which are only 'stream_event' | 'assistant' |
 * 'system'. The branch was unreachable, so a model that DID call the selector
 * was read as having ignored it, `routingDeclined` was set, and the stage-1
 * call was paid for nothing — once per session after the one-strike guard,
 * every iteration before it (routingOneStrikeWiring.test.ts records 56 such
 * calls, 32% of a wave's model time, "Category selected" printed zero times).
 * Found by the strict type-check (A1): a comparison with no overlap.
 */
const cwds: string[] = []
afterEach(() => setRoutingEnabled(null))
afterAll(() => { for (const d of cwds) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

describe('two-stage routing', () => {
  it('a select_category call narrows stage 2 to that category', async () => {
    setRoutingEnabled(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { loop, calls, cwd } = makeLoop({
        model: 'qwen3.8',
        script: [
          [{ type: 'tool_use', name: 'select_category', input: { category: 'read' } }],
          [{ type: 'text', text: 'done' }],
        ],
      })
      cwds.push(cwd)
      await loop.handleUserMessage('what is in this folder?')

      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[0].tools.map(t => t.name)).toEqual(['select_category'])
      const stage2 = calls[1].tools.map(t => t.name)
      // Routing narrows to the category; the contract tool floor then restores
      // what enforcement needs (Bash, ContractAssert*) — governance over a
      // heuristic, by design (applyToolFloor). So: the read tools survive, the
      // write tools do not, and whatever else is there came back through the floor.
      for (const n of ['Read', 'Grep', 'Glob']) expect(stage2, `stage 2 lost ${n}`).toContain(n)
      for (const n of TOOL_CATEGORIES.write) expect(stage2, `stage 2 still offers ${n}`).not.toContain(n)
      expect(log.mock.calls.some(c => String(c[0]).includes('[routing] Category selected: read'))).toBe(true)
      // Any later stage-1 call runs off the end of the script and answers "done"
      // without the selector, which rightly trips the one-strike guard — so the
      // absence of that line is not asserted here; routingOneStrikeWiring pins it.
    } finally {
      log.mockRestore()
    }
  }, 30000)
})
