/**
 * Whose server is on the model port (engine/llama/portOwner.ts). The lazy path
 * stops a healthy server only when this says `foreign`, so the direction of
 * every doubt is pinned here: what cannot be read is `unknown`, never `foreign`.
 */
import { describe, expect, it } from 'vitest'
import { classifyPortOwner, readPortListener, type PortListener } from '../../llama/portOwner.js'

const listener = (over: Partial<PortListener> = {}): PortListener => ({
  pid: 41364, name: 'llama-server.exe', parentName: 'bun.exe', parentIsOlder: true, ...over,
})

describe('classifyPortOwner', () => {
  it('a server whose parent is a running bun is an engine child: CynCo spawns llama-server from bun and nothing else', () => {
    expect(classifyPortOwner(listener()).owner).toBe('engine')
    expect(classifyPortOwner(listener({ parentName: 'bun' })).owner).toBe('engine')
  })

  it('a server started by a shell script is foreign, and the detail names the pid and what started it', () => {
    const o = classifyPortOwner(listener({ parentName: 'bash.exe' }))
    expect(o.owner).toBe('foreign')
    expect(o.detail).toContain('pid 41364')
    expect(o.detail).toContain('bash.exe')
  })

  it('a server whose parent has exited belongs to no live engine: foreign', () => {
    expect(classifyPortOwner(listener({ parentName: null, parentIsOlder: false })).owner).toBe('foreign')
  })

  it('a parent pid reused by a later bun is not the parent: foreign', () => {
    expect(classifyPortOwner(listener({ parentName: 'bun.exe', parentIsOlder: false })).owner).toBe('foreign')
  })

  it('a program that merely has bun in its name is not an engine', () => {
    expect(classifyPortOwner(listener({ parentName: 'bunny.exe' })).owner).toBe('foreign')
  })

  it('a listener that could not be read is unknown, never foreign', () => {
    expect(classifyPortOwner(null).owner).toBe('unknown')
  })
})

describe('readPortListener', () => {
  it('asks about the port it was given and reads the answer', async () => {
    const scripts: string[] = []
    const l = await readPortListener(8081, async (script) => {
      scripts.push(script)
      return JSON.stringify({ pid: 7, name: 'llama-server.exe', parentName: 'bash.exe', parentIsOlder: true })
    })
    expect(scripts[0]).toContain('-LocalPort 8081')
    expect(l).toEqual({ pid: 7, name: 'llama-server.exe', parentName: 'bash.exe', parentIsOlder: true })
  })

  it('a parent that is gone reads as null', async () => {
    const l = await readPortListener(8081, async () => JSON.stringify({ pid: 7, name: 'llama-server.exe', parentName: null, parentIsOlder: false }))
    expect(l?.parentName).toBeNull()
  })

  it('no output, output that is not the expected shape, and a failing read are all null', async () => {
    expect(await readPortListener(8081, async () => '')).toBeNull()
    expect(await readPortListener(8081, async () => 'Get-NetTCPConnection : access denied')).toBeNull()
    expect(await readPortListener(8081, async () => JSON.stringify({ pid: 'seven', name: 'x' }))).toBeNull()
    expect(await readPortListener(8081, async () => { throw new Error('powershell not found') })).toBeNull()
  })
})

describe('portOwner off Windows', () => {
  it('answers unknown without trying to read, so a wait that polls it stays quiet', async () => {
    const { portOwner } = await import('../../llama/portOwner.js')
    const logged: unknown[] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => { logged.push(a) }
    try {
      expect(await portOwner(8081, 'linux')).toEqual({ owner: 'unknown', detail: 'port ownership is read on Windows only' })
    } finally { console.log = realLog }
    expect(logged).toEqual([])
  })
})
