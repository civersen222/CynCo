import { describe, it, expect } from 'vitest'
import { vsm } from '../cybernetics-core/src/index.js'

describe('VSM axiom checks', () => {
  it('checkAxiom1 balanced varieties', () => {
    expect(vsm.checkAxiom1(10, 10, 0.2)).toBe(true)
  })
  it('checkAxiom1 imbalanced varieties', () => {
    expect(vsm.checkAxiom1(100, 10, 0.2)).toBe(false)
  })
  it('checkAxiom2 S3/S4 balance', () => {
    expect(vsm.checkAxiom2(5, 5, 0.2)).toBe(true)
  })
  it('checkPrinciple2 channel capacity', () => {
    expect(vsm.checkPrinciple2(100, 50)).toBe(true)
    expect(vsm.checkPrinciple2(10, 50)).toBe(false)
  })
})
