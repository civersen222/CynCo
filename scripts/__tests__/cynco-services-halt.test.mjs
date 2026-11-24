// F242, slice S7, entries 4.B2 and 4.M1: scripts/cynco-services.ps1 refuses to start the daemon under
// the integrity latch and starts every other service with one warning line.
//
// The script is run for real, and only with -WhatIf. Read before this test was written: with -WhatIf
// the script reaches no cmdlet that starts, stops, registers or changes a task, a service or a process.
// `-WhatIf` with any action but start exits 2 before anything else runs; under start it asks the guard
// (`bun scripts/cynco-guard.mjs status --quiet`, which only reads the guard folder), lists processes
// and reads each task (Get-CimInstance, Get-ScheduledTask), skips the doorman's service without
// touching the network, and leaves every service at "would start (-WhatIf)", "already running" or
// "not registered", before Start-ScheduledTask. The guard folder is a temp folder outside a fake home.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'cynco-services.ps1')
const win = process.platform === 'win32'
const has = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true }).status === 0 } catch { return false } }
const ready = win && has('powershell', ['-NoProfile', '-Command', 'exit 0']) && has('bun', ['--version'])
if (win && !ready) console.log('[cynco-services-halt] SKIPPED: powershell or bun is not on PATH')

const roots = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function world() {
  const root = mkdtempSync(join(tmpdir(), 'cynco-services-halt-'))
  roots.push(root)
  const home = join(root, 'home')
  const guard = join(root, 'guard')
  mkdirSync(home)
  mkdirSync(guard)
  return { home, guard }
}

function services(w, args) {
  const env = { ...process.env, USERPROFILE: w.home, HOME: w.home, LOCALCODE_GUARD_DIR: w.guard }
  for (const k of Object.keys(env)) if (k.startsWith('CYNCO_NTFY_')) delete env[k]
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
    cwd: REPO, env, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  })
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).filter(l => l.trim() !== '')
  return { status: r.status, lines, out: lines.join('\n') }
}

const latch = (w) => writeFileSync(join(w.guard, 'HALT.json'), JSON.stringify({
  schema: 1, at: '2026-11-23T00:00:00.000Z', by: 'test', run: 'test-run', publicSummary: '1 change(s) in protected folders (first: PRESENCE)',
}))

describe.skipIf(!ready)('cynco-services.ps1 under the integrity latch (-WhatIf only)', () => {
  it('a clear guard: start -WhatIf exits 0, with no refusal and no warning', () => {
    const r = services(world(), ['start', '-WhatIf'])
    expect(r.status, r.out).toBe(0)
    expect(r.lines.some(l => l.includes('REFUSED')), r.out).toBe(false)
    expect(r.lines.some(l => l.startsWith('warning:')), r.out).toBe(false)
    expect(r.lines.some(l => l.startsWith('daemon:')), r.out).toBe(true)
  }, 120_000)

  it('a latch: start daemon -WhatIf exits 3 with the refusal line', () => {
    const w = world()
    latch(w)
    const r = services(w, ['start', 'daemon', '-WhatIf'])
    expect(r.status, r.out).toBe(3)
    expect(r.out).toContain('daemon: start REFUSED: integrity: the integrity latch is present')
  }, 120_000)

  it('the same latch: start engine -WhatIf exits 0 with a warning, and its engine line is not a refusal', () => {
    const w = world()
    latch(w)
    const r = services(w, ['start', 'engine', '-WhatIf'])
    expect(r.status, r.out).toBe(0)
    expect(r.lines.some(l => l.startsWith('warning: the integrity latch is present')), r.out).toBe(true)
    const engine = r.lines.filter(l => l.startsWith('engine:'))
    expect(engine.length, r.out).toBe(1)
    expect(engine[0]).not.toContain('REFUSED')
  }, 120_000)

  it('stop -WhatIf exits 2 and stops nothing', () => {
    const r = services(world(), ['stop', '-WhatIf'])
    expect(r.status, r.out).toBe(2)
    // Write-Error wraps its line at the console width.
    expect(r.out.replace(/\s+/g, ' ')).toContain('-WhatIf applies to start only')
    expect(r.lines.some(l => / stopped$/.test(l)), r.out).toBe(false)
  }, 120_000)
})
