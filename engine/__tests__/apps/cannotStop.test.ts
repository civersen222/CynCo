// F223: "stopped" is said after the server is gone, never before.
//
// The live hand-off, 2026-11-11: the owner's game ran from an administrator window. `taskkill` was refused,
// nothing read the refusal, and the chat was told the server had been stopped; five seconds later the log
// said the port was still bound. A stop now answers whether the process is gone, and every sentence that
// says "stopped" waits for that answer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displaceApp, readDisplaced } from '../../apps/displace.js'
import { lazyAppDeps, stopProcess, takeGpuForOneShot, type Stopped } from '../../apps/gpu.js'
import type { Holder } from '../../apps/identify.js'
import type { ListedProc, Proc } from '../../apps/portTree.js'
import type { LocalApp } from '../../apps/registry.js'

let home: string
let record: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-cannot-stop-')); record = join(home, 'displaced-apps.json') })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const ROOT = 'C:\\Users\\o\\dndai'
const app: LocalApp = { id: 'dndai', name: 'dndai', root: ROOT, script: 'scripts/start-llm.sh', manage: true, source: 'by hand', launch: { exe: 'bash', args: ['scripts/start-llm.sh'], cwd: ROOT } }
const listener: Proc = { pid: 29720, name: 'llama-server.exe', exe: null, commandLine: null, created: 2 }
const webApp: ListedProc = { pid: 5000, ppid: 1, exe: 'C:\\node.exe', commandLine: `node "${ROOT}\\web\\node_modules\\next\\dist\\bin\\next" dev` }
const DENIED: Stopped = { stopped: false, why: 'Windows refused (Access is denied): it was started as administrator and CynCo was not' }
const appHolder: Holder = { owner: 'app', app, detail: 'dndai\'s model server (pid 29720 (llama-server.exe), started by bash.exe)', listener, discovered: false, launcherPid: 29000 }
const foreign: Holder = { owner: 'foreign', detail: 'pid 29720 (llama-server.exe), started by bash.exe', listener }

describe('stopProcess says whether the process is gone', () => {
  const run = (answer: string | null, existsFor = 0) => {
    let looks = 0
    return stopProcess(29720, () => {}, { platform: 'win32', taskkill: async () => answer, exists: () => looks++ < existsFor, sleep: async () => {} })
  }

  it('gone: stopped', async () => {
    expect(await run(null, 2)).toEqual({ stopped: true })
  })

  it('refused by Windows: not stopped, and why in words the owner can act on', async () => {
    expect(await run('ERROR: The process with PID 29720 could not be terminated.\r\nReason: Access is denied.\r\n', 99)).toEqual(DENIED)
  })

  it('a kill that reported nothing and a process that is still there: not stopped', async () => {
    expect(await run(null, 9999)).toEqual({ stopped: false, why: 'it was still running 3 s after the kill' })
  })

  it('a process that had already ended is stopped', async () => {
    expect(await run('ERROR: The process "29720" not found.\r\n', 0)).toEqual({ stopped: true })
  })
})

describe('displaceApp and a server that cannot be stopped', () => {
  it('says it could not, why, and what the owner can do; nothing is owed and nothing is called stopped', async () => {
    const said: string[] = []
    const outcome = await displaceApp({ app: { ...app, start: { steps: [], open: 'http://localhost:3000' } }, listener, launcherPid: 29000 }, {
      port: 8081, by: 'the chat engine (pid 77)', file: record, listProcesses: async () => [webApp], kill: async () => DENIED, say: m => said.push(m),
    })
    expect(outcome).toBe('refused')
    expect(said).toEqual([
      'dndai\'s model server holds port 8081 (pid 29720). CynCo could not stop it: Windows refused (Access is denied): it was started as administrator and CynCo was not. ' +
      'dndai keeps its server and CynCo\'s model is not loaded. Close the window dndai was started from, or start dndai from its Desktop icon, which does not run as administrator and which CynCo can manage.',
    ])
    expect(readDisplaced(record)).toEqual([])
  })

  it('names no icon for an app that has none', async () => {
    const said: string[] = []
    await displaceApp({ app, listener, launcherPid: 29000 }, { port: 8081, by: 'x', file: record, listProcesses: async () => [webApp], kill: async () => DENIED, say: m => said.push(m) })
    expect(said[0]).toMatch(/Close the window dndai was started from, or start dndai again from a window that is not run as administrator\.$/)
  })

  it('a kill that answers nothing is taken at its word, as before', async () => {
    const said: string[] = []
    expect(await displaceApp({ app, listener, launcherPid: 29000 }, { port: 8081, by: 'x', file: record, listProcesses: async () => [webApp], kill: async () => {}, say: m => said.push(m) })).toBe('displaced')
    expect(said[0]).toMatch(/CynCo stopped it to load its own model/)
    expect(readDisplaced(record)).toHaveLength(1)
  })
})

describe('the chat engine and the one-shot hear the outcome', () => {
  it('lazyAppDeps.takeFromApp answers refused, so the engine does not wait for a port that will not be freed', async () => {
    const said: string[] = []
    const deps = lazyAppDeps(8081, { identify: async () => appHolder, kill: async () => DENIED, listProcesses: async () => [webApp], file: record })
    expect((await deps.portOwner()).owner).toBe('app')
    expect(await deps.takeFromApp(m => said.push(m))).toEqual({ refused: 'Windows refused (Access is denied): it was started as administrator and CynCo was not' })
    expect(said[0]).toMatch(/CynCo could not stop it/)
  })

  it('a one-shot behind an app\'s server it cannot stop leaves it, having said so once', async () => {
    const said: string[] = []
    let waited = 0
    const r = await takeGpuForOneShot({ port: 8081, by: 'the one-shot digest-espn', say: m => said.push(m), portAnswers: async () => true, identify: async () => appHolder, kill: async () => DENIED, listProcesses: async () => [webApp], waitFree: async () => { waited++; return false }, file: record })
    expect(r).toBe('left')
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/CynCo could not stop it/)
    expect(waited).toBe(0)
  })

  it('a one-shot says a server that is not CynCo\'s was stopped only once the port is free', async () => {
    const said: string[] = []
    const order: string[] = []
    const r = await takeGpuForOneShot({ port: 8081, by: 'the one-shot digest-espn', say: m => { order.push('said'); said.push(m) }, portAnswers: async () => true, identify: async () => foreign, kill: async () => { order.push('kill'); return { stopped: true } }, waitFree: async () => { order.push('free'); return true } })
    expect(r).toBe('taken')
    expect(order).toEqual(['kill', 'free', 'said'])
    expect(said).toEqual(['port 8081 was held by a server that is not CynCo\'s: pid 29720 (llama-server.exe), started by bash.exe. Stopped it for the one-shot digest-espn.'])
  })

  it('a one-shot that could not stop it says that, and never "stopped"', async () => {
    const said: string[] = []
    const r = await takeGpuForOneShot({ port: 8081, by: 'the one-shot digest-espn', say: m => said.push(m), portAnswers: async () => true, identify: async () => foreign, kill: async () => DENIED, waitFree: async () => false })
    expect(r).toBe('left')
    expect(said).toEqual(['port 8081 is held by a server that is not CynCo\'s: pid 29720 (llama-server.exe), started by bash.exe. CynCo could not stop it: Windows refused (Access is denied): it was started as administrator and CynCo was not. Close the window it was started from; the one-shot digest-espn waits for the port.'])
  })
})
