/**
 * Asking about, and ending, a process a test started through something else (a shell, the program under test) and
 * knows only by a pid it read from a file or from output (F255).
 *
 * A pid is a number, not a process. Once its process has ended and nothing holds a handle to it, Windows gives the
 * number to a new process: measured on this PC on 2026-11-25, a freed number came back after about 1,900 process
 * starts on a quiet machine, which a suite run makes in seconds. `process.kill(pid, 0)` then answers "alive" for the
 * stranger and `process.kill(pid)` ends it, with exit status 1 and nothing printed. That is F255: the last line of a
 * fixture ended "what was left" of nine pids it had read up to nineteen seconds earlier, and another test's Python
 * had one of those numbers by then.
 *
 * So a test never ends anything by a bare number, and never reads "some process has that number" as "my program is
 * still running". The program carries a mark only the test knows in its command line (a comment in a `node -e` or
 * `python -c` text, an extra argument of a script), and every question is asked of the mark:
 *
 *   const mark = newMark('grace')
 *   ... start `node -e "setInterval(() => {}, 1000) // ${mark}"` through the code under test ...
 *   expect(await goneWithin(pid, mark)).toBe(true)     // gone, or the number is another process's now
 *   endMarked(mark)                                    // in afterEach: ends only what carries the mark
 *
 * The listing is one PowerShell (`Get-CimInstance Win32_Process`, the command line of every process this account
 * may read) on Windows and `pgrep -f` elsewhere. Ending happens in the process that listed: on Windows it opens the
 * process, checks through that handle that it was created when the listed one was, and ends it through the handle,
 * so nothing is ended by number; elsewhere the signal follows the listing by milliseconds, and pids there are handed
 * out in sequence. A process whose command line cannot be read (another account, a higher integrity)
 * is never matched, so it is never ended and reads as gone: every program a test marks is its own, started at its
 * own level. The guard `guards/testsEndOnlyMarked.test.ts` refuses a test or fixture that ends a process any other
 * way without saying why it may.
 *
 * "Gone" is also the answer when nothing ever carried the mark (a wrapper got it and the program did not), so a case
 * that asserts its program gone after a cut, a Stop or an overrun watches for the mark while the code under test runs
 * and asserts that the watcher SAW the program's pid (`watchMarked`, wave 24, round two):
 *
 *   const w = watchMarked(mark); await w.ready
 *   ... run the code under test ...
 *   expect(await w.stop()).toContain(pid)               // the mark named the program while it ran
 *   expect(await goneWithin(pid, mark)).toBe(true)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

let made = 0

/**
 * A string no other command line on this machine holds. Letters and digits only, so cmd, PowerShell, a POSIX shell
 * and a JavaScript or Python comment all carry it unchanged.
 */
export function newMark(label = ''): string {
  made++
  const plain = label.replace(/[^A-Za-z0-9]/g, '')
  return `cyncomark${plain}x${process.pid.toString(36)}x${Date.now().toString(36)}x${made.toString(36)}`
}

/** Only a mark this module made is ever asked or ended by: never a pattern, never an empty string. */
function checked(mark: string): string {
  if (!/^cyncomark[A-Za-z0-9]{6,}$/.test(mark)) throw new Error(`not a mark made by newMark: ${JSON.stringify(mark)}`)
  return mark
}

/**
 * What a listing asks for: a regular expression that matches the mark and only the mark (it is letters and digits),
 * written so that the text of the expression is not the mark itself (`cyncomar[k]...`). A listing is a process whose
 * own command line holds what it asks for, so asked by the mark itself one listing would find another running beside it
 * (a watcher's, while a test asks `marked`), and `endMarked` would end it. Asked this way none finds any (wave 24,
 * round two).
 */
function patternOf(m: string): string {
  return `cyncomar[k]${m.slice('cyncomark'.length)}`
}

function listed(mark: string, end: boolean): number[] {
  const m = checked(mark)
  const pattern = patternOf(m)
  if (process.platform === 'win32') {
    // $PID is the PowerShell that asks; its command line holds the pattern, which does not match itself.
    // Ending: the listing gives a number and a creation time. The process is opened first (`.Handle` opens it and
    // keeps it open, so from there the number cannot go to another process), its start time is read through that
    // handle and compared with the listing's, and only then is it ended, through the same handle.
    const stop = '$made = $_.CreationDate; try { $p = [System.Diagnostics.Process]::GetProcessById([int]$_.ProcessId); [void]$p.Handle; '
      + 'if ([math]::Abs(($p.StartTime - $made).TotalMilliseconds) -lt 5) { $p.Kill() } } catch { }; '
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -cmatch '${pattern}' } | `
      + `ForEach-Object { ${end ? stop : ''}[string]$_.ProcessId }`
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', windowsHide: true, timeout: 60_000 })
    if (r.error || r.status !== 0) {
      throw new Error(`the process listing did not run (${r.error ? r.error.message : `status ${r.status}`}): ${String(r.stderr ?? '').trim().slice(0, 300)}`)
    }
    return String(r.stdout ?? '').split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
  }
  // pgrep leaves itself out and exits 1 when nothing matches.
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8', timeout: 60_000 })
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw new Error(`the process listing did not run (${r.error ? r.error.message : `status ${r.status}`}): ${String(r.stderr ?? '').trim().slice(0, 300)}`)
  }
  const pids = String(r.stdout ?? '').split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid)
  if (end) {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
      }
    }
  }
  return pids
}

/** The pids of the processes that carry `mark` in their command line now (the asking process left out). */
export function marked(mark: string): number[] {
  return listed(mark, false)
}

/** Ends every process that carries `mark` in its command line, and nothing else. Returns the pids it found. */
export function endMarked(mark: string): number[] {
  return listed(mark, true)
}

/** Does any process have this number now? Says nothing about WHICH process: only "no" is an answer about the program. */
function numberTaken(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Is the process that has this pid now the marked program? */
export function isMarked(pid: number, mark: string): boolean {
  return numberTaken(pid) && marked(mark).includes(pid)
}

/**
 * True once the marked program that had `pid` is gone: no process has the number, or the one that has it now does
 * not carry the mark (the number went to another process). Waits up to `ms` for that.
 */
export async function goneWithin(pid: number, mark: string, ms = 5000): Promise<boolean> {
  checked(mark)
  const until = Date.now() + ms
  for (;;) {
    if (!numberTaken(pid)) return true
    if (Date.now() >= until) break
    await new Promise(r => setTimeout(r, 100))
  }
  return !marked(mark).includes(pid)
}

/** True once no process carries `mark`, for a test that has no pid to ask by. Waits up to `ms` for that. */
export async function noneMarkedWithin(mark: string, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  for (;;) {
    if (marked(mark).length === 0) return true
    if (Date.now() >= until) return false
    await new Promise(r => setTimeout(r, 250))
  }
}

/** What a watcher has seen, and how it is stopped (`watchMarked`). */
export interface MarkWatch {
  /** Resolves once the first listing has answered: from then on a program that carries the mark is seen. */
  readonly ready: Promise<void>
  /** Every pid seen carrying the mark so far, in the order first seen. */
  seen(): number[]
  /** How many listings have answered so far. */
  polls(): number
  /** True once `pid` has been seen carrying the mark; false after `ms` (or when the watcher stopped or failed). */
  saw(pid: number, ms?: number): Promise<boolean>
  /**
   * Ends the watching and resolves to every pid seen carrying the mark. Rejects when a listing failed: a watcher that
   * could not look has no evidence to give. A second call gives the same answer.
   */
  stop(): Promise<number[]>
}

/** How long a watcher may live at most, should its test never stop it: it then ends by itself. */
const WATCH_MAX_MS = 10 * 60_000

/**
 * Asks for `mark` about twice a second while the code under test runs (wave 24, round two: check B-chk-2), without
 * blocking the event loop (a watcher not stopped does keep its process alive, until `stop()` or its ten minutes): a
 * case that asserts its program gone also asserts the watcher SAW the program's pid carrying the mark, so "gone"
 * cannot be the answer of a mark that never named the program.
 *
 * On Windows one PowerShell lists for the watcher's whole life (a PowerShell started per listing costs about half a
 * second; the listing itself about a tenth), one listing after another and never two at once, and ends when its
 * standard input is closed (`stop()`), when the process that started it ends (the pipe closes with it), or after ten
 * minutes. Elsewhere `pgrep` is started for each listing, the next only after the last has answered.
 */
export function watchMarked(mark: string, everyMs = 500): MarkWatch {
  const pattern = patternOf(checked(mark))
  const seen: number[] = []
  let polls = 0
  let failure: Error | null = null
  let stopping: Promise<number[]> | null = null
  const waiting = new Set<() => void>()
  const tell = () => { for (const f of [...waiting]) f() }
  let readyResolve!: () => void
  let readyReject!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej })
  ready.catch(() => undefined)
  const answered = (pids: number[]) => {
    polls++
    for (const p of pids) if (!seen.includes(p)) seen.push(p)
    readyResolve()
    tell()
  }
  const failed = (e: Error) => {
    if (failure === null) failure = e
    readyReject(e)
    tell()
  }
  const parse = (text: string) => text.trim().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid)

  let finish: () => Promise<void>
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      // A read of standard input that completes when the starter closes it (stop()) or ends.
      '$in = [Console]::OpenStandardInput(); $buf = New-Object byte[] 1; $closed = $in.ReadAsync($buf, 0, 1)',
      `$until = [DateTime]::UtcNow.AddMilliseconds(${WATCH_MAX_MS}); $sw = New-Object System.Diagnostics.Stopwatch`,
      'while (-not $closed.IsCompleted -and [DateTime]::UtcNow -lt $until) {',
      '  $sw.Restart()',
      `  $ids = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -cmatch '${pattern}' } | ForEach-Object { [string]$_.ProcessId })`,
      "  [Console]::Out.WriteLine('seen ' + ($ids -join ' ')); [Console]::Out.Flush()",
      `  $left = ${Math.max(0, Math.floor(everyMs))} - $sw.ElapsedMilliseconds`,
      '  if ($left -gt 0) { [void]$closed.Wait([int]$left) }',
      '}',
    ].join('\n')
    const child: ChildProcess = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (d: string) => {
      out += d
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (line.startsWith('seen')) answered(parse(line.slice(4)))
      }
    })
    child.stderr!.setEncoding('utf-8')
    child.stderr!.on('data', (d: string) => { err += d })
    child.stdin!.on('error', () => undefined)
    const closed = new Promise<void>(resolve => {
      child.once('error', e => { failed(new Error(`the watcher's listing did not start: ${e.message}`)); resolve() })
      child.once('close', (code, signal) => {
        if (stopping === null || code !== 0) {
          failed(new Error(`the watcher's listing ended (${signal ?? `status ${code}`}) before it was stopped: ${err.trim().slice(0, 300)}`))
        }
        resolve()
      })
    })
    finish = async () => {
      child.stdin!.end()
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = await Promise.race([closed.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 15_000) })])
      if (timer !== null) clearTimeout(timer)
      if (!done) {
        // Through the object that started it, never by its number.
        child.kill()
        failed(new Error('the watcher did not stop within 15 s of being told to'))
        await closed
      }
    }
  } else {
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight: Promise<void> | null = null
    const started = Date.now()
    const poll = () => {
      timer = null
      if (stopping !== null || failure !== null) return
      const t0 = Date.now()
      inFlight = new Promise<void>(resolve => {
        const c = spawn('pgrep', ['-f', pattern], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = '', err = ''
        c.stdout!.setEncoding('utf-8'); c.stdout!.on('data', (d: string) => { out += d })
        c.stderr!.setEncoding('utf-8'); c.stderr!.on('data', (d: string) => { err += d })
        c.once('error', e => { failed(new Error(`the watcher's listing did not start: ${e.message}`)); resolve() })
        c.once('close', code => {
          // pgrep leaves itself out and exits 1 when nothing matches.
          if (code === 0 || code === 1) answered(parse(out))
          else failed(new Error(`the watcher's listing did not run (status ${code}): ${err.trim().slice(0, 300)}`))
          resolve()
        })
      }).then(() => {
        inFlight = null
        if (stopping === null && failure === null && Date.now() - started < WATCH_MAX_MS) {
          timer = setTimeout(poll, Math.max(0, everyMs - (Date.now() - t0)))
        }
      })
    }
    poll()
    finish = async () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (inFlight !== null) await inFlight
    }
  }

  return {
    ready,
    seen: () => [...seen],
    polls: () => polls,
    saw(pid: number, ms = 15_000): Promise<boolean> {
      return new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const check = () => {
          if (seen.includes(pid)) { done(true); return }
          if (failure !== null || stopping !== null) done(false)
        }
        const done = (v: boolean) => { waiting.delete(check); if (timer !== null) clearTimeout(timer); resolve(v) }
        waiting.add(check)
        timer = setTimeout(() => done(seen.includes(pid)), ms)
        check()
      })
    },
    stop(): Promise<number[]> {
      if (stopping === null) {
        stopping = finish().then(() => {
          tell()
          if (failure !== null) throw failure
          return [...seen]
        })
      }
      return stopping
    },
  }
}
