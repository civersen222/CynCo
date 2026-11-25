/**
 * The process on a port with its ancestors (engine/apps/portTree.ts), F255's port form: Windows names as a listening
 * socket's owner the pid of the process that made it, also after that process has ended and a process it started
 * inherited the socket. A listener created after its socket is not the listener: the number has changed hands, and the
 * tree is null, as when nothing can be read. Every caller reads null as "cannot tell" and stops nothing on it
 * (`identifyPortHolder` answers `unknown`).
 */
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { listenerNow, readPortTree, runPowerShell } from '../../apps/portTree.js'

const S = 13_440_039_258_000 // a socket's creation time, ms since 1601
const row = (over: Record<string, unknown> = {}) => ({ pid: 4242, name: 'llama-server.exe', exe: 'C:/x/llama-server.exe', commandLine: 'llama-server --port 8081', created: 1, ...over })
const parent = { pid: 4000, name: 'cmd.exe', exe: 'C:/Windows/System32/cmd.exe', commandLine: 'cmd /c start-llm.cmd', created: 0 }

describe('readPortTree: a listener younger than its socket is not the listener (F255)', () => {
  it('the script asks for the socket\'s and the listener\'s creation times, as one argv element with no double quote', async () => {
    const scripts: string[] = []
    await readPortTree(8081, async (s) => { scripts.push(s); return '' }, () => {})
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('Get-NetTCPConnection -LocalPort 8081 -State Listen')
    expect(scripts[0]).toContain('$c.CreationTime.ToFileTimeUtc()')
    expect(scripts[0]).toContain('socketCreatedMs')
    expect(scripts[0]).toContain('listenerCreatedMs')
    expect(scripts[0]).not.toContain('"')
  })

  it('a listener created a second or more after its socket: null, and one line that names the pid and why', async () => {
    const said: string[] = []
    const out = JSON.stringify([row({ socketCreatedMs: S, listenerCreatedMs: S + 3_600_000 }), parent])
    expect(await readPortTree(8081, async () => out, l => said.push(l))).toBeNull()
    expect(said).toEqual(['[apps] port 8081: pid 4242 (llama-server.exe) was created after the socket it is listed for: the process that made the socket has ended and the number is another process\'s now, so nothing on the port is read as its listener'])
  })

  it('the line is said once per port, pid and socket time, not at every poll of a wait that asks again (check C-R5)', async () => {
    // The lazy wait asks every 5 s for up to 30 minutes; each ask read the port again and said the same line.
    const said: string[] = []
    const younger = (port: number, pid: number, sock: number) => readPortTree(port, async () => JSON.stringify([row({ pid, socketCreatedMs: sock, listenerCreatedMs: sock + 3_600_000 }), parent]), l => said.push(l))
    for (let i = 0; i < 3; i++) expect(await younger(65530, 2_000_000_100, S + 7_000)).toBeNull()
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/^\[apps\] port 65530: pid 2000000100 \(llama-server\.exe\) was created after the socket/)
    // Another pid, another socket time, another port: each is said once more, and still null every time.
    expect(await younger(65530, 2_000_000_104, S + 7_000)).toBeNull()
    expect(await younger(65530, 2_000_000_104, S + 8_000)).toBeNull()
    expect(await younger(65529, 2_000_000_104, S + 8_000)).toBeNull()
    expect(await younger(65530, 2_000_000_104, S + 8_000)).toBeNull()
    expect(said).toHaveLength(4)
    expect(said.slice(1).map(l => /port (\d+): pid (\d+)/.exec(l)!.slice(1).join(' '))).toEqual(['65530 2000000104', '65530 2000000104', '65529 2000000104'])
  })

  it('a listener not younger than its socket is the listener, as before', async () => {
    const said: string[] = []
    const out = JSON.stringify([row({ socketCreatedMs: S, listenerCreatedMs: S - 2_000 }), parent])
    const tree = await readPortTree(8081, async () => out, l => said.push(l))
    expect(tree).toEqual({ listener: { pid: 4242, name: 'llama-server.exe', exe: 'C:/x/llama-server.exe', commandLine: 'llama-server --port 8081', created: 1 }, ancestors: [parent] })
    expect(said).toEqual([])
  })

  it('a time that could not be read decides nothing: the tree is read as before', async () => {
    for (const over of [{}, { socketCreatedMs: null, listenerCreatedMs: S + 3_600_000 }, { socketCreatedMs: S, listenerCreatedMs: null }]) {
      const tree = await readPortTree(8081, async () => JSON.stringify([row(over), parent]), () => {})
      expect(tree?.listener.pid, JSON.stringify(over)).toBe(4242)
      expect(tree?.ancestors, JSON.stringify(over)).toEqual([parent])
    }
  })

  it.skipIf(process.platform !== 'win32')('against a listener this test opens on port 0: this process is read as the listener', async () => {
    // The test's own clock, in the unit the code compares in: ms since 1601-01-01 UTC (FILETIME / 10,000).
    const since1601 = () => Date.now() + 11_644_473_600_000
    const before = since1601()
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const port = (server.address() as { port: number }).port
      const said: string[] = []
      const outs: string[] = []
      const tree = await readPortTree(port, async (s) => { const o = await runPowerShell(s); outs.push(o); return o }, l => said.push(l))
      const after = since1601()
      // With the raw reading: this case failed once on 2026-11-25 with one line said, and the output was not kept.
      expect(said, `the reading of port ${port} said something; what PowerShell printed: ${JSON.stringify(outs)}`).toEqual([])
      expect(tree?.listener.pid).toBe(process.pid)
      expect(tree?.listener.name).toMatch(/^(node|bun)(\.exe)?$/i)
      // The two times were read, not left out: a PowerShell line that failed would leave them null and decide nothing.
      const first = (JSON.parse(outs[0]!) as Array<Record<string, unknown>>)[0]!
      expect(typeof first.socketCreatedMs, outs[0]).toBe('number')
      expect(typeof first.listenerCreatedMs, outs[0]).toBe('number')
      expect(first.listenerCreatedMs as number).toBeLessThan((first.socketCreatedMs as number) + 1_000)
      // Both sides of the comparison, bounded (F255, check C-R1): the socket was made between `before` and `after`, its
      // time cut to whole seconds (so up to a second early), and this worker was made before it. A time read in the
      // wrong zone or unit, which would make every listener read as the socket's maker, lands outside these. 50 ms for
      // the two clocks.
      const sock = first.socketCreatedMs as number, made = first.listenerCreatedMs as number
      expect(sock, `socket ${sock}, test clock ${before}..${after}`).toBeGreaterThanOrEqual(before - 1_000 - 50)
      expect(sock, `socket ${sock}, test clock ${before}..${after}`).toBeLessThanOrEqual(after + 50)
      expect(made, `listener ${made}, test clock ${before}`).toBeLessThanOrEqual(before + 50)
      expect(sock, `socket ${sock}, listener ${made}`).toBeGreaterThanOrEqual(made - 1_000)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 60_000)
})

describe('listenerNow: the port read again just before a stop, against the listener read seconds earlier (F255)', () => {
  // The listener identified seconds earlier. Its pid is one no process can have; nothing here is stopped or listed.
  const was = { pid: 2_000_000_200, name: 'llama-server.exe', exe: 'C:/x/llama-server.exe', commandLine: 'llama-server --port 65531', created: 133_000_000_000_000_000 }
  const reading = (...procs: object[]) => async () => JSON.stringify(procs)

  it('the same pid created at the same time: the same process, so the stop may go ahead', async () => {
    const scripts: string[] = []
    expect(await listenerNow(65531, was, async (s) => { scripts.push(s); return JSON.stringify([was, parent]) }, () => {})).toEqual({ kind: 'same' })
    // The same reading as readPortTree's: the listener on exactly this port, with its creation time.
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('Get-NetTCPConnection -LocalPort 65531 -State Listen')
  })

  it('nothing listens any more: free, and nothing is said', async () => {
    const said: string[] = []
    expect(await listenerNow(65531, was, async () => '\r\n', l => said.push(l))).toEqual({ kind: 'free' })
    expect(said).toEqual([])
  })

  it('another pid listens now: other, naming it', async () => {
    const now = { ...was, pid: 2_000_000_204, name: 'python.exe', created: was.created + 50_000_000 }
    expect(await listenerNow(65531, was, reading(now), () => {})).toEqual({ kind: 'other', now: { ...now } })
  })

  it('the same pid created at another time: the number changed hands, so it is another process (other)', async () => {
    const now = { ...was, created: was.created + 10_000_000 }
    expect(await listenerNow(65531, was, reading(now), () => {})).toEqual({ kind: 'other', now })
  })

  // Wave 24 round three (check X-4): `unread` says which of three things it is, because only one of them is a finding
  // about the port. Round two answered a bare `{ kind: 'unread' }` for all three; these expectations changed on purpose.
  it('the same pid with a creation time not read on either side: not shown to be the same process (unread: a time is missing)', async () => {
    expect(await listenerNow(65531, was, reading({ ...was, created: undefined }), () => {})).toEqual({ kind: 'unread', because: 'time-missing' })
    expect(await listenerNow(65531, { ...was, created: 0 }, reading({ ...was, created: 0 }), () => {})).toEqual({ kind: 'unread', because: 'time-missing' })
    expect(await listenerNow(65531, { ...was, created: 0 }, reading(was), () => {})).toEqual({ kind: 'unread', because: 'time-missing' })
  })

  it('a reading that fails: unread because the reading failed, with one line', async () => {
    const said: string[] = []
    expect(await listenerNow(65531, was, async () => { throw new Error('powershell is gone') }, l => said.push(l))).toEqual({ kind: 'unread', because: 'reading-failed' })
    expect(said).toEqual(['[apps] could not read who holds port 65531 again before stopping pid 2000000200: powershell is gone'])
  })

  it('an answer that does not parse, or names no process: unread because the reading failed, with one line each', async () => {
    const said: string[] = []
    expect(await listenerNow(65531, was, async () => 'Get-CimInstance : Access denied', l => said.push(l))).toEqual({ kind: 'unread', because: 'reading-failed' })
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/^\[apps\] could not read who holds port 65531 again before stopping pid 2000000200: /)
    expect(await listenerNow(65531, was, async () => '[{}]', l => said.push(l))).toEqual({ kind: 'unread', because: 'reading-failed' })
    expect(said).toHaveLength(2)
    expect(said[1]).toBe('[apps] could not read who holds port 65531 again before stopping pid 2000000200: the answer names no process')
    // The answer the tree script really gives when the socket's owner is not in the process list (it ended between the
    // two reads, or the list failed): `ConvertTo-Json @($out)` of an empty list.
    expect(await listenerNow(65531, was, async () => '[]', l => said.push(l))).toEqual({ kind: 'unread', because: 'reading-failed' })
    expect(said).toHaveLength(3)
  })

  it('a listener younger than its socket: unread because it is younger than its socket, with the one line readPortTree says', async () => {
    const said: string[] = []
    const younger = { ...was, socketCreatedMs: S, listenerCreatedMs: S + 3_600_000 }
    expect(await listenerNow(65531, was, reading(younger), l => said.push(l))).toEqual({ kind: 'unread', because: 'younger-than-socket' })
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/^\[apps\] port 65531: pid 2000000200 \(llama-server\.exe\) was created after the socket/)
  })
})
