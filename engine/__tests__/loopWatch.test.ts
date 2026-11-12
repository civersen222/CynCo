// The engine says when its event loop was blocked (F225).
//
// 2026-11-12: after the first turn on a freshly loaded model the dashboard did not answer for 20 s, and
// earlier that day for 8 s. `/api/session` is served from memory, so the loop itself was held by something
// synchronous. The engine log has no times in it, and nothing in it said the loop had stopped: the
// stall could not be placed between two lines afterwards, and it could not be reproduced on demand.
import { describe, expect, it } from 'vitest'
import { createLoopWatch, startLoopWatch } from '../loopWatch.js'

describe('createLoopWatch', () => {
  const rig = (thresholdMs = 1000) => {
    let t = 0
    const lines: string[] = []
    const watch = createLoopWatch({ tickMs: 100, thresholdMs, now: () => t, wallClock: () => new Date('2026-11-12T00:14:55Z'), log: l => lines.push(l) })
    return { lines, tick: (after: number) => { t += after; watch.tick() } }
  }

  it('says nothing while ticks arrive on time, or a little late', () => {
    const { lines, tick } = rig()
    for (const after of [100, 100, 140, 100, 900, 100]) tick(after)
    expect(lines).toEqual([])
  })

  it('a tick that arrives late by more than the threshold is a blocked loop: how long, and when it ended', () => {
    const { lines, tick } = rig()
    tick(100); tick(20_500); tick(100)
    expect(lines).toEqual(['[engine] the event loop was blocked for 20.4 s, until 00:14:55Z: nothing was answered meanwhile (the dashboard, the phone, a Stop). What ran is in the lines just above.'])
  })

  it('each block is said once, and the next one is measured from where the last ended', () => {
    const { lines, tick } = rig()
    tick(3100); tick(100); tick(100); tick(1600)
    expect(lines.map(l => /blocked for ([\d.]+) s/.exec(l)?.[1])).toEqual(['3.0', '1.5'])
  })

  it('a gap as long as a sleeping PC is said to be possibly that', () => {
    const { lines, tick } = rig()
    tick(100); tick(40 * 60_000 + 100)
    expect(lines[0]).toMatch(/blocked for 2400\.0 s.*or the PC was asleep/)
  })
})

describe('startLoopWatch, for real', () => {
  it('a synchronous wait on the loop is reported; an asynchronous one is not', async () => {
    const lines: string[] = []
    const watch = startLoopWatch({ tickMs: 20, thresholdMs: 150, log: l => lines.push(l) })
    try {
      await new Promise(r => setTimeout(r, 300))
      expect(lines).toEqual([])
      const until = Date.now() + 400
      while (Date.now() < until) { /* hold the loop, as synchronous work does */ }
      await new Promise(r => setTimeout(r, 80))
      expect(lines).toHaveLength(1)
      expect(Number(/blocked for ([\d.]+) s/.exec(lines[0])![1])).toBeGreaterThanOrEqual(0.2)
    } finally {
      watch.stop()
    }
  })

  it('the engine starts it once it is ready', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('engine/main.ts', 'utf-8')).toMatch(/startLoopWatch\(\)/)
  })
})
