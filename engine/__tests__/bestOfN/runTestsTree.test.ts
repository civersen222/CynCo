/**
 * A best-of-N test run owns its process tree and ends it at its own cap (wave 15c, item P4(1b), check
 * B4-2; NOW.md:259 for best-of-N).
 *
 * `runTests` ran a candidate's tests through `toolExecSync` with a two-minute timeout. That timeout
 * ends the shell alone (F201, F210), so what the tests started ran on, and the synchronous spawn held
 * the event loop the dashboard and the phone are served from for the whole run (F225). It is now the
 * asynchronous form the contract check has: the tree is owned from the start and ended on the run's
 * own timer, with a two-second grace, and a run that ends on its own gives the handle back. Asked by
 * the pid the grandchild printed: it must be gone, not merely the shell. The Job Object path (Bun, as
 * every engine here runs) is `bypassTreesJob.test.ts`; the grace is `tools/bypassGrace.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTests, TEST_RUN_CAP_MS } from '../../bestOfN/sampler.js'
import { endMarked, goneWithin, newMark, watchMarked, type MarkWatch } from '../helpers/markedProcesses.js'

// The grandchild carries a mark in its command line and is asked about and ended by it, never by the pid it
// printed (F255, wave 24: a number read from output names whatever process has it now). A watcher asks for the mark
// while the run runs, and each case asserts it saw the printed pid carrying it (wave 24, round two): "gone" is also
// the answer of a mark that never named the program.
const marks: string[] = []
const watches: MarkWatch[] = []
const dirs: string[] = []
const newCaseMark = (label: string) => { const m = newMark(label); marks.push(m); return m }
/** A watcher already listing for `mark`. */
const watching = async (mark: string): Promise<MarkWatch> => { const w = watchMarked(mark); watches.push(w); await w.ready; return w }
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop().catch(() => undefined)
  // A survivor (the defect) is ended here by its mark, so the suite does not leave it running.
  for (const m of marks.splice(0)) endMarked(m)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})
/** A grandchild that prints its pid and waits two minutes (longer than any case here needs), carrying `mark`. */
const waiter = (mark: string) => `node -e "console.log('pid=' + process.pid); setTimeout(() => {}, 120000) // ${mark}"`
/** The same, which also writes its pid to `file` (a path with forward slashes) as soon as it runs. */
const waiterWritingPid = (mark: string, file: string) =>
  `node -e "require('fs').writeFileSync('${file}', String(process.pid)); console.log('pid=' + process.pid); setTimeout(() => {}, 120000) // ${mark}"`
/** The whole positive number `file` holds, once it holds one; null after `ms`. */
async function pidIn(file: string, ms: number): Promise<number | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file)) { const n = Number(readFileSync(file, 'utf-8').trim()); if (Number.isInteger(n) && n > 0) return n }
    await new Promise(r => setTimeout(r, 50))
  }
  return null
}

const info = (command: string) => ({ available: true, framework: 'pytest', command })

describe('runTests owns the tree of a candidate\'s test run', () => {
  it('a run cut at its cap ends the program the shell started, and answers no score', async () => {
    const mark = newCaseMark('runTestsCut')
    // Listing before the run starts: the program lives until the 3 s cap, several of the watcher's listings.
    const w = await watching(mark)
    const t0 = Date.now()
    const r = await runTests(process.cwd(), info(waiter(mark)), 3000)
    const ms = Date.now() - t0
    expect(r.refused).toBeUndefined()
    expect(r).toMatchObject({ passed: 0, total: 0 })
    const m = /pid=(\d+)/.exec(r.output)
    expect(m, `the grandchild printed no pid: ${r.output}`).not.toBeNull()
    const pid = Number(m![1])
    expect(await w.stop(), `node ${pid} was never seen carrying its mark while the run ran`).toContain(pid)
    expect(await goneWithin(pid, mark), `node ${pid}, started by the candidate's tests, outlived the run's cap`).toBe(true)
    expect(ms).toBeLessThan(10_000)
  }, 30_000)

  it('the event loop runs while the tests run (the run is not synchronous)', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 50)
    try {
      await runTests(process.cwd(), info('node -e "setTimeout(() => {}, 1500)"'))
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(5)
  }, 30_000)

  it('a run that ends on its own is parsed as before', async () => {
    const r = await runTests(process.cwd(), info('node -e "console.log(\'3 passed, 1 failed in 0.10s\')"'))
    expect(r.refused).toBeUndefined()
    expect(r).toMatchObject({ passed: 3, total: 4 })
    const failing = await runTests(process.cwd(), info('node -e "console.log(\'2 passed, 2 failed in 0.10s\'); process.exit(1)"'))
    expect(failing).toMatchObject({ passed: 2, total: 4 })
  }, 30_000)

  // Wave 19, check C4-5: Stop reaches a best-of-N test run. The turn's signal ends the tree at once,
  // not at the two-minute cap, and the run answers no score.
  // Changed on purpose in wave 24, round two: the Stop was pressed at a fixed 1.5 s, when the program had run for about
  // a second, too briefly for the watcher's listings to be sure to see it. It is now pressed once the watcher has seen
  // the program carrying its mark (or after 20 s, when the case fails on what the watcher saw); still long before the cap.
  it('a Stop ends the run and the program the shell started, long before the cap', async () => {
    const mark = newCaseMark('runTestsStop')
    const w = await watching(mark)
    const d = mkdtempSync(join(tmpdir(), 'cynco-runtests-stop-'))
    dirs.push(d)
    const pidFile = join(d, 'pid.txt').replace(/\\/g, '/')
    const stop = new AbortController()
    const t0 = Date.now()
    const run = runTests(process.cwd(), info(waiterWritingPid(mark, pidFile)), 60_000, stop.signal)
    const early = await pidIn(pidFile, 20_000)
    if (early !== null) await w.saw(early, 15_000)
    stop.abort()
    const r = await run
    const ms = Date.now() - t0
    expect(r.refused).toBeUndefined()
    expect(r).toMatchObject({ passed: 0, total: 0 })
    expect(ms, 'the run waited for its cap, not the Stop').toBeLessThan(10_000)
    const m = /pid=(\d+)/.exec(r.output)
    expect(m, `the grandchild printed no pid: ${r.output}`).not.toBeNull()
    const pid = Number(m![1])
    expect(early, 'the pid the program wrote is the one it printed').toBe(pid)
    expect(await w.stop(), `node ${pid} was never seen carrying its mark while the run ran`).toContain(pid)
    expect(await goneWithin(pid, mark), `node ${pid}, started by the candidate's tests, outlived the Stop`).toBe(true)
  }, 90_000)

  it('a run asked after the Stop starts nothing', async () => {
    const stop = new AbortController()
    stop.abort()
    const t0 = Date.now()
    const r = await runTests(process.cwd(), info('node -e "setTimeout(() => {}, 20000)"'), 60_000, stop.signal)
    expect(r).toEqual({ passed: 0, total: 0, output: '', refused: 'the turn was stopped' })
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 30_000)

  it('the cap is two minutes unless a caller names another', () => {
    expect(TEST_RUN_CAP_MS).toBe(120_000)
  })
})
