import { describe, expect, it } from 'bun:test'
import type { ContextStatusEvent } from '../../bridge/protocol.js'

describe('ContextStatusEvent index fields', () => {
  it('accepts indexMode / indexDegraded / lastQueryMode', () => {
    const e: ContextStatusEvent = {
      type: 'context.status',
      utilization: 0.5,
      estimatedTokens: 100,
      contextLength: 32768,
      action: 'proceed',
      indexMode: 'hybrid',
      indexDegraded: false,
      lastQueryMode: 'hybrid',
    }
    expect(e.indexMode).toBe('hybrid')
    expect(e.indexDegraded).toBe(false)
    expect(e.lastQueryMode).toBe('hybrid')
  })
})
