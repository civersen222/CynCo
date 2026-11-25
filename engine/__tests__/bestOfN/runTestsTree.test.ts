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
import { runTests, TEST_RUN_CAP_MS } from '../../bestOfN/sampler.js'

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const seen: number[] = []
afterEach(() => {
  // A survivor (the defect) is ended here so the suite does not leave it running.
  for (const pid of seen.splice(0)) if (alive(pid)) { try { process.kill(pid) } catch { /* gone between the two calls */ } }
})

const info = (command: string) => ({ available: true, framework: 'pytest', command })

describe('runTests owns the tree of a candidate\'s test run', () => {
  it('a run cut at its cap ends the program the shell started, and answers no score', async () => {
    const t0 = Date.now()
    const r = await runTests(process.cwd(), info('node -e "console.log(\'pid=\' + process.pid); setInterval(() => {}, 1000)"'), 3000)
    const ms = Date.now() - t0
    expect(r.refused).toBeUndefined()
    expect(r).toMatchObject({ passed: 0, total: 0 })
    const m = /pid=(\d+)/.exec(r.output)
    expect(m, `the grandchild printed no pid: ${r.output}`).not.toBeNull()
    const pid = Number(m![1])
    seen.push(pid)
    const until = Date.now() + 5000
    while (alive(pid) && Date.now() < until) await new Promise(res => setTimeout(res, 100))
    expect(alive(pid), `node ${pid}, started by the candidate's tests, outlived the run's cap`).toBe(false)
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
  it('a Stop ends the run and the program the shell started, long before the cap', async () => {
    const stop = new AbortController()
    const t0 = Date.now()
    const timer = setTimeout(() => stop.abort(), 1500)
    let r: Awaited<ReturnType<typeof runTests>>
    try {
      r = await runTests(process.cwd(), info('node -e "console.log(\'pid=\' + process.pid); setInterval(() => {}, 1000)"'), 60_000, stop.signal)
    } finally {
      clearTimeout(timer)
    }
    const ms = Date.now() - t0
    expect(r.refused).toBeUndefined()
    expect(r).toMatchObject({ passed: 0, total: 0 })
    expect(ms, 'the run waited for its cap, not the Stop').toBeLessThan(10_000)
    const m = /pid=(\d+)/.exec(r.output)
    expect(m, `the grandchild printed no pid: ${r.output}`).not.toBeNull()
    const pid = Number(m![1])
    seen.push(pid)
    const until = Date.now() + 5000
    while (alive(pid) && Date.now() < until) await new Promise(res => setTimeout(res, 100))
    expect(alive(pid), `node ${pid}, started by the candidate's tests, outlived the Stop`).toBe(false)
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
