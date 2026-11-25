/**
 * Whose server is on the model port (engine/llama/portOwner.ts). The lazy path
 * stops a healthy server only when this says `foreign`, so the direction of
 * every doubt is pinned here: what cannot be read is `unknown`, never `foreign`.
 */
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import {
  classifyPortOwner, listenerVerdict, listenerVerdictFor, readListenerAges, readPortListener, SOCKET_TIME_RESOLUTION_MS,
  type ListenerAge, type PortListener,
} from '../../llama/portOwner.js'

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

// F255, the port form: Windows names as a listening socket's owner the pid of the process that MADE the socket. When
// that process has ended and something it started inherited the socket, the listing keeps naming the dead pid, and
// that number may have gone to any process since (the failure log has it twice: "orphaned listening socket",
// "netstat kept reporting the DEAD engine PID"). A process created after the socket cannot have made it.
describe('listenerVerdict: is the pid a listing names as a socket\'s owner the process that made it (F255)', () => {
  const S = 1_000_000_000 // a socket's creation time, ms
  it('a process created before its socket is its owner', () => {
    expect(listenerVerdict(S, S - 2_000)).toBe('owner')
    expect(listenerVerdict(S, S - 3_600_000)).toBe('owner')
  })

  it('a socket\'s time is given in whole seconds, so a process created within the second it names is still its owner', () => {
    // Measured 2026-11-25 on this PC: every listener's CreationTime ends in .0000000, while the process that made it
    // was created up to 0.97 s "after" it (sock 17:14:16.0, process 17:14:16.97).
    expect(SOCKET_TIME_RESOLUTION_MS).toBe(1_000)
    expect(listenerVerdict(S, S)).toBe('owner')
    expect(listenerVerdict(S, S + 999)).toBe('owner')
  })

  it('a process created a whole second or more after the socket is younger: the number has changed hands', () => {
    expect(listenerVerdict(S, S + 1_000)).toBe('younger')
    expect(listenerVerdict(S, S + 3_600_000)).toBe('younger')
  })

  it('either time unread is unknown, never younger', () => {
    expect(listenerVerdict(null, S)).toBe('unknown')
    expect(listenerVerdict(S, null)).toBe('unknown')
    expect(listenerVerdict(null, null)).toBe('unknown')
    expect(listenerVerdict(Number.NaN, S)).toBe('unknown')
  })
})

describe('listenerVerdictFor: the verdict for one pid among the rows of a port', () => {
  const S = 1_000_000_000
  const row = (pid: number, proc: number | null, sock: number | null = S): ListenerAge => ({ pid, socketCreatedMs: sock, processCreatedMs: proc })
  it('no reading, or no row for the pid, is unknown', () => {
    expect(listenerVerdictFor(7, null)).toBe('unknown')
    expect(listenerVerdictFor(7, [])).toBe('unknown')
    expect(listenerVerdictFor(7, [row(8, S - 1)])).toBe('unknown')
  })
  it('the pid\'s own row decides; one socket it is younger than (IPv4 and IPv6 are two rows) makes it younger', () => {
    expect(listenerVerdictFor(7, [row(7, S - 1)])).toBe('owner')
    expect(listenerVerdictFor(7, [row(7, S + 5_000)])).toBe('younger')
    expect(listenerVerdictFor(7, [row(7, S - 1), row(7, S + 5_000, S + 2_000)])).toBe('younger')
    expect(listenerVerdictFor(7, [row(7, S + 5_000, null), row(7, S - 1)])).toBe('owner')
    expect(listenerVerdictFor(7, [row(7, null)])).toBe('unknown')
  })
})

describe('readListenerAges', () => {
  it('asks about the port it was given for both creation times, as one argv element with no double quote', async () => {
    const scripts: string[] = []
    await readListenerAges(8081, async (script) => { scripts.push(script); return '[]' }, () => {})
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('Get-NetTCPConnection -LocalPort 8081 -State Listen')
    expect(scripts[0]).toContain('$c.CreationTime')
    expect(scripts[0]).toContain('$p.CreationDate')
    expect(scripts[0]).not.toContain('"')
  })

  it('reads every row; nothing listening is an empty list; a row without a whole positive pid is dropped', async () => {
    const out = JSON.stringify([
      { pid: 41364, socketCreatedMs: 13440039258000, processCreatedMs: 13440039256158 },
      { pid: 41364, socketCreatedMs: null, processCreatedMs: 13440039256158 },
      { pid: 0, socketCreatedMs: 1, processCreatedMs: 1 },
      { pid: 'x', socketCreatedMs: 1, processCreatedMs: 1 },
    ])
    expect(await readListenerAges(8081, async () => out, () => {})).toEqual([
      { pid: 41364, socketCreatedMs: 13440039258000, processCreatedMs: 13440039256158 },
      { pid: 41364, socketCreatedMs: null, processCreatedMs: 13440039256158 },
    ])
    expect(await readListenerAges(8081, async () => '[]', () => {})).toEqual([])
    expect(await readListenerAges(8081, async () => '', () => {})).toEqual([])
    // PowerShell writes a one-element list as the bare object when it is not forced into an array.
    expect(await readListenerAges(8081, async () => JSON.stringify({ pid: 7, socketCreatedMs: 5, processCreatedMs: 4 }), () => {}))
      .toEqual([{ pid: 7, socketCreatedMs: 5, processCreatedMs: 4 }])
  })

  it('a read that fails or answers something else is null, with one line that says why', async () => {
    const said: string[] = []
    expect(await readListenerAges(8081, async () => { throw new Error('powershell not found') }, l => said.push(l))).toBeNull()
    expect(await readListenerAges(8081, async () => 'Get-NetTCPConnection : access denied', l => said.push(l))).toBeNull()
    expect(said).toHaveLength(2)
    expect(said[0]).toBe('[llama-cpp] could not read when the socket on port 8081 and its process were created: powershell not found')
    expect(said[1]).toMatch(/^\[llama-cpp\] could not read when the socket on port 8081 and its process were created: /)
  })

  it.skipIf(process.platform !== 'win32')('against a listener this test opens on port 0: this process is its owner', async () => {
    // The test's own clock, in the unit the code compares in: ms since 1601-01-01 UTC (FILETIME / 10,000).
    const since1601 = () => Date.now() + 11_644_473_600_000
    const before = since1601()
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const port = (server.address() as { port: number }).port
      const said: string[] = []
      const ages = await readListenerAges(port, undefined, l => said.push(l))
      const after = since1601()
      expect(said).toEqual([])
      expect(ages).not.toBeNull()
      const mine = ages!.filter(a => a.pid === process.pid)
      expect(mine.length, JSON.stringify(ages)).toBeGreaterThan(0)
      for (const a of mine) {
        expect(typeof a.socketCreatedMs).toBe('number')
        expect(typeof a.processCreatedMs).toBe('number')
        // Both sides of the comparison, bounded (F255, check C-R1): the socket was made between `before` and `after`,
        // its time cut to whole seconds (so up to a second early), and this worker was made before it. A time read in
        // the wrong zone or unit, which would make every verdict `owner`, lands outside these. 50 ms for the two clocks.
        const sock = a.socketCreatedMs!, proc = a.processCreatedMs!
        expect(sock, `socket ${sock}, test clock ${before}..${after}`).toBeGreaterThanOrEqual(before - SOCKET_TIME_RESOLUTION_MS - 50)
        expect(sock, `socket ${sock}, test clock ${before}..${after}`).toBeLessThanOrEqual(after + 50)
        expect(proc, `process ${proc}, test clock ${before}`).toBeLessThanOrEqual(before + 50)
        expect(sock, `socket ${sock}, process ${proc}`).toBeGreaterThanOrEqual(proc - SOCKET_TIME_RESOLUTION_MS)
      }
      expect(listenerVerdictFor(process.pid, ages)).toBe('owner')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 60_000)
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
