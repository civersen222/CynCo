import { describe, expect, it } from 'bun:test'
import { brainEnabled } from '../../brain/brainSwitch.js'

describe('brainEnabled (LOCALCODE_BRAIN)', () => {
  it('is on by default and for anything but off', () => {
    expect(brainEnabled({})).toBe(true)
    expect(brainEnabled({ LOCALCODE_BRAIN: 'on' })).toBe(true)
    expect(brainEnabled({ LOCALCODE_BRAIN: 'anything' })).toBe(true)
    expect(brainEnabled({ LOCALCODE_BRAIN: '' })).toBe(true)
  })
  it('is off for off, in any case, with surrounding spaces', () => {
    expect(brainEnabled({ LOCALCODE_BRAIN: 'off' })).toBe(false)
    expect(brainEnabled({ LOCALCODE_BRAIN: 'OFF ' })).toBe(false)
    expect(brainEnabled({ LOCALCODE_BRAIN: ' Off' })).toBe(false)
  })
})
