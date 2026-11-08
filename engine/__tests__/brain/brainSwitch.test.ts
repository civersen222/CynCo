import { describe, expect, it } from 'bun:test'
import { brainEnabled, lensEnabled } from '../../brain/brainSwitch.js'

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

describe('lensEnabled (LOCALCODE_JLENS)', () => {
  it('is OFF by default; only on turns it on', () => {
    expect(lensEnabled({})).toBe(false)
    expect(lensEnabled({ LOCALCODE_JLENS: 'off' })).toBe(false)
    expect(lensEnabled({ LOCALCODE_JLENS: 'on' })).toBe(true)
    expect(lensEnabled({ LOCALCODE_JLENS: ' ON ' })).toBe(true)
    expect(lensEnabled({ LOCALCODE_JLENS: 'yes' })).toBe(false)
  })
})
