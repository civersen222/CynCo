// The whole path with real processes (docs/decisions/2026-11-11-local-llm-apps.md).
//
// A stand-in app in a temp folder: `scripts\start-llm.cmd` starts a small HTTP
// server that answers /health on a spare port, as an app's launcher starts its
// model server; `client.js` runs from the app's folder, as the app itself does.
// Nothing here is injected: the real process reader (PowerShell + CIM), the real
// discovery, the real stop, and the real start outside the engine's job
// (Win32_Process.Create). Windows only, because every one of those is.
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
  const healthy = async (): Promise<boolean> => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }
  /** Stop whatever listens on the port, and the shell that started it. */
  const stopServer = async (): Promise<void> => {
    const tree = await readPortTree(port, undefined, () => {})
    if (!tree) return
    await stopProcess(tree.listener.pid, () => {})
    for (const a of tree.ancestors.slice(0, 1)) if (/^cmd(\.exe)?$/i.test(a.name)) await stopProcess(a.pid, () => {})
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'cynco-standin-'))
    root = join(home, 'fakegame')
    registry = join(home, 'apps.json')
    record = join(home, 'displaced-apps.json')
    port = await freePort()
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(root, 'server.js'), `require('http').createServer((q, r) => { r.end(q.url === '/health' ? 'ok' : 'no') }).listen(${port}, '127.0.0.1')\n`)
    writeFileSync(join(root, 'client.js'), 'setInterval(() => {}, 1000)\n')
    // The port is in the script, not in the environment: a restart gets the owner's profile environment, not this test's.
    writeFileSync(join(root, 'scripts', 'start-llm.cmd'), `@echo off\r\nrem stand-in for an app's llama-server launcher\r\nnode "%~dp0..\\server.js"\r\n`)
    spawn('cmd.exe', ['/c', 'scripts\\start-llm.cmd'], { cwd: root, stdio: 'ignore', windowsHide: true })
    client = spawn(process.execPath, [join(root, 'client.js')], { stdio: 'ignore', windowsHide: true })
    await until(healthy, 'the stand-in server to answer')
  }, 60_000)

  afterAll(async () => {
    try { client?.kill() } catch { /* already gone */ }
    await stopServer()
    await sleep(300)
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
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
    expect(await displaceApp(holder, { port, by: 'the stand-in test', say: m => said.push(m), kill: pid => stopProcess(pid, () => {}), file: record, log: () => {} })).toBe('displaced')
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
    expect(await displaceApp(holder, { port, by: 'the stand-in test', say: m => said.push(m), kill: pid => stopProcess(pid, () => {}), file: record, log: () => {} })).toBe('leftover')
    expect(said[0]).toMatch(/with fakegame itself not running\. CynCo stopped it to load its own model; it is not started again\.$/)
    expect(readDisplaced(record)).toEqual([])
    await until(async () => !(await portBound(port)), 'the port to be free')
  }, 120_000)
})
