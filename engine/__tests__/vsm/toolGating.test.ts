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

// F178: a batch the model fired together is one decision. The loop marks each
// model call with beginCall() before that call's tool batches; four Reads in one
// parallel batch (reading four files) used to count as four uses in a row and
// withhold Read from the next call. A caller that never marks a call (the tests
// above) counts every use, as before.
describe('ToolGating counts a tool once per model call (F178)', () => {
  let gating: ToolGating
  beforeEach(() => { gating = new ToolGating() })

  it('four of one tool in one model call are one use, not four in a row', () => {
    gating.beginCall()
    for (let i = 0; i < 4; i++) gating.recordTool('Read')
    expect(gating.getRestrictedTools()).toEqual([])
    gating.beginCall()
    for (let i = 0; i < 4; i++) gating.recordTool('Edit')
    expect(gating.getRestrictedTools()).toEqual([])
  })

  it('one tool in four model calls in a row is still attenuated, however many calls each batch held', () => {
    for (let call = 0; call < 3; call++) {
      gating.beginCall()
      gating.recordTool('Edit')
      gating.recordTool('Edit')
    }
    expect(gating.getRestrictedTools()).toEqual([])
    gating.beginCall()
    gating.recordTool('Edit')
    expect(gating.getRestrictedTools()).toEqual(['Edit'])
  })

  it('another tool resets the run, and the run counts model calls again from there', () => {
    for (let call = 0; call < 3; call++) {
      gating.beginCall()
      for (let i = 0; i < 3; i++) gating.recordTool('Edit')
    }
    gating.beginCall()
    gating.recordTool('Edit')
    gating.recordTool('Grep') // the same call: Grep ends the run of Edits
    expect(gating.getRestrictedTools()).toEqual([])
    for (let call = 0; call < 3; call++) {
      gating.beginCall()
      gating.recordTool('Edit')
      gating.recordTool('Edit')
    }
    expect(gating.getRestrictedTools()).toEqual([])
    gating.beginCall()
    gating.recordTool('Edit')
    expect(gating.getRestrictedTools()).toEqual(['Edit'])
  })

  it('a call records each tool once, at its first use, so another tool in that call ends the run', () => {
    // The overuse rule reads the last four recorded uses. A call records a tool
    // at its first use in that call, in the order the calls ran: [Edit] [Edit]
    // [Edit] [Edit, Bash, Edit] records Edit, Edit, Edit, Edit, Bash.
    for (let call = 0; call < 3; call++) {
      gating.beginCall()
      gating.recordTool('Edit')
    }
    gating.beginCall()
    gating.recordTool('Edit')
    gating.recordTool('Bash')
    gating.recordTool('Edit') // already recorded in this call: the last recorded use stays Bash
    expect(gating.getRestrictedTools()).toEqual([])
    for (let call = 0; call < 6; call++) {
      gating.beginCall()
      gating.recordTool('Edit')
      gating.recordTool('Bash')
      gating.recordTool('Edit')
    }
    expect(gating.getRestrictedTools()).toEqual([]) // Edit, Bash, Edit, Bash, …: never four of one
  })

  it('in a project chat Read is never attenuated; another tool still is, and a coding session still attenuates Read', () => {
    for (let call = 0; call < 6; call++) {
      gating.beginCall()
      gating.recordTool('Read')
    }
    expect(gating.getRestrictedTools({ projectChat: true })).toEqual([])
    expect(gating.getRestrictedTools({ projectChat: false })).toEqual(['Read'])
    expect(gating.getRestrictedTools()).toEqual(['Read'])
    for (let call = 0; call < 4; call++) {
      gating.beginCall()
      gating.recordTool('Edit')
    }
    expect(gating.getRestrictedTools({ projectChat: true })).toEqual(['Edit'])
  })

  it('in a project chat a stuck Read is not attenuated either', () => {
    gating.recordTool('Read')
    gating.recordStuckTurn('Read')
    gating.recordStuckTurn('Read')
    expect(gating.getRestrictedTools({ projectChat: true })).toEqual([])
    expect(gating.getRestrictedTools()).toEqual(['Read'])
  })
})
