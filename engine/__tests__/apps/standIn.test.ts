// The whole path with real processes (docs/decisions/2026-11-11-local-llm-apps.md).
//
// A stand-in app in a temp folder: `scripts\start-llm.cmd` starts a small HTTP
// server that answers /health on a spare port, as an app's launcher starts its
// model server; `client.js` runs from the app's folder, as the app itself does.
// Nothing here is injected: the real process reader (PowerShell + CIM), the real
// discovery, the real stop, and the real start outside the engine's job
// (Win32_Process.Create). Windows only, because every one of those is.
//
// F255: the cleanup ends only what carries this file's mark (the server, in its launcher's text, and the client and
// the first launcher, as an extra argument), never "whatever listens on the port" by a number from a fresh listing:
// once a case has freed the port, a later listing names another test's server, and a listener's number may have
// changed hands. The launcher the WMI service starts again carries no mark (its command line is the registry's);
// it is a `cmd /c` that ends by itself when its marked server ends. The real stops the cases exercise
// (`displaceApp` with `stopProcess`) are asked first whether the pid they are given is this file's server.
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identifyPortHolder } from '../../apps/identify.js'
import { displaceApp, readDisplaced, restoreDisplacedApps } from '../../apps/displace.js'
import { portBound, stopProcess } from '../../apps/gpu.js'
import { readPortTree } from '../../apps/portTree.js'
import { loadApps } from '../../apps/registry.js'
import { endMarked, isMarked, newMark, noneMarkedWithin } from '../helpers/markedProcesses.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(cond: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(200)
  }
}
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
})

describe.skipIf(process.platform !== 'win32')('an app\'s model server, taken and given back, with real processes', () => {
  let home = '', root = '', registry = '', record = '', port = 0
  let client: ChildProcess | null = null
  let launcher: ChildProcess | null = null
  const mark = newMark('standin')
  const healthy = async (): Promise<boolean> => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }
  /** The real stop, given only this file's own server: the pid it is handed must carry the mark. */
  const stopOwnServer = async (pid: number) => {
    expect(isMarked(pid, mark), `pid ${pid} is not this file's stand-in server`).toBe(true)
    return stopProcess(pid, () => {})
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'cynco-standin-'))
    root = join(home, 'fakegame')
    registry = join(home, 'apps.json')
    record = join(home, 'displaced-apps.json')
    port = await freePort()
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(home, 'notes'), { recursive: true })
    // Each stand-in ends by itself after ten minutes, longer than this file needs, so a failing case leaves nothing for ever.
    writeFileSync(join(root, 'server.js'), `require('http').createServer((q, r) => { r.end(q.url === '/health' ? 'ok' : 'no') }).listen(${port}, '127.0.0.1')\nsetTimeout(() => process.exit(0), 600000)\n`)
    writeFileSync(join(root, 'client.js'), 'setTimeout(() => {}, 600000)\n')
    // The port is in the script, not in the environment: a restart gets the owner's profile environment, not this test's.
    // The mark is in the script too, so the server the WMI service starts again carries it as well.
    writeFileSync(join(root, 'scripts', 'start-llm.cmd'), `@echo off\r\nrem stand-in for an app's llama-server launcher\r\nnode "%~dp0..\\server.js" ${mark}\r\n`)
    // The mark after the script is an argument the script ignores; discovery records the script, not the whole line.
    launcher = spawn('cmd.exe', ['/c', 'scripts\\start-llm.cmd', mark], { cwd: root, stdio: 'ignore', windowsHide: true })
    client = spawn(process.execPath, [join(root, 'client.js'), mark], { stdio: 'ignore', windowsHide: true })
    await until(healthy, 'the stand-in server to answer')
  }, 60_000)

  afterAll(async () => {
    try { client?.kill() } catch { /* already gone */ }
    try { launcher?.kill() } catch { /* already gone */ }
    // What a failing case leaves (a server, the first launcher, the client), found by the mark and nothing else.
    endMarked(mark)
    const none = await noneMarkedWithin(mark, 10_000)
    await sleep(300)
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    expect(none, 'a process carrying this file\'s mark outlived its cleanup').toBe(true)
  }, 60_000)

  it('is named after its folder, stopped for CynCo, and started again by its own launcher when CynCo is done', async () => {
    // 1. Figured out from the live process tree and the project folders, and written down.
    const holder = await identifyPortHolder(port, { registryFile: registry, roots: [root, join(home, 'notes')], log: () => {} })
    expect(holder.owner).toBe('app')
    if (holder.owner !== 'app') return
    expect(holder.app).toMatchObject({ id: 'fakegame', name: 'fakegame', root, script: 'scripts/start-llm.cmd', launch: { args: ['/c', 'scripts\\start-llm.cmd'], cwd: root } })
    expect(holder.app.launch.exe).toMatch(/cmd\.exe$/i)
    expect(holder.discovered).toBe(true)
    expect(holder.detail).toMatch(/^fakegame's model server \(pid \d+ \(node\.exe\), started by cmd\.exe scripts\/start-llm\.cmd\)$/)
    expect(loadApps(registry).map(a => a.id)).toEqual(['fakegame'])

    // 2. Taken: the client runs from the app's folder, so the app is in use and is owed its server.
    const said: string[] = []
    expect(await displaceApp(holder, { port, by: 'the stand-in test', say: m => said.push(m), kill: stopOwnServer, file: record, log: () => {} })).toBe('displaced')
    await until(async () => !(await portBound(port)), 'the port to be free')
    expect(said[0]).toMatch(/^fakegame's model server held port \d+ \(pid \d+\)\. CynCo stopped it to load its own model; it is started again when CynCo is done\.$/)
    expect(readDisplaced(record).map(d => d.appId)).toEqual(['fakegame'])

    // 3. Given back: started by the WMI service, not by this process, and it answers again.
    await restoreDisplacedApps({ gpuBusy: () => false, isPortOccupied: portBound, say: m => said.push(m), file: record, log: () => {} })
    expect(said[1]).toMatch(/^CynCo is done with the GPU: fakegame's model server is started again \(cmd\.exe \/c scripts\\start-llm\.cmd, pid \d+\)\.$/)
    await until(healthy, 'the restarted server to answer')
    expect(readDisplaced(record)).toEqual([])
    const back = await readPortTree(port, undefined, () => {})
    expect(back?.ancestors[0]?.name).toMatch(/^cmd(\.exe)?$/i)
  }, 120_000)

  it('with the app itself gone its server is a leftover: stopped, said, and not owed anything', async () => {
    client?.kill()
    client = null
    await sleep(500)
    // Known from the registry this time.
    const holder = await identifyPortHolder(port, { registryFile: registry, roots: [], log: () => {} })
    expect(holder).toMatchObject({ owner: 'app', discovered: false })
    if (holder.owner !== 'app') return
    const said: string[] = []
    expect(await displaceApp(holder, { port, by: 'the stand-in test', say: m => said.push(m), kill: stopOwnServer, file: record, log: () => {} })).toBe('leftover')
    expect(said[0]).toMatch(/with fakegame itself not running\. CynCo stopped it to load its own model; it is not started again\.$/)
    expect(readDisplaced(record)).toEqual([])
    await until(async () => !(await portBound(port)), 'the port to be free')
  }, 120_000)
})
