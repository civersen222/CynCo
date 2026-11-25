// One rule for a chat turn and a one-shot (docs/decisions/2026-11-11-local-llm-apps.md):
// the glue between "who holds the model port" and "take it, say so, give it back".
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lazyAppDeps, takeGpuForOneShot } from '../../apps/gpu.js'
import { readDisplaced } from '../../apps/displace.js'
import type { Holder } from '../../apps/identify.js'
import type { LocalApp } from '../../apps/registry.js'
import type { ListedProc, Proc } from '../../apps/portTree.js'
import { isGpuBusy, TaskRunner } from '../../daemon/taskRunner.js'

let home: string
let record: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-apps-gpu-')); record = join(home, 'displaced-apps.json') })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const ROOT = 'C:\\Users\\o\\dndai'
const app: LocalApp = { id: 'dndai', name: 'dndai', root: ROOT, script: 'scripts/start-llm.sh', manage: true, source: 'by hand', launch: { exe: 'bash.exe', args: ['scripts/start-llm.sh'], cwd: ROOT } }
const listener: Proc = { pid: 4242, name: 'llama-server.exe', exe: null, commandLine: 'llama-server.exe --port 8081', created: 2 }
const inUse: ListedProc[] = [{ pid: 5000, ppid: 1, exe: 'node.exe', commandLine: `node ${ROOT}\\web\\server.js` }]
const appHolder: Holder = { owner: 'app', app, detail: 'dndai\'s model server (pid 4242 (llama-server.exe), started by bash.exe scripts/start-llm.sh)', listener, discovered: false, launcherPid: 4000 }
/** The port read again just before a stop (F255): `procs` listen on it now. */
const reading = (...procs: Proc[]) => async () => JSON.stringify(procs)

describe('lazyAppDeps: what the lazy chat engine is given', () => {
  it('portOwner names the app, and takeFromApp stops that server, says so and writes down what is owed', async () => {
    const killed: number[] = [], said: string[] = []
    const d = lazyAppDeps(8081, { identify: async () => appHolder, kill: async (pid) => { killed.push(pid) }, listProcesses: async () => inUse, file: record, by: 'the chat engine (pid 77)', runPowerShell: reading(listener) })
    expect(await d.portOwner()).toEqual({ owner: 'app', detail: appHolder.detail })
    await d.takeFromApp((m) => said.push(m))
    expect(killed).toEqual([4242])
    expect(said[0]).toMatch(/^dndai's model server held port 8081 \(pid 4242\)\. CynCo stopped it/)
    expect(readDisplaced(record).map(x => [x.appId, x.by])).toEqual([['dndai', 'the chat engine (pid 77)']])
  })

  it('an engine\'s, a foreign and an unreadable server pass through as before, and there is nothing to take', async () => {
    for (const h of [
      { owner: 'engine', detail: 'pid 1 (llama-server.exe), the child of a running bun.exe', listener } as Holder,
      { owner: 'foreign', detail: 'pid 1 (python.exe), started by explorer.exe', listener } as Holder,
      { owner: 'unknown', detail: 'the process listening on the port could not be read' } as Holder,
    ]) {
      const killed: number[] = []
      const d = lazyAppDeps(8081, { identify: async () => h, kill: async (pid) => { killed.push(pid) }, file: record })
      expect(await d.portOwner()).toEqual({ owner: h.owner, detail: h.detail })
      await d.takeFromApp(() => {})
      expect(killed).toEqual([])
    }
  })

  it('the app\'s server let go of the port and another process listens there now: nothing is stopped and takeFromApp answers refused, with why (F255)', async () => {
    const killed: number[] = [], said: string[] = []
    const later: Proc = { ...listener, pid: 2_000_000_204, name: 'python.exe', created: 9 }
    const d = lazyAppDeps(8081, { identify: async () => appHolder, kill: async (pid) => { killed.push(pid) }, listProcesses: async () => inUse, file: record, runPowerShell: reading(later) })
    await d.portOwner()
    expect(await d.takeFromApp((m) => said.push(m))).toEqual({ refused: 'it let go of the port by itself before CynCo stopped it, and pid 2000000204 (python.exe) listens there now, which CynCo has not identified and did not stop' })
    expect(killed).toEqual([])
    expect(readDisplaced(record)).toEqual([])
  })

  it('the app\'s server let go of the port and nothing listens: nothing is stopped and the engine goes on to load (leftover) (F255)', async () => {
    const killed: number[] = []
    const d = lazyAppDeps(8081, { identify: async () => appHolder, kill: async (pid) => { killed.push(pid) }, listProcesses: async () => inUse, file: record, runPowerShell: async () => '' })
    await d.portOwner()
    expect(await d.takeFromApp(() => {})).toBe('leftover')
    expect(killed).toEqual([])
  })

  it('a port that cannot be read again just before the stop: the server is stopped as it was read, so the engine is not left refusing behind it (check X-4)', async () => {
    // Round two answered { refused } here; the lazy engine then remembered the server as one it could not stop and
    // answered every request with PortHeldError until its next load, for one PowerShell that failed once.
    const killed: number[] = [], said: string[] = []
    const d = lazyAppDeps(8081, { identify: async () => appHolder, kill: async (pid) => { killed.push(pid) }, listProcesses: async () => inUse, file: record, runPowerShell: async () => { throw new Error('powershell is gone') } })
    await d.portOwner()
    expect(await d.takeFromApp((m) => said.push(m))).toBe('displaced')
    expect(killed).toEqual([4242])
    expect(said[0]).toMatch(/^dndai's model server held port 8081 \(pid 4242\)\. CynCo stopped it/)
  })
})

describe('takeGpuForOneShot: the same rule for an unattended run', () => {
  const ctx = (h: Holder | null, killed: number[], said: string[]) => ({
    port: 8081, by: 'the one-shot digest-espn', file: record,
    portAnswers: async () => h !== null, identify: async () => h ?? ({ owner: 'unknown', detail: 'x' } as Holder),
    kill: async (pid: number) => { killed.push(pid) }, listProcesses: async () => inUse, say: (m: string) => said.push(m),
    waitFree: async () => true,
    runPowerShell: reading(h && h.owner !== 'unknown' ? h.listener : listener),
  })

  it('an app\'s server on the port is taken, named, and owed back', async () => {
    const killed: number[] = [], said: string[] = []
    expect(await takeGpuForOneShot(ctx(appHolder, killed, said))).toBe('taken')
    expect(killed).toEqual([4242])
    expect(said[0]).toContain('dndai\'s model server held port 8081')
    expect(readDisplaced(record)[0]).toMatchObject({ appId: 'dndai', by: 'the one-shot digest-espn' })
  })

  it('a server that is nobody\'s is stopped and said, as the chat engine does (F202), and nothing is owed', async () => {
    const killed: number[] = [], said: string[] = []
    const h: Holder = { owner: 'foreign', detail: 'pid 9 (python.exe), started by explorer.exe', listener: { ...listener, pid: 9 } }
    expect(await takeGpuForOneShot(ctx(h, killed, said))).toBe('taken')
    expect(killed).toEqual([9])
    expect(said[0]).toBe('port 8081 was held by a server that is not CynCo\'s: pid 9 (python.exe), started by explorer.exe. Stopped it for the one-shot digest-espn.')
    expect(readDisplaced(record)).toEqual([])
  })

  it('another engine\'s server, or one nobody could read, is left alone: the one-shot defers as before', async () => {
    for (const h of [{ owner: 'engine', detail: 'e', listener } as Holder, { owner: 'unknown', detail: 'u' } as Holder]) {
      const killed: number[] = []
      expect(await takeGpuForOneShot(ctx(h, killed, []))).toBe('left')
      expect(killed).toEqual([])
    }
  })

  it('nothing on the port: nothing is read and nothing is done', async () => {
    let identified = 0
    const c = { ...ctx(null, [], []), identify: async () => { identified++; return appHolder } }
    expect(await takeGpuForOneShot(c)).toBe('free')
    expect(identified).toBe(0)
  })

  it('a server that will not die leaves the port to the busy check: nothing is spawned over it', async () => {
    const c = { ...ctx(appHolder, [], []), waitFree: async () => false }
    expect(await takeGpuForOneShot(c)).toBe('left')
  })
})

// F255: the listener was read seconds before the stop; the port is read again immediately before it, and a server
// that is not CynCo's is stopped only when the same process (same pid, same creation time) still listens.
describe('takeGpuForOneShot reads the port again just before it stops a server that is not CynCo\'s (F255)', () => {
  const foreignListener: Proc = { ...listener, pid: 9, name: 'python.exe' }
  const foreign: Holder = { owner: 'foreign', detail: 'pid 9 (python.exe), started by explorer.exe', listener: foreignListener }
  const later: Proc = { ...listener, pid: 2_000_000_204, name: 'node.exe', created: 9 }
  function rig(read: () => Promise<string>, free = true, holder: Holder = foreign) {
    const killed: number[] = [], said: string[] = [], order: string[] = [], logs: string[] = []
    const c = {
      port: 8081, by: 'the one-shot digest-espn', file: record, say: (m: string) => said.push(m),
      portAnswers: async () => true, identify: async () => { order.push('identify'); return holder },
      kill: async (pid: number) => { order.push('kill'); killed.push(pid) }, listProcesses: async () => inUse,
      waitFree: async () => { order.push('free?'); return free },
      runPowerShell: async () => { order.push('read'); return read() },
      log: (line: string) => logs.push(line),
    }
    return { c, killed, said, order, logs }
  }
  const stoppedAsSaid = 'port 8081 was held by a server that is not CynCo\'s: pid 9 (python.exe), started by explorer.exe. Stopped it for the one-shot digest-espn.'

  it('the same process: read, then stopped, then the port waited for, as before', async () => {
    const r = rig(reading(foreignListener))
    expect(await takeGpuForOneShot(r.c)).toBe('taken')
    expect(r.order).toEqual(['identify', 'read', 'kill', 'free?'])
    expect(r.killed).toEqual([9])
  })

  it('nothing listens any more: nothing is stopped, and with the port free the one-shot goes on (taken), said as it was', async () => {
    const r = rig(async () => '')
    expect(await takeGpuForOneShot(r.c)).toBe('taken')
    expect(r.killed).toEqual([])
    expect(r.said).toEqual(['port 8081 was held by a server that is not CynCo\'s: pid 9 (python.exe), started by explorer.exe. It let go of the port by itself before CynCo stopped it, and nothing listens there now: CynCo stopped nothing.'])
  })

  it('nothing listened at the look and something does a moment later: nothing is stopped and the one-shot waits (left)', async () => {
    const r = rig(async () => '', false)
    expect(await takeGpuForOneShot(r.c)).toBe('left')
    expect(r.killed).toEqual([])
    expect(r.said).toEqual(['port 8081 was held by a server that is not CynCo\'s: pid 9 (python.exe), started by explorer.exe. It let go of the port by itself before CynCo stopped it, and something listens there again, which CynCo did not stop; the one-shot digest-espn waits for the port.'])
  })

  it('another process listens now: nothing is stopped, and the one-shot leaves the port, as when a stop could not be done (left)', async () => {
    const r = rig(reading(later))
    expect(await takeGpuForOneShot(r.c)).toBe('left')
    expect(r.killed).toEqual([])
    expect(r.order).toEqual(['identify', 'read'])
    expect(r.said).toEqual(['port 8081 was held by a server that is not CynCo\'s: pid 9 (python.exe), started by explorer.exe. It let go of the port by itself before CynCo stopped it, and pid 2000000204 (node.exe) listens there now, which CynCo has not identified and did not stop; the one-shot digest-espn waits for the port.'])
  })

  // Changed on purpose in wave 24 round three (check X-4): round two left the port here. A look that could not be made
  // decides nothing (the rule `killProcessOnPort` follows), so the stop goes ahead by the pid read earlier, as before the
  // second look, with one log line; the owner hears the ordinary "stopped" message.
  it('a port that cannot be read again: the look decided nothing, so the server is stopped as it was read, logged, and said as an ordinary stop (taken)', async () => {
    const r = rig(async () => { throw new Error('powershell is gone') })
    expect(await takeGpuForOneShot(r.c)).toBe('taken')
    expect(r.order).toEqual(['identify', 'read', 'kill', 'free?'])
    expect(r.killed).toEqual([9])
    expect(r.said).toEqual([stoppedAsSaid])
    expect(r.logs).toEqual([
      '[apps] could not read who holds port 8081 again before stopping pid 9: powershell is gone',
      '[apps] port 8081 could not be read again just before the stop (the reading failed): pid 9 is stopped as it was read',
    ])
  })

  // The daemon passes no `log` (engine/daemon/main.ts): the line that records a stop by the pid read earlier must
  // then reach the console, or it is written nowhere (wave 24 round three, check Z3-5).
  it('with no log handed in, the stop-as-read line goes to the console', async () => {
    const r = rig(async () => { throw new Error('powershell is gone') })
    const { log: _left, ...withoutLog } = r.c
    const printed: string[] = []
    const real = console.log
    console.log = (...a: unknown[]) => { printed.push(a.map(String).join(' ')) }
    try {
      expect(await takeGpuForOneShot(withoutLog)).toBe('taken')
    } finally {
      console.log = real
    }
    expect(r.killed).toEqual([9])
    expect(printed).toContain('[apps] port 8081 could not be read again just before the stop (the reading failed): pid 9 is stopped as it was read')
  })

  it('the same pid read again with no creation time: the two readings cannot be compared, so it is stopped as it was read (taken)', async () => {
    const r = rig(reading({ ...foreignListener, created: 0 }))
    expect(await takeGpuForOneShot(r.c)).toBe('taken')
    expect(r.order).toEqual(['identify', 'read', 'kill', 'free?'])
    expect(r.killed).toEqual([9])
    expect(r.said).toEqual([stoppedAsSaid])
    expect(r.logs).toEqual(['[apps] port 8081 could not be read again just before the stop (a creation time is missing on one side, so the two readings cannot be compared): pid 9 is stopped as it was read'])
  })

  it('the listener now listed is younger than its socket: nothing is stopped, and the one-shot leaves the port (left)', async () => {
    const S = 13_440_039_258_000
    const r = rig(async () => JSON.stringify([{ ...foreignListener, socketCreatedMs: S, listenerCreatedMs: S + 3_600_000 }]))
    expect(await takeGpuForOneShot(r.c)).toBe('left')
    expect(r.killed).toEqual([])
    expect(r.order).toEqual(['identify', 'read'])
    expect(r.said).toEqual(['port 8081 is held by a server that is not CynCo\'s: pid 9 (python.exe), started by explorer.exe. The process that made the socket on the port has ended and its number is another process\'s now (the process listed for the socket was created after it), so CynCo could not tell what holds the port, and stopped nothing; the one-shot digest-espn waits for the port.'])
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0]).toMatch(/^\[apps\] port 8081: pid 9 \(python\.exe\) was created after the socket/)
  })

  it('an app\'s server on a port that cannot be read again is stopped as it was read, through the same seam (taken)', async () => {
    const r = rig(async () => { throw new Error('powershell is gone') }, true, appHolder)
    expect(await takeGpuForOneShot(r.c)).toBe('taken')
    expect(r.killed).toEqual([4242])
    expect(readDisplaced(record)).toHaveLength(1)
  })

  it('an app\'s server is read again through the same seam: another process listening now leaves the port (left)', async () => {
    const r = rig(reading(later), true, appHolder)
    expect(await takeGpuForOneShot(r.c)).toBe('left')
    expect(r.killed).toEqual([])
    expect(r.order).toEqual(['identify', 'read'])
    expect(readDisplaced(record)).toEqual([])
  })
})

describe('TaskRunner: a one-shot takes the GPU before it asks whether the GPU is busy, and gives it back after', () => {
  it('order: take, busy check, run, give back; and give back runs when the run fails too', async () => {
    const order: string[] = []
    const runner = new TaskRunner({
      workDir: home, repoRoot: home, gpuBusyPath: join(home, 'gpu-busy.json'),
      spawnCmd: [process.execPath, '-e', 'process.exit(3)'],
      takeGpu: async (why) => { order.push(`take:${why}`) },
      isGpuBusyImpl: async () => { order.push('busy?'); return false },
      giveGpuBack: async () => { order.push('give back') },
    })
    const outcome = await runner.run({ triggerId: 'digest-espn', missionId: 'fantasy-digest', prompt: 'x', timeoutMs: 20_000 } as any)
    expect(outcome.ok).toBe(false)
    expect(order).toEqual(['take:digest-espn', 'busy?', 'give back'])
  }, 30_000)

  it('a GPU that is busy after the take (another engine holds it) still defers, and nothing is given back that was not taken by a run', async () => {
    const order: string[] = []
    const runner = new TaskRunner({
      workDir: home, repoRoot: home,
      takeGpu: async () => { order.push('take') },
      isGpuBusyImpl: async () => true,
      giveGpuBack: async () => { order.push('give back') },
    })
    await expect(runner.run({ triggerId: 't', missionId: 'm', prompt: 'x', timeoutMs: 1000 } as any)).rejects.toThrow()
    // What was taken for a run that never started is given back at once.
    expect(order).toEqual(['take', 'give back'])
  })

  it('daemon/main.ts wires both to the app module', () => {
    const src = readFileSync('engine/daemon/main.ts', 'utf-8')
    expect(src).toMatch(/takeGpu:\s*\(why\)\s*=>\s*takeGpuForOneShot\(/)
    // Ollama is asked after the port is taken, and before the busy check (slice 4).
    expect(src).toMatch(/takeGpuForOneShot\(.*\)\s*\.then\(\(\) => freeOllamaForCynco\(\{ by: `the one-shot \$\{why\}`/)
    expect(readFileSync('engine/bootstrapProvider.ts', 'utf-8')).toMatch(/processManager\.relieveGpu = \(\) => freeOllamaForCynco\(/)
    expect(src).toMatch(/giveGpuBack:\s*\(\)\s*=>\s*giveGpuBack\(/)
  })

  it('isGpuBusy itself is unchanged: any server answering on the port is busy (the take runs before it)', async () => {
    expect(await isGpuBusy(async () => '', async () => '', async () => true)).toBe(true)
  })
})
