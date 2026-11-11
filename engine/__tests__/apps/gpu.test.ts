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

describe('lazyAppDeps: what the lazy chat engine is given', () => {
  it('portOwner names the app, and takeFromApp stops that server, says so and writes down what is owed', async () => {
    const killed: number[] = [], said: string[] = []
    const d = lazyAppDeps(8081, { identify: async () => appHolder, kill: async (pid) => { killed.push(pid) }, listProcesses: async () => inUse, file: record, by: 'the chat engine (pid 77)' })
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
})

describe('takeGpuForOneShot: the same rule for an unattended run', () => {
  const ctx = (h: Holder | null, killed: number[], said: string[]) => ({
    port: 8081, by: 'the one-shot digest-espn', file: record,
    portAnswers: async () => h !== null, identify: async () => h ?? ({ owner: 'unknown', detail: 'x' } as Holder),
    kill: async (pid: number) => { killed.push(pid) }, listProcesses: async () => inUse, say: (m: string) => said.push(m),
    waitFree: async () => true,
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
    expect(src).toMatch(/giveGpuBack:\s*\(\)\s*=>\s*giveGpuBack\(/)
  })

  it('isGpuBusy itself is unchanged: any server answering on the port is busy (the take runs before it)', async () => {
    expect(await isGpuBusy(async () => '', async () => '', async () => true)).toBe(true)
  })
})
