import { describe, it, expect } from 'vitest'
import { TurnNoveltyMeter } from '../../vsm/turnNovelty.js'

describe('TurnNoveltyMeter (P4.3)', () => {
  it('first turn touching only new paths → infoGain 1.0', () => {
    const m = new TurnNoveltyMeter()
    m.recordPath('src/a.ts')
    m.recordPath('src/b.ts')
    m.onTurnComplete()
    expect(m.snapshot().infoGain).toBe(1.0)
  })

  it('revisiting only known paths → infoGain 0', () => {
    const m = new TurnNoveltyMeter()
    m.recordPath('src/a.ts')
    m.onTurnComplete()
    m.recordPath('src/a.ts')
    m.onTurnComplete()
    expect(m.snapshot().infoGain).toBe(0)
  })

  it('mixed new + revisit → fractional gain', () => {
    const m = new TurnNoveltyMeter()
    m.recordPath('src/a.ts')
    m.onTurnComplete()
    m.recordPath('src/a.ts')
    m.recordPath('src/b.ts')
    m.onTurnComplete()
    expect(m.snapshot().infoGain).toBe(0.5)
  })

  it('turn with no paths → null (not zero)', () => {
    const m = new TurnNoveltyMeter()
    m.recordPath('src/a.ts')
    m.onTurnComplete()
    m.onTurnComplete()
    expect(m.snapshot().infoGain).toBeNull()
  })

  it('normalizes separators and case — same path, no false novelty', () => {
    const m = new TurnNoveltyMeter()
    m.recordPath('src\\A.ts')
    m.onTurnComplete()
    m.recordPath('src/a.ts')
    m.onTurnComplete()
    expect(m.snapshot().infoGain).toBe(0)
  })
})
