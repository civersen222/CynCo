/**
 * C3 wiring tests — toolGating applied as a final pure narrowing gate after
 * S5 picks the tool list. Exercises the exact narrowing contract used in
 * runModelLoop(): drop overused tools, but never starve the model.
 */

import { describe, expect, it } from 'bun:test'
import { ToolGating, applyToolGate } from '../../vsm/toolGating.js'

const tools = (...names: string[]) => names.map(name => ({ name, description: '', input_schema: {} }))

describe('applyToolGate (final narrowing)', () => {
  it('removes restricted tools from the offered set', () => {
    const out = applyToolGate(tools('Read', 'Edit', 'Bash'), ['Edit'])
    expect(out.map(t => t.name)).toEqual(['Read', 'Bash'])
  })

  it('is a no-op when nothing is restricted', () => {
    const offered = tools('Read', 'Edit')
    expect(applyToolGate(offered, [])).toBe(offered)
  })

  it('never returns an empty set — keeps original if all would be removed', () => {
    const offered = tools('Edit')
    expect(applyToolGate(offered, ['Edit'])).toBe(offered)
  })

  it('only narrows, never adds a tool not in the offered set', () => {
    const out = applyToolGate(tools('Read', 'Write'), ['Write'])
    expect(out.map(t => t.name)).toEqual(['Read'])
  })
})

describe('ToolGating drives the gate after repeated tool use', () => {
  it('a tool overused 4× becomes restricted and is gated out', () => {
    const gating = new ToolGating()
    for (let i = 0; i < 4; i++) gating.recordTool('Edit')

    const restricted = gating.getRestrictedTools()
    expect(restricted).toContain('Edit')

    const gated = applyToolGate(tools('Read', 'Edit', 'Bash'), restricted)
    expect(gated.map(t => t.name)).toEqual(['Read', 'Bash'])
  })
})
