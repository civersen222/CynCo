/**
 * F236: an engine in the phone engine's seat binds 9160 or refuses; it never
 * walks to 9162, where the phone, the doorman and dispatch never look.
 *
 * 2026-11-14: a bare stand-in held 9160/9161, the phone engine started two
 * seconds later, logged "[ws] Port 9160 in use, using 9162 instead", and served
 * nobody while the phone talked to the stand-in.
 *
 * The plan is pure and pinned here. The real bind is Bun.serve, which the
 * suite shims asynchronously, so the refusal itself is proven under Bun in the
 * F236 record (a held port, `walk: false`, SeatTakenError after the retry).
 * No port here is bound: the numbers are arguments only.
 */
import { describe, expect, it } from 'bun:test'
import { bridgePortPlan, SeatTakenError, SEAT_RETRY_MS, SEAT_PAUSE_MS } from '../../bridge/server.js'

describe('bridgePortPlan', () => {
  it('a second engine beside the live one still walks, as before', () => {
    expect(bridgePortPlan(31160, true)).toEqual({ ports: [31160, 31161, 31162], pauseMs: 0 })
  })
  it('the seat engine asks for its own port only, again for ten seconds, then refuses', () => {
    const plan = bridgePortPlan(9160, false)
    expect(new Set(plan.ports)).toEqual(new Set([9160]))
    expect(plan.pauseMs).toBe(SEAT_PAUSE_MS)
    expect((plan.ports.length - 1) * plan.pauseMs).toBe(SEAT_RETRY_MS)
    expect(SEAT_RETRY_MS).toBe(10_000)
  })
  it('port 0 is the OS\'s choice either way', () => {
    expect(bridgePortPlan(0, false)).toEqual({ ports: [0], pauseMs: 0 })
    expect(bridgePortPlan(0, true)).toEqual({ ports: [0], pauseMs: 0 })
  })
})

describe('SeatTakenError', () => {
  it('starts with the line dispatch-mission.sh already refuses on, and says why it did not walk', () => {
    const e = new SeatTakenError(9160, new Error('Failed to start server. Is port 9160 in use?'))
    expect(e.message).toMatch(/^\[ws\] Port 9160 in use — this engine is in the phone engine's seat and does not walk to another port/)
    expect(e.message).toMatch(/Last error: Failed to start server\. Is port 9160 in use\?$/)
    expect(e.port).toBe(9160)
  })
})
