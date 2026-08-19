import { describe, it, expect } from 'vitest'
import { createMissionCollector } from '../cynco-ledger.mjs'

/**
 * The verb classes exist because "delivery" measured as Edit+Write was
 * misleading: in 11N, Write outnumbered Edit 3:1 and nearly every Write was a
 * scratch file (base_realm.py, probe_*.py). Source edits and file creation are
 * different acts and must be counted separately.
 */
describe('toolStats verb classes', () => {
  it('counts source edits separately from writes and reads', () => {
    const c = createMissionCollector()
    for (const name of ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'Read']) {
      c.observeToolCall({ name, isError: false })
    }
    expect(c.toolStats.total).toBe(6)
    expect(c.toolStats.byClass.sourceEdit).toBe(1)
    expect(c.toolStats.byClass.fileWrite).toBe(1)
    expect(c.toolStats.byClass.inspect).toBe(4)
  })

  it('tracks the largest run of calls with no source edit', () => {
    const c = createMissionCollector()
    for (const name of ['Edit', 'Read', 'Read', 'Read', 'Edit', 'Read']) {
      c.observeToolCall({ name, isError: false })
    }
    // gaps between source edits: 0 (leading), 3, then a trailing run of 1
    expect(c.toolStats.maxCallsWithoutSourceEdit).toBe(3)
  })

  it('counts an unknown tool as inspect rather than dropping it', () => {
    const c = createMissionCollector()
    c.observeToolCall({ name: 'SomeFutureTool', isError: false })
    expect(c.toolStats.byClass.inspect).toBe(1)
    expect(c.toolStats.total).toBe(1)
  })
})
