import { describe, it, expect } from 'bun:test'
import { VibeController } from '../../vibe/controller.js'

describe('Vibe loop research integration', () => {
  it('VibeController class exists and can be imported', () => {
    expect(VibeController).toBeDefined()
    expect(typeof VibeController).toBe('function')
  })
  it('has shouldResearch method', () => {
    const proto = VibeController.prototype as any
    expect(typeof proto.shouldResearch).toBe('function')
  })
})
