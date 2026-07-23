import { describe, it, expect } from 'vitest'
import { ReadLoopGate } from '../../vsm/readLoopGate.js'

describe('ReadLoopGate escalation', () => {
  it('escalates after 3 consecutive denials of the same signature', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    expect(g.evaluate('Read', inp).kind).toBe('allow')   // first read: seen
    expect(g.evaluate('Read', inp).kind).toBe('warn')    // 1st redundant
    expect(g.evaluate('Read', inp).kind).toBe('deny')    // 2nd
    expect(g.evaluate('Read', inp).kind).toBe('deny')    // 3rd
    const v = g.evaluate('Read', inp)                    // 4th → escalate
    expect(v.kind).toBe('escalate')
    if (v.kind === 'escalate') expect(v.signatures.length).toBeGreaterThan(0)
  })

  it('isDisabled reflects whether a read would be denied', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    g.evaluate('Read', inp); g.evaluate('Read', inp) // now in deny mode for this sig
    expect(g.isDisabled('Read', inp)).toBe(true)
    expect(g.isDisabled('Write', { file_path: 'C:/x/a.txt' })).toBe(false)
  })

  it('onWrite resets escalation', () => {
    const g = new ReadLoopGate()
    const inp = { file_path: 'C:/x/a.txt' }
    g.evaluate('Read', inp); g.evaluate('Read', inp); g.evaluate('Read', inp); g.evaluate('Read', inp)
    g.onWrite()
    expect(g.evaluate('Read', { file_path: 'C:/x/b.txt' }).kind).toBe('allow')
  })
})
