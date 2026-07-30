import { describe, it, expect } from 'vitest'
import { runWithFinalize } from '../../bridge/finalizeGuard.js'

describe('runWithFinalize', () => {
  it('finalizes after normal completion', async () => {
    let calls = 0
    await runWithFinalize(async () => { /* work */ }, () => { calls++ })
    expect(calls).toBe(1)
  })

  it('finalizes after an early return', async () => {
    let calls = 0
    await runWithFinalize(async () => { return }, () => { calls++ })
    expect(calls).toBe(1)
  })

  it('finalizes after a thrown exception, and rethrows', async () => {
    let calls = 0
    await expect(
      runWithFinalize(async () => { throw new Error('boom') }, () => { calls++ })
    ).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('finalizes exactly once even if the body is long-running', async () => {
    let calls = 0
    await runWithFinalize(async () => { await new Promise(r => setTimeout(r, 5)) }, () => { calls++ })
    expect(calls).toBe(1)
  })

  it('never lets a finalizer failure escape into the session', async () => {
    await expect(
      runWithFinalize(async () => { /* ok */ }, () => { throw new Error('labeler exploded') })
    ).resolves.toBeUndefined()
  })

  it('preserves the body error when the finalizer also throws', async () => {
    await expect(
      runWithFinalize(async () => { throw new Error('body') }, () => { throw new Error('finalizer') })
    ).rejects.toThrow('body')
  })
})
