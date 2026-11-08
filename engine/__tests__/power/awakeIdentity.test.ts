import { describe, expect, it } from 'bun:test'
import { ActivityRegistry } from '../../power/activity.js'
import { wireHoldAwake } from '../../power/awake.js'

describe('wireHoldAwake helper identity (review #4)', () => {
  it('a late exit event from an old helper does not orphan the new one', () => {
    const r = new ActivityRegistry()
    const spawned: { killed: boolean; exitCb?: () => void }[] = []
    const spawn = ((_c: string, _a: string[]) => {
      const rec: { killed: boolean; exitCb?: () => void } = { killed: false }
      spawned.push(rec)
      return { pid: 1000 + spawned.length, kill: () => { rec.killed = true; return true }, on: (_e: string, cb: () => void) => { rec.exitCb = cb }, unref: () => {} } as any
    }) as unknown as typeof import('child_process').spawn
    wireHoldAwake(r, { platform: 'win32', spawn, scriptPath: 'x.ps1' })
    const a = r.begin('turn'); a()            // h1 spawned and killed
    const b = r.begin('turn')                 // h2 spawned
    spawned[0].exitCb?.()                     // h1's exit arrives late
    b()                                       // must still kill h2
    expect(spawned.length).toBe(2)
    expect(spawned[1].killed).toBe(true)
  })
})
