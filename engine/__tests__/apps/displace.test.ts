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
