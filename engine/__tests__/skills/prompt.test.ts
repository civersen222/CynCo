import { describe, expect, it } from 'bun:test'
import { formatSkillIndexBlock } from '../../skills/prompt.js'
import type { SkillIndexEntry } from '../../skills/types.js'

const INDEX: SkillIndexEntry[] = [
  { name: 'tdd', description: 'Test-driven development loop', source: 'builtin' },
  { name: 'my-helper', description: 'A user helper', source: 'workspace' },
]

describe('formatSkillIndexBlock', () => {
  it('returns null when there are no skills', () => {
    expect(formatSkillIndexBlock([])).toBeNull()
  })

  it('lists every skill name and description', () => {
    const block = formatSkillIndexBlock(INDEX)!
    expect(block).toContain('tdd')
    expect(block).toContain('Test-driven development loop')
    expect(block).toContain('my-helper')
    expect(block).toContain('run_skill')
  })

  it('is deterministic (byte-identical across calls) for prefix stability', () => {
    expect(formatSkillIndexBlock(INDEX)).toBe(formatSkillIndexBlock(INDEX))
  })

  it('orders entries by name so store insertion order cannot perturb the prefix', () => {
    const a = formatSkillIndexBlock(INDEX)!
    const b = formatSkillIndexBlock([...INDEX].reverse())!
    expect(a).toBe(b)
  })
})
