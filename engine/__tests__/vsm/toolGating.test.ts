import { describe, expect, it, beforeEach } from 'bun:test'
import { ToolGating } from '../../vsm/toolGating.js'

describe('ToolGating', () => {
  let gating: ToolGating
  beforeEach(() => { gating = new ToolGating() })

  it('no restriction when tools are diverse', () => {
    gating.recordTool('Read')
    gating.recordTool('Edit')
    gating.recordTool('Bash')
    expect(gating.getRestrictedTools()).toEqual([])
  })

  it('restricts Read after 4 consecutive Read calls', () => {
    gating.recordTool('Read')
    gating.recordTool('Read')
    gating.recordTool('Read')
    gating.recordTool('Read')
    expect(gating.getRestrictedTools()).toContain('Read')
  })

  it('restricts last-used tool when stuck', () => {
    gating.recordTool('Edit')
    gating.recordStuckTurn('Edit')
    gating.recordStuckTurn('Edit')
    expect(gating.getRestrictedTools()).toContain('Edit')
  })

  it('clears restriction after different tool used', () => {
    gating.recordTool('Read')
    gating.recordTool('Read')
    gating.recordTool('Read')
    gating.recordTool('Read')
    expect(gating.getRestrictedTools()).toContain('Read')
    gating.recordTool('Grep')
    expect(gating.getRestrictedTools()).toEqual([])
  })

  it('never restricts essential tools', () => {
    for (let i = 0; i < 10; i++) gating.recordTool('Bash')
    expect(gating.getRestrictedTools()).not.toContain('Bash')
    for (let i = 0; i < 10; i++) gating.recordTool('Grep')
    expect(gating.getRestrictedTools()).not.toContain('Grep')
  })
})
