import { describe, expect, it } from 'bun:test'
import { ActivityRegistry } from '../../power/activity.js'
import { wireHoldAwake } from '../../power/awake.js'

function fakeSpawn() {
  const spawned: { cmd: string; args: string[]; killed: boolean }[] = []
  const spawn = ((cmd: string, args: string[]) => {
    const rec = { cmd, args, killed: false }
    spawned.push(rec)
    return { pid: 1000 + spawned.length, kill: () => { rec.killed = true; return true }, on: () => {}, unref: () => {} } as any
  }) as unknown as typeof import('child_process').spawn
  return { spawn, spawned }
}

describe('wireHoldAwake', () => {
  it('spawns one helper on the first activity, even with three overlapping, and kills it when the last ends', () => {
    const r = new ActivityRegistry()
    const { spawn, spawned } = fakeSpawn()
    wireHoldAwake(r, { platform: 'win32', spawn, scriptPath: 'C:/x/hold-awake.ps1' })
    const a = r.begin('turn'); const b = r.begin('request'); const c = r.begin('oneshot')
    expect(spawned.length).toBe(1)
    expect(spawned[0].cmd).toBe('powershell')
    expect(spawned[0].args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/x/hold-awake.ps1', '-ParentPid', String(process.pid)])
    a(); b()
    expect(spawned[0].killed).toBe(false)
    c()
    expect(spawned[0].killed).toBe(true)
  })

  it('spawns again for the next busy stretch', () => {
    const r = new ActivityRegistry()
    const { spawn, spawned } = fakeSpawn()
    wireHoldAwake(r, { platform: 'win32', spawn, scriptPath: 'x.ps1' })
    r.begin('turn')()
    r.begin('turn')()
    expect(spawned.length).toBe(2)
    expect(spawned.every(s => s.killed)).toBe(true)
  })

  it('does nothing off Windows', () => {
    const r = new ActivityRegistry()
    const { spawn, spawned } = fakeSpawn()
    wireHoldAwake(r, { platform: 'linux', spawn, scriptPath: 'x.ps1' })
    r.begin('turn')
    expect(spawned.length).toBe(0)
  })

  it('unwire kills a live helper and stops listening', () => {
    const r = new ActivityRegistry()
    const { spawn, spawned } = fakeSpawn()
    const unwire = wireHoldAwake(r, { platform: 'win32', spawn, scriptPath: 'x.ps1' })
    r.begin('turn')
    unwire()
    expect(spawned[0].killed).toBe(true)
    r.begin('turn')
    expect(spawned.length).toBe(1)
  })
})
