// Whose server is on the model port, by name (docs/decisions/2026-11-11-local-llm-apps.md).
//
// F202 could say "a server that is not CynCo's". The owner's game, dndai, starts
// CynCo's own llama-server from `bash scripts/start-llm.sh`; these tests use the
// shape of that process tree with made-up folders.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverApp, identifyPortHolder, launcherOf, matchApp } from '../../apps/identify.js'
import { loadApps, saveApp, type LocalApp } from '../../apps/registry.js'
import type { PortTree, Proc } from '../../apps/portTree.js'

let home: string
let registry: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-apps-'))
  registry = join(home, 'apps.json')
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const proc = (pid: number, name: string, commandLine: string, exe: string | null = `C:\\bin\\${name}`): Proc => ({ pid, name, exe, commandLine, created: pid })
const LLAMA = 'C:\\Users\\o\\.cynco\\bin\\llama-server.exe'
const server = proc(4242, 'llama-server.exe', `"${LLAMA}" -m C:/Users/o/.cynco/models/q.gguf --host 127.0.0.1 --port 8081 --ctx-size 65536`, LLAMA)
const bash = proc(4000, 'bash.exe', '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" ../scripts/start-llm.sh', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe')
const npm = proc(3900, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run llm')
const gameTree: PortTree = { listener: server, ancestors: [bash, npm] }

/** A project folder with a launcher script; returns its path. */
function project(name: string, script = 'scripts/start-llm.sh', text = '"$BIN" -m "$MODEL" --port 8081   # llama-server'): string {
  const dir = join(home, name)
  mkdirSync(join(dir, script, '..'), { recursive: true })
  writeFileSync(join(dir, script), text)
  return dir
}

describe('launcherOf: the script that started the server', () => {
  it('bash with a relative script: the nearest shell wins over npm above it, and ../ is dropped', () => {
    expect(launcherOf(gameTree)).toMatchObject({ script: 'scripts/start-llm.sh', kind: 'bash', proc: { pid: 4000 } })
  })

  it('cmd /c, powershell -File, python and node are launchers too', () => {
    const t = (p: Proc): PortTree => ({ listener: server, ancestors: [p] })
    expect(launcherOf(t(proc(1, 'cmd.exe', 'C:\\Windows\\SYSTEM32\\cmd.exe /c ""C:\\Users\\o\\game\\scripts\\run-server.cmd""')))).toMatchObject({ script: 'C:/Users/o/game/scripts/run-server.cmd', kind: 'cmd' })
    expect(launcherOf(t(proc(1, 'powershell.exe', 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\start.ps1')))).toMatchObject({ script: 'start.ps1', kind: 'powershell' })
    expect(launcherOf(t(proc(1, 'python.exe', 'python -X utf8 tools\\serve.py --port 8081')))).toMatchObject({ script: 'tools/serve.py', kind: 'python' })
    expect(launcherOf(t(proc(1, 'node.exe', 'node server/start.mjs')))).toMatchObject({ script: 'server/start.mjs', kind: 'node' })
  })

  it('a POSIX-style absolute path from Git Bash becomes a Windows one', () => {
    const t: PortTree = { listener: server, ancestors: [proc(1, 'bash.exe', 'bash /c/Users/o/game/scripts/start-llm.sh')] }
    expect(launcherOf(t)?.script).toBe('C:/Users/o/game/scripts/start-llm.sh')
  })

  it('no ancestor, or ancestors that run no script, is no launcher', () => {
    expect(launcherOf({ listener: server, ancestors: [] })).toBeNull()
    expect(launcherOf({ listener: server, ancestors: [proc(1, 'explorer.exe', 'C:\\Windows\\explorer.exe')] })).toBeNull()
    expect(launcherOf({ listener: server, ancestors: [proc(1, 'bash.exe', 'bash -c "llama-server --port 8081"')] })).toBeNull()
  })
})

describe('discoverApp: figuring out which project a server belongs to', () => {
  it('the one project folder that has the launcher script, and whose script starts a model server, is the app', () => {
    const dir = project('dndai')
    project('notes', 'scripts/other.sh')
    const app = discoverApp(gameTree, { roots: [dir, join(home, 'notes')], now: () => new Date('2026-11-11T18:00:00Z') })
    expect(app).toMatchObject({
      id: 'dndai', name: 'dndai', root: dir, script: 'scripts/start-llm.sh', manage: true,
      launch: { exe: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', args: ['scripts/start-llm.sh'], cwd: dir },
    })
    expect(app!.source).toContain('pid 4242')
    expect(app!.source).toContain('scripts/start-llm.sh')
  })

  it('two folders with the same script: not guessed', () => {
    const a = project('game-a'), b = project('game-b')
    expect(discoverApp(gameTree, { roots: [a, b] })).toBeNull()
  })

  it('a script that starts no model server is not an app launcher', () => {
    const dir = project('site', 'scripts/start-llm.sh', 'npm run dev')
    expect(discoverApp(gameTree, { roots: [dir] })).toBeNull()
  })

  it('an absolute script path names its own folder', () => {
    const dir = project('game')
    const abs = join(dir, 'scripts', 'start-llm.sh').replace(/\\/g, '/')
    const tree: PortTree = { listener: server, ancestors: [proc(1, 'bash.exe', `bash ${abs}`, 'C:\\git\\bash.exe')] }
    expect(discoverApp(tree, { roots: [dir, project('other')] })).toMatchObject({ id: 'game', script: 'scripts/start-llm.sh' })
  })

  it('no launcher, nothing to discover', () => {
    expect(discoverApp({ listener: server, ancestors: [] }, { roots: [project('dndai')] })).toBeNull()
  })
})

describe('matchApp: a server the registry already knows', () => {
  const app = (over: Partial<LocalApp> = {}): LocalApp => ({
    id: 'dndai', name: 'dndai', root: 'C:\\Users\\o\\dndai', script: 'scripts/start-llm.sh', manage: true, source: 'by hand',
    launch: { exe: 'bash.exe', args: ['scripts/start-llm.sh'], cwd: 'C:\\Users\\o\\dndai' }, ...over,
  })

  it('matches on the launch script, whatever the case and the slashes', () => {
    expect(matchApp(gameTree, [app()])?.id).toBe('dndai')
    expect(matchApp(gameTree, [app({ script: 'Scripts\\Start-LLM.sh' })])?.id).toBe('dndai')
    expect(matchApp(gameTree, [app({ script: 'scripts/other.sh' })])).toBeNull()
  })

  it('two registered apps with the same relative script are told apart only by an absolute path', () => {
    const two = [app(), app({ id: 'other', name: 'other', root: 'C:\\Users\\o\\other' })]
    expect(matchApp(gameTree, two)).toBeNull()
    const abs: PortTree = { listener: server, ancestors: [proc(1, 'bash.exe', 'bash C:/Users/o/other/scripts/start-llm.sh')] }
    expect(matchApp(abs, two)?.id).toBe('other')
  })
})

describe('identifyPortHolder', () => {
  const deps = (tree: PortTree | null, roots: string[] = []) => ({ readTree: async () => tree, registryFile: registry, roots, log: () => {} })

  it('a CynCo engine\'s server is still an engine\'s: the child of a running bun', async () => {
    const tree: PortTree = { listener: server, ancestors: [proc(9, 'bun.exe', 'bun engine\\main.ts')] }
    expect(await identifyPortHolder(8081, deps(tree, [project('dndai')]))).toMatchObject({ owner: 'engine' })
  })

  it('an app\'s server is named, and what was figured out is written to the registry with the evidence', async () => {
    const dir = project('dndai')
    const h = await identifyPortHolder(8081, deps(gameTree, [dir]))
    expect(h).toMatchObject({ owner: 'app', app: { id: 'dndai', root: dir }, discovered: true })
    expect(h.detail).toBe('dndai\'s model server (pid 4242 (llama-server.exe), started by bash.exe scripts/start-llm.sh)')
    const saved = loadApps(registry)
    expect(saved.map(a => a.id)).toEqual(['dndai'])
    expect(JSON.parse(readFileSync(registry, 'utf-8')).version).toBe(1)
    // The second time it is read from the registry, not discovered again.
    expect(await identifyPortHolder(8081, deps(gameTree, []))).toMatchObject({ owner: 'app', discovered: false })
  })

  it('an app the owner switched off is not managed: it reads as foreign, as before', async () => {
    const dir = project('dndai')
    saveApp({ id: 'dndai', name: 'dndai', root: dir, script: 'scripts/start-llm.sh', manage: false, source: 'by hand', launch: { exe: 'bash', args: ['scripts/start-llm.sh'], cwd: dir } }, registry)
    expect(await identifyPortHolder(8081, deps(gameTree, [dir]))).toMatchObject({ owner: 'foreign' })
  })

  it('a server nobody can be found for stays foreign, with who started it', async () => {
    const h = await identifyPortHolder(8081, deps({ listener: server, ancestors: [proc(1, 'explorer.exe', 'explorer.exe')] }))
    expect(h).toMatchObject({ owner: 'foreign' })
    expect(h.detail).toContain('started by explorer.exe')
  })

  it('a port nobody could be read for is unknown', async () => {
    expect(await identifyPortHolder(8081, deps(null))).toMatchObject({ owner: 'unknown' })
  })

  it('a registry file that is not JSON reads as empty and does not stop the engine', async () => {
    writeFileSync(registry, '{ not json')
    expect(loadApps(registry, () => {})).toEqual([])
    expect(await identifyPortHolder(8081, deps(gameTree, [project('dndai')]))).toMatchObject({ owner: 'app' })
  })
})
