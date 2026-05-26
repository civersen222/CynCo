import { describe, it, expect } from 'vitest'
import { Severity, classifySeverity } from '../cybernetics-core/src/index.js'

describe('algedonic upgrade — formal severity', () => {
  it('classifySeverity returns correct levels', () => {
    expect(classifySeverity(0.1)).toBe(Severity.Low)
    expect(classifySeverity(0.4)).toBe(Severity.Moderate)
    expect(classifySeverity(0.7)).toBe(Severity.High)
    expect(classifySeverity(0.95)).toBe(Severity.Critical)
  })
})
