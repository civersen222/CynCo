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
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'cynco-services.ps1')
const win = process.platform === 'win32'
const has = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true }).status === 0 } catch { return false } }
const ready = win && has('powershell', ['-NoProfile', '-Command', 'exit 0']) && has('bun', ['--version'])
if (win && !ready) console.log('[cynco-services-halt] SKIPPED: powershell or bun is not on PATH')

const roots = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

// Wave 15c (check CB1-R3): the fake home has an AppData\Local and the child runs in this test's own folder.
// Windows PowerShell finds its local application data through USERPROFILE (User Shell Folders), and with no
// such folder in the fake home it gets an empty path and writes its module cache under its working folder
// (measured: its ModuleAnalysisCache file, three folders below the working folder), which was the repository.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'cynco-services-halt-'))
  roots.push(root)
  const home = join(root, 'home')
  const guard = join(root, 'guard')
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  mkdirSync(guard)
  return { root, home, guard }
}

/** The options of every PowerShell child of this file: the fake home, the test's guard folder, no pager, the test's own folder. */
function psOptions(w) {
  const env = { ...process.env, USERPROFILE: w.home, HOME: w.home, LOCALCODE_GUARD_DIR: w.guard }
  for (const k of Object.keys(env)) if (k.startsWith('CYNCO_NTFY_')) delete env[k]
  return { cwd: w.root, env, encoding: 'utf8', timeout: 90_000, windowsHide: true }
}

// Wave 19 (check CC1-6): every PowerShell child of this file is started here, which keeps the folder it was
// started in; after each case, each child of that case must have run in that case's own folder. Until then
// a caller could hand `{ ...psOptions(w), cwd: <elsewhere> }` and every case still passed.
const spawned = []
function psSpawn(w, args, options = psOptions(w)) {
  spawned.push({ root: w.root, cwd: options.cwd })
  return spawnSync('powershell', args, options)
}
afterEach(() => {
  for (const s of spawned.splice(0)) expect(s.cwd, 'a PowerShell child of this case ran outside the case\'s own folder').toBe(s.root)
})

function services(w, args) {
  const r = psSpawn(w, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args])
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).filter(l => l.trim() !== '')
  return { status: r.status, lines, out: lines.join('\n') }
}

const latch = (w) => writeFileSync(join(w.guard, 'HALT.json'), JSON.stringify({
  schema: 1, at: '2026-11-23T00:00:00.000Z', by: 'test', run: 'test-run', publicSummary: '1 change(s) in protected folders (first: PRESENCE)',
}))

// Wave 19b. Text only, so both hold on Linux too.
describe('cynco-services-halt.test.mjs and cynco-services.ps1 as text', () => {
  // Check E19-4: the afterEach above sees only children started through psSpawn, so a case that started
  // PowerShell itself passed whatever folder it ran in. The file holds exactly two process starts: the probe
  // `has` (no PowerShell script, no fake home) and psSpawn's.
  it('the file starts a process in exactly two places, and PowerShell by name only in psSpawn (check E19-4)', () => {
    // The names are put together here so that this case's own text holds none of what it counts.
    const S = 'spawn' + 'Sync'
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const starts = own.match(new RegExp(`\\b(${['spawn', S, 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].join('|')})\\(`, 'g')) ?? []
    expect(starts).toEqual([`${S}(`, `${S}(`])
    expect(own.split(`${S}('powershell'`).length - 1).toBe(1)
    expect(own).toContain(`  return ${S}('powershell', args, options)\n}`)
  })
  // B4: nothing may be downloaded on this PC without the owner's yes; Bun's default fetches a missing package
  // when the folder it runs from holds no installed packages. Both Bun starts of the services script say
  // --no-install: the guard's status and the box reporter's goodbye.
  it('every Bun start of cynco-services.ps1 says --no-install', () => {
    const ps = readFileSync(SCRIPT, 'utf8').split(/\r?\n/).filter(l => !/^\s*#/.test(l))
    const bunStarts = ps.filter(l => /&\s*bun(\.exe|\.cmd)?\b/i.test(l))
    expect(bunStarts.map(l => l.trim())).toEqual([
      "$out = & bun --no-install (Join-Path $PSScriptRoot 'cynco-guard.mjs') status --quiet 2>&1; $guardExit = $LASTEXITCODE",
      'try { & bun --no-install $s.Goodbye --stop | ForEach-Object { Write-Output "$($s.Name): $_" } }',
    ])
    expect(ps.filter(l => /(Start-Process|Invoke-Expression|\biex\b)[^\n]*\bbun\b/i.test(l))).toEqual([])
  })
})

describe.skipIf(!ready)('cynco-services.ps1 under the integrity latch (-WhatIf only)', () => {
  it('the PowerShell child of these cases finds its local application data and its working folder in the test\'s own folder (check CB1-R3)', () => {
    const w = world()
    const r = psSpawn(w, ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('LocalApplicationData'); (Get-Location).ProviderPath"])
    const [appData, here] = `${r.stdout ?? ''}`.split(/\r?\n/).filter(l => l.trim() !== '')
    expect(r.status, r.stderr).toBe(0)
    expect(appData?.toLowerCase(), r.stdout).toBe(join(w.home, 'AppData', 'Local').toLowerCase())
    expect(here?.toLowerCase(), r.stdout).toBe(w.root.toLowerCase())
    expect(`${here ?? REPO}\\`.toLowerCase().startsWith(`${REPO}\\`.toLowerCase())).toBe(false)
  }, 120_000)

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
