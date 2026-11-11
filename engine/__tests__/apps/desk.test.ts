// The launcher a Desktop icon runs, with real processes (docs/decisions/2026-11-11-local-llm-apps.md, decision 7).
//
// A stand-in app in a temp folder: its "web app" is a small HTTP server on a port the OS chose, started
// by the recipe in a temp registry. Nothing of the owner's is started, and the browser is injected.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIcons, planIcons, shortcutArguments, startFromDesk, stepLog } from '../../apps/desk.js'
import { portBound } from '../../apps/gpu.js'
import { loadRegistry } from '../../apps/registry.js'
import type { Running } from '../../apps/start.js'

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
})
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(100)
  }
}

describe('startFromDesk', () => {
  let home = ''
  const started: Running[] = []
  afterEach(async () => {
    for (const r of started.splice(0)) if (r.pid && r.alive()) { try { process.kill(r.pid) } catch { /* it ended between the check and the kill */ } }
    await sleep(200)
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  function standIn(steps: (port: number) => unknown[], extra: Record<string, unknown> = {}) {
    home = mkdtempSync(join(tmpdir(), 'cynco-desk-'))
    const root = join(home, 'reader')
    mkdirSync(join(root, 'web'), { recursive: true })
    writeFileSync(join(root, 'web', 'server.js'), `require('http').createServer((q, r) => r.end('ok')).listen(Number(process.argv[2]), '127.0.0.1'); console.log('listening in ' + process.cwd())\n`)
    writeFileSync(join(root, 'web', 'brief.js'), `require('http').createServer((q, r) => r.end('ok')).listen(Number(process.argv[2]), '127.0.0.1'); setTimeout(() => process.exit(0), 1500)\n`)
    writeFileSync(join(root, 'web', 'broken.js'), `console.error('the config file is missing'); process.exit(3)\n`)
    const registry = join(home, 'apps.json')
    const write = (port: number) => writeFileSync(registry, JSON.stringify({
      ollamaApps: [{ id: 'reader', name: 'reader', root, models: ['m:1'], manage: true, source: 'by hand', start: { steps: steps(port), open: `http://127.0.0.1:${port}/`, ...extra } }],
    }))
    return { root, registry, write }
  }

  it('starts the app in its own folder, opens its address, and stays while it runs', async () => {
    const port = await freePort()
    const app = standIn(p => [{ name: 'web app', port: p, exe: process.execPath, args: ['server.js', String(p)], cwd: 'web' }])
    app.write(port)
    const out: string[] = []
    const opened: string[] = []
    const stop = new AbortController()
    const run = startFromDesk('reader', { print: l => out.push(l), registryFile: app.registry, home, open: async u => { opened.push(u) }, pollMs: 50, signal: stop.signal })
    await until(() => opened.length > 0, 'the address to be opened')
    expect(await portBound(port)).toBe(true)
    expect(opened).toEqual([`http://127.0.0.1:${port}/`])
    await until(() => out.some(l => /is running\. Close this window to stop its web app/.test(l)), 'the window to say what closing it stops')
    // Closing the window stops what it started.
    stop.abort()
    const result = await run
    started.push(...result.running)
    expect(result.code).toBe(0)
    await until(async () => !(await portBound(port)), 'the web app to be stopped with the window')
    expect(result.running.every(r => !r.alive())).toBe(true)
    expect(out[out.length - 1]).toBe('reader: this window was closed, and what it started is stopped.')
    expect(out.join('\n')).toMatch(/web app: started \(port \d+, \d+ s\)/)
    // The step ran in the app's own folder, and its output is where the window said.
    await until(() => /listening in .*web/.test(readFileSync(stepLog('reader', 'web app', home), 'utf-8')), 'the step\'s output in its log')
  })

  it('a second click starts nothing and opens the app again', async () => {
    const port = await freePort()
    const app = standIn(p => [{ name: 'web app', port: p, exe: process.execPath, args: ['server.js', String(p)], cwd: 'web' }])
    app.write(port)
    const stop = new AbortController()
    const opened: string[] = []
    const first = startFromDesk('reader', { print: () => {}, registryFile: app.registry, home, open: async u => { opened.push(u) }, pollMs: 50, signal: stop.signal })
    await until(() => opened.length === 1, 'the first click to open the app')
    const out: string[] = []
    const second = await startFromDesk('reader', { print: l => out.push(l), registryFile: app.registry, home, open: async u => { opened.push(u) }, pollMs: 50 })
    expect(second).toEqual({ code: 0, running: [] })
    expect(opened).toHaveLength(2)
    expect(out.join('\n')).toMatch(/web app: already running \(port \d+\)/)
    expect(out.join('\n')).toContain('reader was already running: nothing was started by this window.')
    stop.abort()
    started.push(...(await first).running)
  })

  it('a step that fails ends the start with exit code 1, the reason and the end of its output, and nothing is opened', async () => {
    const port = await freePort()
    const app = standIn(p => [{ name: 'web app', port: p, exe: process.execPath, args: ['broken.js'], cwd: 'web', waitSeconds: 30 }])
    app.write(port)
    const out: string[] = []
    const opened: string[] = []
    const result = await startFromDesk('reader', { print: l => out.push(l), registryFile: app.registry, home, open: async u => { opened.push(u) } })
    expect(result.code).toBe(1)
    expect(opened).toEqual([])
    const text = out.join('\n')
    expect(text).toMatch(/web app: its process ended \(exit code 3\) before anything listened on port \d+/)
    expect(text).toContain('the config file is missing')
    expect(text).toContain('reader is not opened.')
  })

  it('the window ends by itself when what it started has stopped', async () => {
    const port = await freePort()
    // A stand-in that ends by itself a moment after it is up, as an app the owner closes does.
    const app = standIn(p => [{ name: 'web app', port: p, exe: process.execPath, args: ['brief.js', String(p)], cwd: 'web' }])
    app.write(port)
    const out: string[] = []
    const result = await startFromDesk('reader', { print: l => out.push(l), registryFile: app.registry, home, open: async () => {}, pollMs: 50 })
    expect(result.code).toBe(0)
    expect(out.join('\n')).toMatch(/web app: stopped \(exit code 0\)/)
    expect(out.join('\n')).toContain('Everything this window started for reader has stopped.')
  })

  it('an app CynCo does not know, and one with no recipe, are each answered with what to do', async () => {
    const app = standIn(() => [])
    writeFileSync(app.registry, JSON.stringify({ ollamaApps: [{ id: 'reader', name: 'reader', root: app.root, models: [], manage: true, source: 'by hand' }] }))
    const out: string[] = []
    expect((await startFromDesk('nosuch', { print: l => out.push(l), registryFile: app.registry })).code).toBe(1)
    expect(out.join('\n')).toMatch(/CynCo knows no app called "nosuch"\. It knows: reader\./)
    out.length = 0
    expect((await startFromDesk('reader', { print: l => out.push(l), registryFile: app.registry })).code).toBe(1)
    expect(out.join('\n')).toMatch(/reader has no "start" section in .*apps\.json/)
  })

  it('opens only an http address', async () => {
    const app = standIn(() => [], { open: 'file:///C:/Windows/System32/calc.exe' })
    app.write(1)
    const out: string[] = []
    const opened: string[] = []
    const result = await startFromDesk('reader', { print: l => out.push(l), registryFile: app.registry, home, open: async u => { opened.push(u) } })
    expect(result.code).toBe(0)
    expect(opened).toEqual([])
    expect(out.join('\n')).toContain('is not an http address and is not opened')
  })
})

describe('the Desktop icons', () => {
  const REPO = 'C:\\Users\\o\\localcode'

  it('each icon looks for the launcher first and says why when it is not there', () => {
    const args = shortcutArguments(REPO, 'dndai')
    expect(args).toBe(`/d /c if exist "${REPO}\\scripts\\cynco-app.cmd" ("${REPO}\\scripts\\cynco-app.cmd" dndai) else (echo CynCo at ${REPO} has no app launcher yet: bring that checkout up to date with main, then use this icon again. & pause)`)
  })

  it('a folder name cmd would act on is escaped in the sentence, and an id that is not one is refused', () => {
    expect(shortcutArguments('C:\\Program Files (x86)\\cynco', 'a')).toContain('echo CynCo at C:\\Program Files ^(x86^)\\cynco has no app launcher yet')
    expect(() => shortcutArguments(REPO, 'a & del x')).toThrow(/cannot be an icon/)
    expect(() => shortcutArguments('C:\\100%\\x', 'a')).toThrow(/percent/)
  })

  it('one icon per app that has a recipe, named for the app', () => {
    const registry = loadRegistry(join(tmpdir(), 'no-such-apps.json'))
    registry.apps.push({ id: 'dndai', name: 'dndai', root: 'C:\\Users\\o\\dndai', script: 'scripts/start-llm.sh', launch: { exe: 'bash', args: ['scripts/start-llm.sh'], cwd: 'C:\\Users\\o\\dndai' }, manage: true, source: 'by hand', start: { steps: [], open: 'http://localhost:3000' } })
    registry.ollamaApps.push({ id: 'norecipe', name: 'norecipe', root: 'C:\\x', models: [], manage: true, source: 'by hand' })
    const plans = planIcons(registry, REPO, 'C:\\Users\\o\\Desktop', { ComSpec: 'C:\\Windows\\System32\\cmd.exe', USERPROFILE: 'C:\\Users\\o' })
    expect(plans).toEqual([{
      file: 'C:\\Users\\o\\Desktop\\dndai.lnk',
      target: 'C:\\Windows\\System32\\cmd.exe',
      arguments: shortcutArguments(REPO, 'dndai'),
      workingDirectory: 'C:\\Users\\o',
      description: 'CynCo: start dndai',
    }])
  })

  describe.skipIf(process.platform !== 'win32')('on Windows, for real', () => {
    let dir = ''
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
    it('writes a shortcut that runs the launcher with the app\'s id, leaves a stranger\'s shortcut alone, and says why when the launcher is missing', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cynco-icons-'))
      const desktop = join(dir, 'Desktop'), repo = join(dir, 'checkout')
      mkdirSync(desktop); mkdirSync(join(repo, 'scripts'), { recursive: true })
      const registry = join(dir, 'apps.json')
      const entry = (id: string) => ({ id, name: id, root: dir, models: [], manage: true, source: 'by hand', start: { steps: [], open: 'http://localhost:1' } })
      writeFileSync(registry, JSON.stringify({ ollamaApps: [entry('reader'), entry('other')] }))
      // A shortcut of the owner's own with the name of an app.
      const ps = (script: string) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`
      ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(join(desktop, 'other.lnk'))}); $s.TargetPath = $env:ComSpec; $s.Arguments = '/c echo mine'; $s.Save()`)

      const out: string[] = []
      const written = await createIcons({ repo, desktop, registryFile: registry, print: l => out.push(l) })
      expect(written).toEqual([join(desktop, 'reader.lnk')])
      expect(out.join('\n')).toMatch(/left alone .*other\.lnk/)
      expect(out.join('\n')).toMatch(/does not have scripts\\cynco-app\.cmd yet/)
      const read = ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(join(desktop, 'reader.lnk'))}); $s.TargetPath; $s.Arguments; $s.Description`).split(/\r?\n/)
      expect(read[0].toLowerCase()).toBe((process.env.ComSpec ?? '').toLowerCase())
      expect(read[1]).toBe(shortcutArguments(repo, 'reader'))
      expect(read[2]).toBe('CynCo: start reader')
      expect(ps(`(New-Object -ComObject WScript.Shell).CreateShortcut(${q(join(desktop, 'other.lnk'))}).Arguments`).trim()).toBe('/c echo mine')

      // What the icon does, run as the shortcut runs it: the checkout has no launcher, so it says so...
      const runIcon = () => ps(`$p = Start-Process -FilePath $env:ComSpec -ArgumentList ${q(read[1])} -NoNewWindow -Wait -PassThru -RedirectStandardInput ${q(join(dir, 'nul.txt'))} -RedirectStandardOutput ${q(join(dir, 'out.txt'))}; $p.ExitCode`)
      writeFileSync(join(dir, 'nul.txt'), '\r\n')
      runIcon()
      expect(readFileSync(join(dir, 'out.txt'), 'utf-8')).toContain(`CynCo at ${repo} has no app launcher yet: bring that checkout up to date with main, then use this icon again.`)
      // ...and with one it runs it with the app's id.
      writeFileSync(join(repo, 'scripts', 'cynco-app.cmd'), '@echo off\r\necho launcher ran for %1\r\n')
      runIcon()
      expect(readFileSync(join(dir, 'out.txt'), 'utf-8')).toContain('launcher ran for reader')
      expect(existsSync(join(desktop, 'reader.lnk'))).toBe(true)
    }, 60_000)
  })
})
