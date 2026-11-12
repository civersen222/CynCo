// F223: an app started from an administrator window.
//
// The live hand-off, 2026-11-11: dndai was started from an elevated PowerShell. From the engine, which is
// not elevated, the command line and the path of its llama-server and of the bash that started it read as
// nothing, so the launcher script could not be found and the server stayed "a server that is not CynCo's".
// What can still be read: the names in the parent chain, and the app's own processes that are not elevated.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identifyPortHolder } from '../../apps/identify.js'
import { loadApps, saveApp, type LocalApp } from '../../apps/registry.js'
import type { ListedProc, PortTree, Proc } from '../../apps/portTree.js'

let home: string
let registry: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-apps-elevated-'))
  registry = join(home, 'apps.json')
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

/** A process as an elevated one reads from a process that is not: a name and a pid, nothing else. */
const elevated = (pid: number, name: string): Proc => ({ pid, name, exe: null, commandLine: null, created: pid })
const tree: PortTree = { listener: elevated(29720, 'llama-server.exe'), ancestors: [elevated(29000, 'bash.exe'), elevated(28000, 'powershell.exe')] }

function project(name: string, files: Record<string, string>): string {
  const dir = join(home, name)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}
const LAUNCHER = 'PORT="${LLM_PORT:-8081}"\n"$BIN" -m "$MODEL" --port "$PORT"   # llama-server\n'
/** The app's web server, running from its folder and not elevated. */
const webOf = (root: string): ListedProc => ({ pid: 500, ppid: 400, exe: 'C:\\Program Files\\nodejs\\node.exe', commandLine: `node "${join(root, 'web', 'node_modules', 'next', 'dist', 'bin', 'next')}" dev` })
const registered = (root: string, id = 'dndai'): LocalApp => ({ id, name: id, root, script: 'scripts/start-llm.sh', launch: { exe: 'bash', args: ['scripts/start-llm.sh'], cwd: root }, manage: true, source: 'by hand' })
const ask = (roots: string[], procs: ListedProc[]) => identifyPortHolder(8081, { readTree: async () => tree, registryFile: registry, roots, listProcesses: async () => procs, log: () => {} })

describe('a server whose launcher cannot be read', () => {
  it('is the registered app with that kind of launcher that is running', async () => {
    const root = project('dndai', { 'scripts/start-llm.sh': LAUNCHER })
    saveApp(registered(root), registry)
    const holder = await ask([root], [webOf(root)])
    expect(holder).toMatchObject({ owner: 'app', app: { id: 'dndai' }, discovered: false, launcherPid: 29000 })
    expect(holder.detail).toMatch(/dndai's model server \(pid 29720 \(llama-server\.exe\)/)
    expect(holder.detail).toMatch(/cannot be read.*administrator/)
  })

  it('is not guessed between two registered apps that are both running', async () => {
    const a = project('dndai', { 'scripts/start-llm.sh': LAUNCHER }), b = project('other', { 'scripts/start-llm.sh': LAUNCHER })
    saveApp(registered(a), registry)
    saveApp(registered(b, 'other'), registry)
    expect((await ask([a, b], [webOf(a), webOf(b)])).owner).toBe('foreign')
    // ...and is the one of them that is running.
    expect(await ask([a, b], [webOf(b)])).toMatchObject({ owner: 'app', app: { id: 'other' } })
  })

  it('is found among the project folders something is running from: the one with a script of that kind that starts a model server on this port', async () => {
    const root = project('dndai', { 'scripts/start-llm.sh': LAUNCHER, 'fix-pg.sh': 'service postgresql restart\n', 'scripts/embed.sh': '"$BIN" --embedding --port 8082   # llama-server\n' })
    const idle = project('idle-game', { 'scripts/start-llm.sh': LAUNCHER })
    const holder = await ask([root, idle], [webOf(root)])
    expect(holder).toMatchObject({ owner: 'app', app: { id: 'dndai', root, script: 'scripts/start-llm.sh' }, discovered: true, launcherPid: 29000 })
    const saved = loadApps(registry)
    expect(saved).toHaveLength(1)
    expect(saved[0].launch).toEqual({ exe: 'bash.exe', args: ['scripts/start-llm.sh'], cwd: root })
    expect(saved[0].source).toMatch(/command line could not be read/)
    expect(saved[0].source).toMatch(/the only project folder with a running process and a \.sh script that starts a model server on port 8081/)
  })

  it('is not guessed when two running projects, or two scripts in one, could have started it', async () => {
    const a = project('dndai', { 'scripts/start-llm.sh': LAUNCHER }), b = project('other', { 'run.sh': LAUNCHER })
    expect((await ask([a, b], [webOf(a), webOf(b)])).owner).toBe('foreign')
    const two = project('two', { 'scripts/start-llm.sh': LAUNCHER, 'scripts/start-big.sh': LAUNCHER })
    expect((await ask([two], [webOf(two)])).owner).toBe('foreign')
    expect(loadApps(registry)).toEqual([])
  })

  it('stays a server that is not CynCo\'s when nothing of any project is running, or the process list cannot be read', async () => {
    const root = project('dndai', { 'scripts/start-llm.sh': LAUNCHER })
    saveApp(registered(root), registry)
    expect(await ask([root], [])).toMatchObject({ owner: 'foreign', listener: { pid: 29720 } })
    const failed = await identifyPortHolder(8081, { readTree: async () => tree, registryFile: registry, roots: [root], listProcesses: async () => { throw new Error('CIM is busy') }, log: () => {} })
    expect(failed.owner).toBe('foreign')
  })

  it('does not replace the reading of a launcher that can be read', async () => {
    // A readable bash running some other script: the server is that script's, whatever is running from a registered app's folder.
    const root = project('dndai', { 'scripts/start-llm.sh': LAUNCHER })
    saveApp(registered(root), registry)
    const readable: PortTree = { listener: elevated(29720, 'llama-server.exe'), ancestors: [{ pid: 29000, name: 'bash.exe', exe: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', commandLine: 'bash tools/other-server.sh', created: 1 }] }
    const holder = await identifyPortHolder(8081, { readTree: async () => readable, registryFile: registry, roots: [root], listProcesses: async () => [webOf(root)], log: () => {} })
    expect(holder.owner).toBe('foreign')
  })
})
