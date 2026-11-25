// F255: scripts/cynco-services.ps1 finds each service's process by its command line, and `stop` ended what it found
// by number (Stop-Process -Id). The selection let through every image whose name lacks "bun" (`$_.Name -eq 'bun.exe' -or
// $_.Name -notmatch 'bun'`), so an editor opened on engine\main.ts was the "engine" that `stop engine` stopped. Each
// row now names the images it runs as, and the selection requires one of them.
//
// The rows and the selection line are lifted from the script and run in a PowerShell of this test's own against
// process rows made up here: nothing is listed, started, stopped or asked of Task Scheduler.
//
// The stop branch (F255, check C-R3) ended the process it had listed at the start with `Stop-Process -Id`, after a
// goodbye of up to ten seconds and `Stop-ScheduledTask`, either of which may have ended it and freed its number. It
// now opens the process, checks it against the listed creation time and ends it through that handle. The script's
// `stop`, `start` and `register` are never run here: the line is lifted and run against a waiter this test started
// and holds, carrying a mark (`engine/__tests__/helpers/markedProcesses.ts`).
import { describe, it, expect, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { endMarked, newMark } from '../../engine/__tests__/helpers/markedProcesses.js'

const REPO = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'cynco-services.ps1')
const text = readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n')
const win = process.platform === 'win32'

const roots = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

/** The `$services = @( ... )` block, as the script has it. */
function rowsBlock() {
  const start = text.indexOf('$services = @(\n')
  const end = text.indexOf('\n)\n', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end + 2)
}
/** The one line that picks a row's process from the listing. */
function selectionLine() {
  const lines = text.split('\n').filter(l => /^\s*\$proc = \$procs \|/.test(l))
  expect(lines).toHaveLength(1)
  return lines[0].trim()
}

const ps = (s) => `'${s.replace(/'/g, "''")}'`
const row = (pid, name, commandLine) => `[pscustomobject]@{ ProcessId = ${pid}; Name = ${ps(name)}; CommandLine = ${ps(commandLine)} }`

/** Runs the lifted rows and selection over `procs`; answers `name=pid` (or `name=none`) per row that runs on this PC. */
function select(procs) {
  const root = mkdtempSync(join(tmpdir(), 'cynco-services-select-'))
  roots.push(root)
  const file = join(root, 'select.ps1')
  writeFileSync(file, [
    "$repo = 'C:\\repo'",
    rowsBlock(),
    `$procs = @(${procs.join(', ')})`,
    'foreach ($s in $services) {',
    '  if ($s.Remote) { continue }',
    `  ${selectionLine()}`,
    "  '{0}={1}' -f $s.Name, $(if ($proc) { $proc.ProcessId } else { 'none' })",
    '}',
  ].join('\r\n'))
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  return r.stdout.split(/\r?\n/).filter(l => l.trim() !== '')
}

const ENGINE = row(12, 'bun.exe', '"C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe" --no-install engine\\main.ts')
const EMBED = row(22, 'llama-server.exe', '"C:\\Users\\x\\.cynco\\bin\\llama-server.exe" --embeddings -m "C:\\m\\nomic.gguf" --port 9165')
const DAEMON = row(32, 'bun.exe', 'bun --no-install engine\\daemon\\main.ts')
const WATCH = row(42, 'bun.exe', 'bun --no-install engine\\power\\reporter\\main.ts')
const LISTENER = row(52, 'python.exe', '"C:\\Python314\\python.exe"  -X utf8 dynasty\\approval_listener.py')
// What holds a service's text in its command line and is not the service: an editor, a viewer, a shell.
const DECOYS = [
  row(11, 'editor.exe', '"C:\\Program Files\\Editor\\editor.exe" C:\\Users\\x\\localcode\\engine\\main.ts'),
  row(21, 'viewer.exe', 'viewer.exe C:\\notes\\llama-server --embeddings flags.txt'),
  row(31, 'editor.exe', 'editor.exe engine\\daemon\\main.ts'),
  row(41, 'cmd.exe', 'cmd.exe /c type engine\\power\\reporter\\main.ts'),
  row(51, 'editor.exe', 'editor.exe dynasty\\approval_listener.py'),
]

describe('cynco-services.ps1 as text: every row that runs on this PC names the images it runs as', () => {
  it('engine, daemon and watch run as bun.exe, embed as llama-server.exe, the listener as a Python', () => {
    const rows = rowsBlock().split('\n').filter(l => l.includes('Match = '))
    expect(rows).toHaveLength(5)
    const images = Object.fromEntries(rows.map(l => [/Name = '(\w+)'/.exec(l)[1], /Images = @\(([^)]*)\)/.exec(l)?.[1] ?? null]))
    expect(images).toEqual({
      engine: "'bun.exe'",
      embed: "'llama-server.exe'",
      daemon: "'bun.exe'",
      watch: "'bun.exe'",
      listener: "'python.exe', 'pythonw.exe'",
    })
    expect(selectionLine()).toContain('$s.Images -contains $_.Name')
  })
})

describe.skipIf(!win)('cynco-services.ps1: the process of a row is one of its images with its text (F255)', () => {
  it('an editor or a shell whose command line holds a service\'s text, listed first, is not that service', () => {
    expect(select([...DECOYS, ENGINE, EMBED, DAEMON, WATCH, LISTENER])).toEqual(['engine=12', 'embed=22', 'daemon=32', 'watch=42', 'listener=52'])
  }, 120_000)

  it('with only such processes running, no service is running, so `stop` stops nothing', () => {
    expect(select(DECOYS)).toEqual(['engine=none', 'embed=none', 'daemon=none', 'watch=none', 'listener=none'])
  }, 120_000)

  it('the rows still tell the services apart: the engine row does not take the daemon or a task run', () => {
    const taskRun = row(13, 'bun.exe', 'bun --no-install engine\\main.ts --run-task C:\\t\\task.json')
    expect(select([taskRun, DAEMON, row(53, 'pythonw.exe', 'pythonw.exe dynasty\\approval_listener.py')]))
      .toEqual(['engine=none', 'embed=none', 'daemon=32', 'watch=none', 'listener=53'])
  }, 120_000)
})

/** The `'stop' { ... }` branch of the script's switch. */
function stopBranch() {
  const start = text.indexOf("    'stop' {\n")
  const end = text.indexOf('    default {\n', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}
/** The one line of the stop branch that ends the listed process. */
function endLine() {
  const lines = stopBranch().split('\n').filter(l => /^\s*if \(\$proc\) \{/.test(l))
  expect(lines).toHaveLength(1)
  return lines[0].trim()
}

describe('cynco-services.ps1 stop as text: the listed process is ended only through a handle checked against the listing (F255)', () => {
  it('no stop by number; the process is opened, compared with the listed creation time, then ended through that handle', () => {
    expect(stopBranch()).not.toMatch(/Stop-Process/)
    const line = endLine()
    expect(line).toContain('[System.Diagnostics.Process]::GetProcessById([int]$proc.ProcessId)')
    expect(line).toMatch(/\[math\]::Abs\(\(\$h\.StartTime - \$proc\.CreationDate\)\.TotalMilliseconds\) -lt 5/)
    // Opened (the handle pins the number) before it is compared, and compared before it is ended.
    const opened = line.indexOf('[void]$h.Handle'), compared = line.indexOf('$h.StartTime'), ended = line.indexOf('$h.Kill()')
    expect(opened).toBeGreaterThan(-1)
    expect(opened).toBeLessThan(compared)
    expect(compared).toBeLessThan(ended)
  })
})

describe.skipIf(!win)('cynco-services.ps1 stop, the lifted line, against a waiter this test started and holds (F255)', () => {
  const mark = newMark('servicesstop')
  const waiters = []
  // Each waiter ends by itself after two minutes. A case that failed leaves one at most: ended through the object that
  // started it, then by the mark.
  afterAll(() => { for (const c of waiters.splice(0)) c.kill(); endMarked(mark) })

  async function waiter() {
    const c = spawn(process.execPath, ['-e', `process.stdout.write('up'); setTimeout(() => {}, 120000) // ${mark}`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    waiters.push(c)
    await new Promise((res, rej) => { c.stdout.once('data', () => res()); c.once('error', rej); c.once('exit', code => rej(new Error(`the waiter ended at once (${code})`))) })
    return c
  }
  const ended = (c, ms) => new Promise(res => {
    if (c.exitCode !== null || c.signalCode !== null) { res(true); return }
    const t = setTimeout(() => res(false), ms)
    c.once('exit', () => { clearTimeout(t); res(true) })
  })

  /**
   * Runs the stop branch's line with `$proc` the CIM row of `pid`, its creation time moved by `shiftMs`. While it runs
   * this test holds the waiter with its exit unhandled (the call is synchronous), so the number is the waiter's.
   */
  function runEndLine(pid, shiftMs) {
    const root = mkdtempSync(join(tmpdir(), 'cynco-services-stop-'))
    roots.push(root)
    const file = join(root, 'stop.ps1')
    writeFileSync(file, [
      `$c = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
      "if (-not $c) { 'not listed'; exit 3 }",
      `$proc = [pscustomobject]@{ ProcessId = $c.ProcessId; CreationDate = $c.CreationDate.AddMilliseconds(${shiftMs}) }`,
      endLine(),
      "'ran'",
    ].join('\r\n'))
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('ran')
  }

  it('the process listed is opened, found to be the one listed, and ended through its handle', async () => {
    const c = await waiter()
    runEndLine(c.pid, 0)
    expect(await ended(c, 10_000)).toBe(true)
  }, 120_000)

  it('a process whose listed creation time is a second off is not the one listed: it is left running', async () => {
    const c = await waiter()
    runEndLine(c.pid, 1_000)
    expect(await ended(c, 1_000)).toBe(false)
    // Ended here through the object that started it.
    c.kill()
    expect(await ended(c, 10_000)).toBe(true)
  }, 120_000)
})
