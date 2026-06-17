import { describe, it, expect, beforeEach } from 'vitest'
import { withAblationEnv } from './ablationEnv.js'

const KEY = '_ABLATION_VSM_DISABLED'

describe('withAblationEnv', () => {
  beforeEach(() => { delete process.env[KEY] })

  it('sets the flag to "1" inside the ungoverned arm', async () => {
    let seen: string | undefined
    await withAblationEnv(false, async () => { seen = process.env[KEY] })
    expect(seen).toBe('1')
  })

  it('deletes the flag inside the governed arm', async () => {
    process.env[KEY] = '1'
    let present = true
    await withAblationEnv(true, async () => { present = KEY in process.env })
    expect(present).toBe(false)
  })

  it('clears the flag after an ungoverned arm completes', async () => {
    await withAblationEnv(false, async () => {})
    expect(KEY in process.env).toBe(false)
  })

  it('clears the flag even when the body throws', async () => {
    await expect(
      withAblationEnv(false, async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
    expect(KEY in process.env).toBe(false)
  })

  it('returns the body result', async () => {
    const r = await withAblationEnv(true, async () => 42)
    expect(r).toBe(42)
  })
})
