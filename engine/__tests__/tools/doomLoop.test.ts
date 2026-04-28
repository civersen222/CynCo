import { describe, expect, it } from 'bun:test'
import { DoomLoopDetector } from '../../tools/doomLoop.js'

describe('DoomLoopDetector', () => {
  it('does not trigger on first call', () => {
    const d = new DoomLoopDetector(3)
    expect(d.check('Bash', 'echo hello', true)).toBe(false)
  })

  it('triggers after 3 consecutive failures of same tool+input', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'bun test', true)
    d.check('Bash', 'bun test', true)
    expect(d.check('Bash', 'bun test', true)).toBe(true)
  })

  it('resets on success', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'bun test', true)
    d.check('Bash', 'bun test', true)
    d.check('Bash', 'bun test', false) // success resets
    expect(d.check('Bash', 'bun test', true)).toBe(false)
  })

  it('tracks different tool+input combos independently', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'cmd1', true)
    d.check('Bash', 'cmd1', true)
    d.check('Bash', 'cmd2', true) // different input
    expect(d.check('Bash', 'cmd1', true)).toBe(true) // 3rd failure of cmd1
  })

  it('returns suggestion when doom loop detected', () => {
    const d = new DoomLoopDetector(3)
    d.check('Edit', 'same args', true)
    d.check('Edit', 'same args', true)
    d.check('Edit', 'same args', true)
    expect(d.getSuggestion()).toContain('repeated')
  })
})
