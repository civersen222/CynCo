import { describe, it, expect } from 'vitest'
import { homeostat } from '../cybernetics-core/src/index.js'

describe('homeostat upgrade — Beer time constants', () => {
  it('timeConstantForLevel returns increasing constants per level', () => {
    const tc1 = homeostat.timeConstantForLevel(1)
    const tc3 = homeostat.timeConstantForLevel(3)
    const tc5 = homeostat.timeConstantForLevel(5)
    expect(tc3).toBeGreaterThan(tc1)
    expect(tc5).toBeGreaterThan(tc3)
  })

  it('calculateBalance returns a result object', () => {
    const result = homeostat.calculateBalance(0.5, 0.5)
    expect(result).toHaveProperty('balance')
    expect(result).toHaveProperty('ratio')
  })
})
