// Wave 15 (NOW.md:94, :91): scripts/cynco-services.ps1 status prints each service log's size, and the last line
// of the rotation's own file (<svc>.rotate.log) when it holds one. Run for real, `status -Only daemon` only:
// that reads the guard folder (a temp folder here), the process list and the daemon's task, all read-only, and
// with -Only the doorman's service is not asked, so nothing reaches the network. The home is a fake one under
// this file's temp folder, so the log it sizes is this test's own.
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
if (win && !ready) console.log('[cynco-services-status] SKIPPED: powershell or bun is not on PATH')

const roots = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

// Wave 15c (check CB1-R3): the fake home has an AppData\Local and the child runs in this test's own folder.
// Windows PowerShell finds its local application data through USERPROFILE (User Shell Folders), and with no
// such folder in the fake home it gets an empty path and writes its module cache under its working folder
// (measured: its ModuleAnalysisCache file, three folders below the working folder), which was the repository.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'cynco-services-status-'))
  roots.push(root)
  const home = join(root, 'home')
  const guard = join(root, 'guard')
  mkdirSync(join(home, '.cynco'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  mkdirSync(guard)
  return { root, home, guard, cynco: join(home, '.cynco') }
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
function status(w) {
  const r = psSpawn(w, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, 'status', '-Only', 'daemon'])
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).filter(l => l.trim() !== '')
  return { status: r.status, lines, out: lines.join('\n') }
}
// Lines, as a real log has: a file with no line break makes Get-Content -Tail read it to the start (measured: over 90 s for 3 MiB).
const sized = (p, bytes) => writeFileSync(p, `${'x'.repeat(1023)}\n`.repeat(Math.round(bytes / 1024)))

// Wave 19b (check E19-4): the afterEach above sees only children started through psSpawn, so a case that
// started PowerShell itself passed whatever folder it ran in. The source holds exactly two process starts:
// the probe `has` (no PowerShell script, no fake home) and psSpawn's. Text only, so it holds on Linux too.
describe('cynco-services-status.test.mjs: every PowerShell child goes through psSpawn (check E19-4)', () => {
  it('the file starts a process in exactly two places, and PowerShell by name only in psSpawn', () => {
    // The names are put together here so that this case's own text holds none of what it counts.
    const S = 'spawn' + 'Sync'
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const starts = own.match(new RegExp(`\\b(${['spawn', S, 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].join('|')})\\(`, 'g')) ?? []
    expect(starts).toEqual([`${S}(`, `${S}(`])
    expect(own.split(`${S}('powershell'`).length - 1).toBe(1)
    expect(own).toContain(`  return ${S}('powershell', args, options)\n}`)
  })
})

describe.skipIf(!ready)('cynco-services.ps1 status: the log sizes', () => {
  it('the PowerShell child of these cases finds its local application data and its working folder in the test\'s own folder (check CB1-R3)', () => {
    const w = world()
    const r = psSpawn(w, ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('LocalApplicationData'); (Get-Location).ProviderPath"])
    const [appData, here] = `${r.stdout ?? ''}`.split(/\r?\n/).filter(l => l.trim() !== '')
    expect(r.status, r.stderr).toBe(0)
    expect(appData?.toLowerCase(), r.stdout).toBe(join(w.home, 'AppData', 'Local').toLowerCase())
    expect(here?.toLowerCase(), r.stdout).toBe(w.root.toLowerCase())
    expect(`${here ?? REPO}\\`.toLowerCase().startsWith(`${REPO}\\`.toLowerCase())).toBe(false)
  }, 120_000)

  it('the daemon row carries its log\'s size; the rotation\'s last line is shown when there is one', () => {
    const w = world()
    sized(join(w.cynco, 'daemon.log'), 3 * 1024 * 1024)
    writeFileSync(join(w.cynco, 'daemon.rotate.log'), '[rotate-log] could not rotate "x" (it may be held open); the service starts anyway\r\n')
    const r = status(w)
    expect(r.status, r.out).toBe(0)
    const row = r.lines.find(l => l.startsWith('daemon '))
    expect(row, r.out).toMatch(/^daemon\s+(NOT REGISTERED|RUNNING \(pid \d+\)|STOPPED)\s+\[log 3\.0 MiB\]/)
    expect(r.lines).toContain('          rotation: [rotate-log] could not rotate "x" (it may be held open); the service starts anyway')
  }, 120_000)

  it('a log with no line break is shown at once (Get-Content -Tail read 3 MiB of one line for over 90 s)', () => {
    const w = world()
    writeFileSync(join(w.cynco, 'daemon.log'), 'y'.repeat(3 * 1024 * 1024))
    const t0 = Date.now()
    const r = status(w)
    expect(r.status, r.out).toBe(0)
    expect(Date.now() - t0).toBeLessThan(30_000)
    expect(r.lines.find(l => l.startsWith('daemon ')), r.out).toMatch(/\[log 3\.0 MiB\] y{110}\.\.\.$/)
  }, 120_000)

  // Wave 15b (the first builder's named limit): the size was formatted with the thread's culture, so a Windows set to
  // German printed '3,0 MiB' and one over 1000 MiB '1,234.5' in English with a group separator. Now one form everywhere.
  it('the size is the same on a Windows in another language: a decimal point, no group separator', () => {
    const w = world()
    sized(join(w.cynco, 'daemon.log'), 3 * 1024 * 1024)
    const cmd = `[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('de-DE'); & '${SCRIPT.replace(/'/g, "''")}' status -Only daemon`
    const r = psSpawn(w, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd])
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const row = out.split(/\r?\n/).find(l => l.startsWith('daemon '))
    expect(row, out).toMatch(/\[log 3\.0 MiB\]/)
  }, 120_000)

  it('no log: the size says so; an empty rotation file prints nothing', () => {
    const w = world()
    writeFileSync(join(w.cynco, 'daemon.rotate.log'), '')
    const r = status(w)
    expect(r.status, r.out).toBe(0)
    expect(r.lines.find(l => l.startsWith('daemon ')), r.out).toMatch(/\[no log\]/)
    expect(r.lines.some(l => l.includes('rotation:')), r.out).toBe(false)
  }, 120_000)
})
