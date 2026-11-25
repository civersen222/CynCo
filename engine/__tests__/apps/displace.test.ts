// Taking the GPU from an app and giving it back (docs/decisions/2026-11-11-local-llm-apps.md).
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appInUse, displaceApp, readDisplaced, restoreDisplacedApps, MAX_DISPLACED_AGE_MS, type Displaced, type RestoreDeps } from '../../apps/displace.js'
import type { LocalApp } from '../../apps/registry.js'
import type { ListedProc, Proc } from '../../apps/portTree.js'

let home: string
let record: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-displace-')); record = join(home, 'displaced-apps.json') })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const ROOT = 'C:\\Users\\o\\dndai'
const app: LocalApp = {
  id: 'dndai', name: 'dndai', root: ROOT, script: 'scripts/start-llm.sh', manage: true, source: 'by hand',
  launch: { exe: 'C:\\git\\bash.exe', args: ['scripts/start-llm.sh'], cwd: ROOT },
}
const listener: Proc = { pid: 4242, name: 'llama-server.exe', exe: 'C:\\Users\\o\\.cynco\\bin\\llama-server.exe', commandLine: 'llama-server.exe --port 8081', created: 2 }

const row = (pid: number, ppid: number, commandLine: string, exe = 'C:\\x.exe'): ListedProc => ({ pid, ppid, exe, commandLine })
const serverTree = [row(4000, 1, 'bash ../scripts/start-llm.sh'), row(4242, 4000, 'llama-server.exe --port 8081'), row(4243, 4000, 'llama-server.exe --embedding --port 8082')]
const webApp = row(5000, 1, `"node.exe" "${ROOT}\\web\\node_modules\\next\\dist\\bin\\next" dev`)

describe('appInUse: is anything of the app running besides its model server?', () => {
  it('a process running from the app\'s folder means it is in use', () => {
    expect(appInUse(app, 4000, [...serverTree, webApp])).toBe(true)
    // Forward slashes and another case are the same folder.
    expect(appInUse(app, 4000, [...serverTree, row(5000, 1, 'node c:/users/o/DNDAI/web/server.js')])).toBe(true)
    // By executable path too.
    expect(appInUse(app, 4000, [...serverTree, row(5000, 1, 'game.exe', `${ROOT}\\bin\\game.exe`)])).toBe(true)
  })

  it('the terminal that ran the launcher ran the app too: a sibling of the launcher counts', () => {
    const procs = [row(3000, 1, 'WindowsTerminal.exe'), row(4000, 3000, 'bash ../scripts/start-llm.sh'), row(4242, 4000, 'llama-server.exe --port 8081'), { ...webApp, ppid: 3000 }]
    expect(appInUse(app, 4000, procs)).toBe(true)
  })

  it('the model server, what started it and what that started do not count', () => {
    expect(appInUse(app, 4000, serverTree)).toBe(false)
    // Even when the launcher was started with the folder in its command line.
    expect(appInUse(app, 4000, [row(4000, 1, `bash ${ROOT}\\scripts\\start-llm.sh`), row(4242, 4000, 'llama-server.exe --port 8081')])).toBe(false)
  })

  it('a folder whose name only starts the same is another folder', () => {
    expect(appInUse(app, 4000, [...serverTree, row(5000, 1, 'node C:\\Users\\o\\dndai-notes\\x.js')])).toBe(false)
  })
})

describe('displaceApp', () => {
  const ctx = (procs: ListedProc[], said: string[], killed: number[]) => ({
    port: 8081, by: 'the chat engine (pid 77)', file: record,
    listProcesses: async () => procs, kill: async (pid: number) => { killed.push(pid) }, say: (m: string) => said.push(m), now: () => new Date('2026-11-11T18:00:00Z'),
    // The launcher's embeddings server is taken to be still running here; what is said when it went down with the chat server is alsoLost.test.ts.
    exists: () => true, sleep: async () => {},
    // The port read again just before the stop finds the same listener (F255; what else it can find is the describe below).
    runPowerShell: async () => JSON.stringify([listener]),
  })

  it('an app in use: its server is stopped, the owner is told what happens next, and the debt is written down', async () => {
    const said: string[] = [], killed: number[] = []
    const r = await displaceApp({ app, listener, launcherPid: 4000 }, ctx([...serverTree, webApp], said, killed))
    expect(r).toBe('displaced')
    expect(killed).toEqual([4242])
    expect(said).toEqual(['dndai\'s model server held port 8081 (pid 4242). CynCo stopped it to load its own model: dndai is answered by CynCo\'s server on the same port meanwhile, and its own server is started again when CynCo is done.'])
    expect(readDisplaced(record)).toEqual([{ appId: 'dndai', name: 'dndai', root: ROOT, port: 8081, at: '2026-11-11T18:00:00.000Z', by: 'the chat engine (pid 77)', launch: app.launch }])
  })

  it('an app that is not running: its server was a leftover; stopped, said, and nothing is owed', async () => {
    const said: string[] = [], killed: number[] = []
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, ctx(serverTree, said, killed))).toBe('leftover')
    expect(killed).toEqual([4242])
    expect(said).toEqual(['dndai\'s model server held port 8081 (pid 4242) with dndai itself not running. CynCo stopped it to load its own model; it is not started again.'])
    expect(readDisplaced(record)).toEqual([])
  })

  it('a server that is not a llama-server is not promised an answer from CynCo\'s', async () => {
    const said: string[] = []
    await displaceApp({ app, listener: { ...listener, name: 'python.exe' } }, ctx([...serverTree, webApp], said, []))
    expect(said[0]).toBe('dndai\'s model server held port 8081 (pid 4242). CynCo stopped it to load its own model; it is started again when CynCo is done.')
  })

  it('a process list that cannot be read: the app is taken to be in use, so nothing is left dead on a guess', async () => {
    const said: string[] = [], killed: number[] = []
    const c = { ...ctx([], said, killed), listProcesses: async () => { throw new Error('powershell is gone') } }
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, c)).toBe('displaced')
    expect(readDisplaced(record).length).toBe(1)
  })

  it('the same app displaced twice is owed once', async () => {
    const c = ctx([...serverTree, webApp], [], [])
    await displaceApp({ app, listener, launcherPid: 4000 }, c); await displaceApp({ app, listener, launcherPid: 4000 }, c)
    expect(readDisplaced(record).length).toBe(1)
  })
})

// F255: the listener was read seconds before the stop (the owner told, the app's processes listed, the debt written).
// The port is read again immediately before it, and the server is stopped only when the same process (same pid, same
// creation time) still listens. Otherwise nothing is stopped, nothing is owed, and what is true of the port decides
// what the caller does next: free goes on as after a stop, held as after a stop that could not be done.
describe('displaceApp reads the port again just before the stop (F255)', () => {
  const later = { ...listener, pid: 2_000_000_204, name: 'python.exe', created: 9 }
  function rig(reading: () => Promise<string>, procs: ListedProc[] = [...serverTree, webApp]) {
    const said: string[] = [], killed: number[] = [], order: string[] = [], refused: string[] = [], logs: string[] = []
    let owedAtRead = -1
    const c = {
      port: 8081, by: 'the chat engine (pid 77)', file: record, now: () => new Date('2026-11-11T18:00:00Z'), exists: () => true, sleep: async () => {},
      listProcesses: async () => { order.push('list'); return procs },
      kill: async (pid: number) => { order.push('kill'); killed.push(pid) },
      say: (m: string) => said.push(m),
      refused: (why: string) => refused.push(why),
      log: (line: string) => logs.push(line),
      runPowerShell: async (script: string) => { order.push('read'); owedAtRead = readDisplaced(record).length; expect(script).toContain('-LocalPort 8081 '); return reading() },
    }
    return { c, said, killed, order, refused, logs, owedAt: () => owedAtRead }
  }
  const stoppedAsSaid = 'dndai\'s model server held port 8081 (pid 4242). CynCo stopped it to load its own model: dndai is answered by CynCo\'s server on the same port meanwhile, and its own server is started again when CynCo is done.'

  it('the same process still listens: it is stopped, and the reading came after the debt was written, right before the kill', async () => {
    const r = rig(async () => JSON.stringify([listener]))
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('displaced')
    expect(r.order).toEqual(['list', 'read', 'kill'])
    expect(r.owedAt()).toBe(1)
    expect(r.killed).toEqual([4242])
    expect(r.refused).toEqual([])
  })

  it('nothing listens any more: nothing is stopped, nothing is owed, it is said, and the caller goes on as after a stop (leftover)', async () => {
    const r = rig(async () => '')
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('leftover')
    expect(r.killed).toEqual([])
    expect(readDisplaced(record)).toEqual([])
    expect(r.refused).toEqual([])
    expect(r.said).toEqual(['dndai\'s model server on port 8081 (pid 4242) let go of the port by itself before CynCo stopped it, and nothing listens there now: CynCo stopped nothing, and owes dndai nothing.'])
  })

  it('another process listens now: nothing is stopped, nothing is owed, and the caller goes on as after a stop that could not be done (refused)', async () => {
    const r = rig(async () => JSON.stringify([later]))
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('refused')
    expect(r.killed).toEqual([])
    expect(readDisplaced(record)).toEqual([])
    const why = 'it let go of the port by itself before CynCo stopped it, and pid 2000000204 (python.exe) listens there now, which CynCo has not identified and did not stop'
    expect(r.refused).toEqual([why])
    expect(r.said).toEqual([`dndai's model server on port 8081 (pid 4242): ${why}. CynCo's model is not loaded.`])
  })

  it('the same pid created at another time is another process: nothing is stopped', async () => {
    const r = rig(async () => JSON.stringify([{ ...listener, created: 3 }]))
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('refused')
    expect(r.killed).toEqual([])
    expect(r.refused[0]).toBe('it let go of the port by itself before CynCo stopped it, and pid 4242 (llama-server.exe, a later process with the same number) listens there now, which CynCo has not identified and did not stop')
  })

  // Changed on purpose in wave 24 round three (check X-4): round two refused here. A look that could not be made decides
  // nothing, the rule `killProcessOnPort` follows: refused, the lazy engine remembered the server as one it could not stop
  // (`unstoppable`) and answered every later request with PortHeldError until its next load, for one PowerShell that
  // failed once. The stop goes ahead by the pid read earlier, as before the second look, with one log line.
  it('a port that cannot be read again: the look decided nothing, so the server is stopped as it was read, logged, and said as an ordinary stop', async () => {
    const r = rig(async () => { throw new Error('powershell is gone') })
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('displaced')
    expect(r.order).toEqual(['list', 'read', 'kill'])
    expect(r.killed).toEqual([4242])
    expect(readDisplaced(record)).toHaveLength(1)
    expect(r.refused).toEqual([])
    expect(r.said).toEqual([stoppedAsSaid])
    expect(r.logs).toEqual([
      '[apps] could not read who holds port 8081 again before stopping pid 4242: powershell is gone',
      '[apps] port 8081 could not be read again just before the stop (the reading failed): pid 4242 is stopped as it was read',
    ])
  })

  it('the same pid read again with no creation time: the two readings cannot be compared, so it is stopped as it was read, as before the second look', async () => {
    const r = rig(async () => JSON.stringify([{ ...listener, created: undefined }]))
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('displaced')
    expect(r.killed).toEqual([4242])
    expect(r.refused).toEqual([])
    expect(r.said).toEqual([stoppedAsSaid])
    expect(r.logs).toEqual(['[apps] port 8081 could not be read again just before the stop (a creation time is missing on one side, so the two readings cannot be compared): pid 4242 is stopped as it was read'])
  })

  it('the listener now listed is younger than its socket: that IS a finding about the port, so nothing is stopped (refused), and why is said', async () => {
    const S = 13_440_039_258_000
    const r = rig(async () => JSON.stringify([{ ...listener, socketCreatedMs: S, listenerCreatedMs: S + 3_600_000 }]))
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, r.c)).toBe('refused')
    expect(r.killed).toEqual([])
    expect(readDisplaced(record)).toEqual([])
    const why = 'the process that made the socket on the port has ended and its number is another process\'s now (the process listed for the socket was created after it), so CynCo could not tell what holds the port, and stopped nothing'
    expect(r.refused).toEqual([why])
    expect(r.said).toEqual([`dndai's model server on port 8081 (pid 4242): ${why}. CynCo's model is not loaded.`])
    expect(r.logs.some(l => /stopped as it was read/.test(l))).toBe(false)
  })

  it('a stop that Windows refuses still tells the caller why, through the same channel', async () => {
    const r = rig(async () => JSON.stringify([listener]))
    const c = { ...r.c, kill: async () => ({ stopped: false as const, why: 'Windows refused (Access is denied): it was started as administrator and CynCo was not' }) }
    expect(await displaceApp({ app, listener, launcherPid: 4000 }, c)).toBe('refused')
    expect(r.refused).toEqual(['Windows refused (Access is denied): it was started as administrator and CynCo was not'])
  })
})

describe('restoreDisplacedApps', () => {
  const owed: Displaced = { appId: 'dndai', name: 'dndai', root: ROOT, port: 8081, at: '2026-11-11T18:00:00.000Z', by: 'the chat engine (pid 77)', launch: app.launch }
  function rig(over: Partial<RestoreDeps> = {}, list: Displaced[] = [owed]) {
    writeFileSync(record, JSON.stringify(list))
    const said: string[] = [], launched: unknown[] = []
    const deps: RestoreDeps = {
      file: record, gpuBusy: () => false, isPortOccupied: async () => false,
      listProcesses: async () => [webApp], launch: async (l) => { launched.push(l); return 9000 },
      say: (m) => said.push(m), now: () => new Date('2026-11-11T18:20:00Z'), ...over,
    }
    return { deps, said, launched }
  }

  it('CynCo is done, the app is still running, the port is free: its server is started again with its own launcher, and the debt is cleared', async () => {
    const r = rig()
    await restoreDisplacedApps(r.deps)
    expect(r.launched).toEqual([app.launch])
    expect(r.said).toEqual(['CynCo is done with the GPU: dndai\'s model server is started again (bash.exe scripts/start-llm.sh, pid 9000).'])
    expect(readDisplaced(record)).toEqual([])
  })

  it('a one-shot still holds the GPU: nothing is started and the debt stays', async () => {
    const r = rig({ gpuBusy: () => true })
    await restoreDisplacedApps(r.deps)
    expect(r.launched).toEqual([])
    expect(readDisplaced(record)).toEqual([owed])
  })

  it('something is on the port (CynCo\'s own server, or the app\'s already back): nothing is started; the debt stays until the port is free', async () => {
    const r = rig({ isPortOccupied: async () => true })
    await restoreDisplacedApps(r.deps)
    expect(r.launched).toEqual([])
    expect(readDisplaced(record)).toEqual([owed])
  })

  it('the app is no longer running: said, not started, and the debt is dropped', async () => {
    const r = rig({ listProcesses: async () => [] })
    await restoreDisplacedApps(r.deps)
    expect(r.launched).toEqual([])
    expect(r.said).toEqual(['dndai is no longer running: its model server is not started again.'])
    expect(readDisplaced(record)).toEqual([])
  })

  it('a debt older than a day is dropped without starting anything', async () => {
    const r = rig({ now: () => new Date(Date.parse(owed.at) + MAX_DISPLACED_AGE_MS + 1) })
    await restoreDisplacedApps(r.deps)
    expect(r.launched).toEqual([])
    expect(readDisplaced(record)).toEqual([])
    expect(r.said[0]).toMatch(/dndai's model server was stopped more than 24 h ago/)
  })

  it('a launch that fails is said and the debt stays for the next try', async () => {
    const r = rig({ launch: async () => { throw new Error('access denied') } })
    await restoreDisplacedApps(r.deps)
    expect(r.said[0]).toMatch(/dndai's model server could not be started again: access denied/)
    expect(readDisplaced(record)).toEqual([owed])
  })

  it('nothing owed: nothing is read from the machine', async () => {
    let asked = 0
    const r = rig({ isPortOccupied: async () => { asked++; return false }, listProcesses: async () => { asked++; return [] } }, [])
    await restoreDisplacedApps(r.deps)
    expect(asked).toBe(0)
  })

  it('a record that is not JSON is nothing owed', async () => {
    writeFileSync(record, '{ no')
    expect(readDisplaced(record, () => {})).toEqual([])
  })
})
