import { describe, it, expect } from 'vitest'
import { buildConceptTable } from '../../vsm/groundingProbe.js'
import { extractAddedText, evaluateGrounding } from '../../vsm/groundingTrigger.js'

const TABLE = buildConceptTable([
  { path: 'city.py', content: 'self.happiness = 0\n' },
  { path: 'game.py', content: 'self.happiness = {}\nself.happiness_system = HS()\n' },
  { path: 'happiness_system.py', content: 'class HS: pass\n' },
])

describe('extractAddedText', () => {
  it('reads new_string from an Edit call', () => {
    expect(extractAddedText('Edit', { new_string: 'x = self.happiness' })).toBe('x = self.happiness')
  })
  it('reads content from a Write call', () => {
    expect(extractAddedText('Write', { content: 'a\nb' })).toBe('a\nb')
  })
  it('concatenates every new_string from a MultiEdit call', () => {
    const txt = extractAddedText('MultiEdit', { edits: [{ new_string: 'a' }, { new_string: 'b' }] })
    expect(txt).toBe('a\nb')
  })
  it('returns empty string for a non-edit tool', () => {
    expect(extractAddedText('Read', { file_path: 'x' })).toBe('')
  })
})

describe('evaluateGrounding — intensity scaling', () => {
  const ungrounded = { new_string: 'eff = raw * (self.happiness.get(o, 50) / 100.0)' }
  const grounded = { new_string: 'eff = raw * self.happiness_system.get_production_loss()' }

  it('skips a grounded edit at every intensity', () => {
    for (const i of [0, 1, 2, 3] as const) {
      expect(evaluateGrounding('Edit', grounded, TABLE, i).action).toBe('skip')
    }
  })

  it('skips an ungrounded edit at intensity 0 (easy)', () => {
    expect(evaluateGrounding('Edit', ungrounded, TABLE, 0).action).toBe('skip')
  })

  it('warns (non-blocking) at intensity 1', () => {
    const r = evaluateGrounding('Edit', ungrounded, TABLE, 1)
    expect(r.action).toBe('warn')
    expect(r.concepts).toEqual(['happiness'])
    expect(r.message).toContain('happiness_system')
  })

  it('blocks at intensity 2 and 3', () => {
    for (const i of [2, 3] as const) {
      const r = evaluateGrounding('Edit', ungrounded, TABLE, i)
      expect(r.action).toBe('block')
      expect(r.message).toContain('happiness_system')
      expect(r.message).toContain('happiness')
    }
  })

  it('skips a non-edit tool regardless of intensity', () => {
    expect(evaluateGrounding('Bash', { command: 'ls' }, TABLE, 3).action).toBe('skip')
  })
})
