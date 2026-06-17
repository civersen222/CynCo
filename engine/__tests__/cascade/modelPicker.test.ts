import { describe, expect, it } from 'bun:test'
import { classifyComplexity } from '../../cascade/modelPicker.js'

// ─── classifyComplexity ───────────────────────────────────────────

describe('classifyComplexity', () => {
  it('classifies short simple-keyword message with no tools as simple', () => {
    const result = classifyComplexity('show list of files', 0)
    expect(result).toBe('simple')
  })

  it('classifies message with complex keywords as complex', () => {
    const result = classifyComplexity('refactor the auth module', 0)
    expect(result).toBe('complex')
  })

  it('classifies long message as complex regardless of keywords', () => {
    const long = 'a'.repeat(250)
    const result = classifyComplexity(long, 0)
    expect(result).toBe('complex')
  })

  it('classifies message with 3+ tools as complex', () => {
    const result = classifyComplexity('update the config file', 3)
    expect(result).toBe('complex')
  })

  it('classifies medium message with no strong signals as moderate', () => {
    const result = classifyComplexity('update the config file', 1)
    expect(result).toBe('moderate')
  })
})
