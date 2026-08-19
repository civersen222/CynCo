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

describe('commit cadence', () => {
  it('records the longest run of calls with no new commit', () => {
    const c = createMissionCollector()
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeToolCall({ name: 'Bash', isError: false })
    c.observeCommit('aaaaaaa')       // two calls elapsed before the first commit
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeToolCall({ name: 'Read', isError: false })
    c.observeCommit('bbbbbbb')       // three since
    expect(c.toolStats.commits).toBe(2)
    expect(c.toolStats.maxCallsWithoutCommit).toBe(3)
  })

  it('ignores a repeated HEAD — polling must not invent commits', () => {
    const c = createMissionCollector()
    c.observeCommit('aaaaaaa')
    c.observeCommit('aaaaaaa')
    expect(c.toolStats.commits).toBe(1)
  })

  /**
   * The dispatch baseline is the one HEAD the mission did NOT make. Without
   * this seam the driver's very first poll hands `observeCommit` a sha it has
   * never seen and every mission in the ledger reports `commits: 1` — a
   * fabricated delivery, which is a worse failure than the hard 0 this task
   * exists to remove.
   */
  it('does not count the pre-existing HEAD the mission was dispatched on', () => {
    const c = createMissionCollector()
    c.seedBaselineHead('aaaaaaa')
    c.observeCommit('aaaaaaa')
    expect(c.toolStats.commits).toBe(0)
    c.observeCommit('bbbbbbb')
    expect(c.toolStats.commits).toBe(1)
  })

  it('leaves the baseline unseeded when HEAD could not be read', () => {
    // gitHead() returns null rather than guessing. Seeding null must not pin
    // _lastHead to a falsy value that then swallows the first real commit.
    const c = createMissionCollector()
    c.seedBaselineHead(null)
    c.observeCommit('aaaaaaa')
    expect(c.toolStats.commits).toBe(1)
  })

  it('counts a commit that lands with no tool calls between polls', () => {
    const c = createMissionCollector()
    c.observeCommit('aaaaaaa')
    c.observeCommit('bbbbbbb')
    expect(c.toolStats.commits).toBe(2)
    expect(c.toolStats.maxCallsWithoutCommit).toBe(0)
  })
})
