import { describe, it, expect } from 'vitest'
import { ToolDivergenceDetector } from '../../brain/toolDivergence.js'

describe('ToolDivergenceDetector', () => {
  it('flags a confident emission of a disabled tool', () => {
    const d = new ToolDivergenceDetector()
    // seed the running distribution with some spread
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    const verdict = d.check({ tool: 'Read', entropy: 0.05, isDisabled: true })
    expect(verdict.diverged).toBe(true)
    expect(verdict.tool).toBe('Read')
  })

  it('does NOT flag a confident emission of an allowed tool', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    expect(d.check({ tool: 'Write', entropy: 0.05, isDisabled: false }).diverged).toBe(false)
  })

  it('does NOT flag a high-entropy (genuinely uncertain) emission of a disabled tool', () => {
    const d = new ToolDivergenceDetector()
    for (const h of [0.9, 1.1, 1.0, 1.2]) d.observeEntropy(h)
    expect(d.check({ tool: 'Read', entropy: 1.5, isDisabled: true }).diverged).toBe(false)
  })
})
