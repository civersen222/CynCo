// engine/__tests__/engine/sessionExtras.test.ts
import { beforeEach, describe, expect, it } from 'bun:test'
import { getSessionExtras, resetSessionExtras } from '../../engine/sessionExtras.js'

describe('getSessionExtras', () => {
  beforeEach(() => resetSessionExtras())

  it('computes on first turn and returns the identical value on later turns', async () => {
    let computeCalls = 0
    const compute = async () => { computeCalls++; return '\n\nHANDOFF+MEMORIES' }
    const t1 = await getSessionExtras('fix the bug', true, compute)
    const t2 = await getSessionExtras('fix the bug', false, compute)
    const t3 = await getSessionExtras('fix the bug', false, compute)
    expect(t1).toBe('\n\nHANDOFF+MEMORIES')
    expect(t2).toBe(t1) // byte-identical — prefix stable
    expect(t3).toBe(t1)
    expect(computeCalls).toBe(1)
  })

  it('returns and pins empty string for an unknown mid-conversation key (engine restart)', async () => {
    const t5 = await getSessionExtras('resumed convo', false, async () => 'SHOULD NOT RUN')
    const t6 = await getSessionExtras('resumed convo', false, async () => 'SHOULD NOT RUN')
    expect(t5).toBe('')
    expect(t6).toBe('') // stable from now on
  })

  it('a new conversation recomputes with its own key', async () => {
    await getSessionExtras('convo A', true, async () => 'A-EXTRAS')
    const b = await getSessionExtras('convo B', true, async () => 'B-EXTRAS')
    expect(b).toBe('B-EXTRAS')
  })
})
