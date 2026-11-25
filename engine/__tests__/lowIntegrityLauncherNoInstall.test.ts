/**
 * B4 (wave 19): Bun never fetches a package by itself where this module starts it. The low-integrity
 * launcher (and the establish's probe, which starts the same form) is Bun started as
 * `<bun> --no-env-file --config=<checkout>/engine/lowIntegrityLauncher.bunfig.toml <script>`; Bun reads no
 * other bunfig then, so that file says `[install] auto = "disable"`.
 *
 * How an attempt is seen: the registry is pointed, for each Bun this test starts and for it alone, at a
 * listener of this test on a loopback port the system picks, which counts a connection and closes it at
 * once (it serves nothing, so nothing can be downloaded). A closed port cannot tell an attempt from none:
 * Bun 1.3.13 prints the same `Cannot find package` either way (measured 2026-11-25).
 *
 * Measured 2026-11-25 (w19 scratch b, out/b4-probe.txt, b4-probe2.txt): Bun decides by the folder of the
 * SCRIPT (a node_modules folder anywhere above it turns auto-install off), not by its working folder; a
 * bunfig.toml is read from the working folder, and not at all when --config names one; none of these variables
 * stops it (BUN_CONFIG_SKIP_INSTALL_PACKAGES, NODE_PATH, BUN_INSTALL, a .bunfig.toml in HOME or XDG_CONFIG_HOME: 6
 * connections each); BUN_OPTIONS holding --no-install does, even against --install=force and auto = "fallback"
 * (wave 19b, measured 2026-11-25; toolEnv gives it to every contained child: the last case below). On this PC every folder a test may write lies under the home, which holds a
 * node_modules of the owner's, so here the default already installs nothing: the control below therefore
 * asks for `auto = "fallback"` (install what is missing even beside a node_modules), which the launcher's
 * own file then must refuse. The launcher's form with the file as it was, outside any node_modules tree,
 * opened 6 connections (out/b4-probe.txt, P8).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containedCommand, engineCheckout, testContainment, toolEnv } from '../containment.js'

const LAUNCHER_BUNFIG = join(engineCheckout(), 'engine', 'lowIntegrityLauncher.bunfig.toml')

/** `[install]` then `auto = "disable"` before any other table: what Bun reads from the file. */
function installAuto(text: string): string | null {
  let table = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const t = /^\[([^\]]+)\]$/.exec(line)
    if (t) { table = t[1].trim(); continue }
    const kv = /^auto\s*=\s*"([^"]*)"$/.exec(line)
    if (table === 'install' && kv) return kv[1]
  }
  return null
}

function findBunExe(): string | null {
  const r = spawnSync('bun', ['--print', 'process.execPath'], { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 15_000 })
  const exe = r.status === 0 ? r.stdout.trim().split(/\r?\n/).pop() ?? '' : ''
  return exe !== '' && existsSync(exe) ? exe : null
}

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

describe('B4: the launcher\'s bunfig', () => {
  it('says [install] auto = "disable", the one setting Bun reads for a start that names its config', () => {
    expect(installAuto(readFileSync(LAUNCHER_BUNFIG, 'utf-8'))).toBe('disable')
  })

  it('the reader of this test: a table, a comment and another table', () => {
    expect(installAuto('# x\n[install]\nauto = "disable" # no\n')).toBe('disable')
    expect(installAuto('[run]\nauto = "disable"\n')).toBeNull()
    expect(installAuto('# only a comment\n')).toBeNull()
  })
})

const bunExe = process.platform === 'win32' ? findBunExe() : null
const skip = process.platform !== 'win32' ? 'not Windows: the launcher runs only there' : bunExe === null ? 'bun is not on PATH (or did not name its executable within 15 s)' : null
if (skip) console.log(`[lowIntegrityLauncherNoInstall] SKIPPED the live start: ${skip}`)

describe.skipIf(skip !== null)('B4: Bun started as this module starts the launcher opens no registry connection (live)', () => {
  it('the launcher\'s start form with a missing import: no connection; the same form with only auto = "fallback": connections (the test sees an attempt)', async () => {
    const t = mkdtempSync(join(tmpdir(), 'cynco-noinstall-'))
    made.push(t)
    const work = join(t, 'work')
    mkdirSync(work)
    writeFileSync(join(work, 'toy.mjs'), 'import x from "cynco-nowhere-pkg-zz"\nconsole.log("loaded", typeof x)\n')
    const control = join(t, 'fallback.bunfig.toml')
    writeFileSync(control, '[install]\nauto = "fallback"\n')
    // The head of the launcher's own argv, exactly as containedCommand builds it, up to its config.
    const ctx = testContainment({
      missionCwd: work, sandbox: { root: join(t, 'run'), home: join(t, 'run', 'home'), tmp: join(t, 'run', 'tmp'), scratch: join(t, 'run', 'scratch') },
      home: join(t, 'home'), folders: { state: join(t, 'state'), models: join(t, 'models'), guard: join(t, 'guard'), audit: null },
    })
    const c = containedCommand({ file: 'x', args: [], shell: true }, { ctx, platform: 'win32', execPath: bunExe! })
    const head = c.args.slice(0, c.args.findIndex(a => a.startsWith('--config=')) + 1)
    expect(head).toEqual(['--no-env-file', `--config=${LAUNCHER_BUNFIG}`])

    let hits = 0
    const server = createServer(s => { hits++; s.destroy() })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const start = (args: string[]) => new Promise<{ code: number | null; out: string; connections: number }>(resolve => {
      const before = hits
      const env = { ...process.env, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${port}/`, BUN_INSTALL_CACHE_DIR: join(t, 'cache'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }
      const p = spawn(bunExe!, args, { cwd: work, env, windowsHide: true })
      let out = ''
      p.stdout.on('data', d => { out += String(d) })
      p.stderr.on('data', d => { out += String(d) })
      const timer = setTimeout(() => p.kill(), 50_000)
      p.on('close', code => { clearTimeout(timer); resolve({ code, out, connections: hits - before }) })
    })
    try {
      const seen = await start(['--no-env-file', `--config=${control}`, join(work, 'toy.mjs')])
      expect(seen.connections, seen.out).toBeGreaterThan(0)
      const launcher = await start([...head, join(work, 'toy.mjs')])
      expect(launcher.connections, launcher.out).toBe(0)
      expect(launcher.code).not.toBe(0)
      expect(launcher.out).toContain("Cannot find package 'cynco-nowhere-pkg-zz'")
    } finally {
      server.close()
    }
  }, 120_000)

  // Wave 19b: the launcher's own Bun is held by its bunfig; a contained child's own `bun` is started by
  // the run's command, with no --config of ours, so toolEnv hands it BUN_OPTIONS holding --no-install.
  // Before the change toolEnv gave it nothing (measured through the launcher: the install cache was made,
  // scratch b5-launcher-before.txt). Here the child's Bun is asked for `auto = "fallback"` (the control
  // above shows that fetches) and also passes --install=force on its own command line.
  it('a contained child\'s own Bun, with the environment toolEnv gives it, opens no registry connection even when it asks to install', async () => {
    const t = mkdtempSync(join(tmpdir(), 'cynco-noinstall-'))
    made.push(t)
    const work = join(t, 'work')
    mkdirSync(work)
    writeFileSync(join(work, 'toy.mjs'), 'import x from "cynco-nowhere-pkg-zz"\nconsole.log("loaded", typeof x)\n')
    const control = join(t, 'fallback.bunfig.toml')
    writeFileSync(control, '[install]\nauto = "fallback"\n')
    const ctx = testContainment({
      missionCwd: work, sandbox: { root: join(t, 'run'), home: join(t, 'run', 'home'), tmp: join(t, 'run', 'tmp'), scratch: join(t, 'run', 'scratch') },
      home: join(t, 'home'), folders: { state: join(t, 'state'), models: join(t, 'models'), guard: join(t, 'guard'), audit: null },
    })
    let hits = 0
    const server = createServer(s => { hits++; s.destroy() })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const start = (args: string[], env: Record<string, string | undefined>) => new Promise<{ code: number | null; out: string; connections: number }>(resolve => {
      const before = hits
      const p = spawn(bunExe!, args, { cwd: work, env: { ...env, BUN_CONFIG_REGISTRY: `http://127.0.0.1:${port}/`, BUN_INSTALL_CACHE_DIR: join(t, 'cache'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, windowsHide: true })
      let out = ''
      p.stdout.on('data', d => { out += String(d) })
      p.stderr.on('data', d => { out += String(d) })
      const timer = setTimeout(() => p.kill(), 50_000)
      p.on('close', code => { clearTimeout(timer); resolve({ code, out, connections: hits - before }) })
    })
    try {
      const argv = ['--no-env-file', `--config=${control}`, '--install=force', join(work, 'toy.mjs')]
      const plain = { ...process.env }
      delete plain.BUN_OPTIONS
      const seen = await start(argv, plain)
      expect(seen.connections, seen.out).toBeGreaterThan(0)
      // The environment a contained child is given (only the keys that matter here are read from it).
      const env = toolEnv(plain, ctx, 'win32')
      expect(env.BUN_OPTIONS).toBe('--no-install')
      const child = await start(argv, { ...plain, BUN_OPTIONS: env.BUN_OPTIONS })
      expect(child.connections, child.out).toBe(0)
      expect(child.code).not.toBe(0)
      // What the model sees when its script imports a package that is not installed.
      expect(child.out).toContain("error: Cannot find package 'cynco-nowhere-pkg-zz'")
    } finally {
      server.close()
    }
  }, 120_000)
})
