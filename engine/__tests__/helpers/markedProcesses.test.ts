/**
 * The one way a test asks about, or ends, a process it knows only by pid (`helpers/markedProcesses.ts`, F255).
 * Every process ended here was started here and carries a mark made here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { endMarked, goneWithin, isMarked, marked, newMark, noneMarkedWithin, watchMarked, type MarkWatch } from './markedProcesses.js'

const marks: string[] = []
const mark = (label: string) => { const m = newMark(label); marks.push(m); return m }
afterEach(() => { for (const m of marks.splice(0)) endMarked(m) })

/** A node that waits two minutes and carries `m` in its command line; resolved once it runs. */
async function waiter(m: string): Promise<ChildProcess> {
  const c = spawn(process.execPath, ['-e', `process.stdout.write('up'); setTimeout(() => {}, 120000) // ${m}`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    c.stdout!.once('data', () => resolve())
    c.once('error', reject)
    c.once('exit', code => reject(new Error(`the waiter ended at once (${code})`)))
  })
  return c
}
const ended = (c: ChildProcess) => new Promise<void>(resolve => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else c.once('exit', () => resolve()) })

describe('markedProcesses: a program is asked about and ended by its mark, never by its number', () => {
  it('two marks made in a row differ, and each is letters and digits only', () => {
    const a = newMark('one two'), b = newMark('one two')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^cyncomark[A-Za-z0-9]+$/)
  })

  it('marked finds the program and leaves the asker out; endMarked ends it and nothing that carries another mark', async () => {
    const a = mark('a'), b = mark('b')
    const pa = await waiter(a), pb = await waiter(b)
    expect(marked(a)).toEqual([pa.pid])
    expect(isMarked(pa.pid!, a)).toBe(true)
    expect(isMarked(pb.pid!, a)).toBe(false)
    expect(endMarked(a)).toEqual([pa.pid])
    await ended(pa)
    expect(await goneWithin(pa.pid!, a)).toBe(true)
    // The other program was not touched by the first mark's end.
    expect(pb.exitCode).toBeNull()
    expect(marked(b)).toEqual([pb.pid])
    expect(endMarked(b)).toEqual([pb.pid])
    await ended(pb)
    expect(await noneMarkedWithin(b)).toBe(true)
  }, 60_000)

  it('a number another process has is not the program: goneWithin says gone, isMarked says no, and nothing is ended', async () => {
    // This worker's own pid: a number that is certainly taken, by a process that does not carry the mark. It is what
    // a recycled pid looks like to a test that asks by number.
    const m = mark('stranger')
    expect(isMarked(process.pid, m)).toBe(false)
    expect(await goneWithin(process.pid, m, 300)).toBe(true)
    expect(endMarked(m)).toEqual([])
  }, 60_000)

  it('while the marked program runs, goneWithin waits its time and answers no', async () => {
    const m = mark('alive')
    const p = await waiter(m)
    const t0 = Date.now()
    expect(await goneWithin(p.pid!, m, 400)).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350)
    expect(await noneMarkedWithin(m, 300)).toBe(false)
  }, 60_000)

  it('only a mark made by newMark is asked or ended by: a name, a pattern or an empty string throws', async () => {
    for (const bad of ['', 'node', 'python.exe', 'cyncomark', '*', 'cyncomark%', "cyncomarkabcdef' -or $true -or '"]) {
      expect(() => marked(bad), bad).toThrow('not a mark made by newMark')
      expect(() => endMarked(bad), bad).toThrow('not a mark made by newMark')
      expect(() => isMarked(process.pid, bad), bad).toThrow('not a mark made by newMark')
      await expect(goneWithin(process.pid, bad, 10), bad).rejects.toThrow('not a mark made by newMark')
      expect(() => watchMarked(bad), bad).toThrow('not a mark made by newMark')
    }
  })
})

/**
 * Wave 24, round two (check B-chk-2): `goneWithin` answers "gone" when nothing carries the mark, so a case whose
 * program never carried it (a wrapper got it and the program did not, a quoting change dropped the comment) would pass
 * although the kill it names is broken. A watcher asks for the mark while the code under test runs, and the case
 * asserts that it SAW the program's pid carrying the mark: the pass then has its own evidence that the mark named the
 * program.
 */
describe('watchMarked: the evidence that a mark named the program while it ran', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  const watches: MarkWatch[] = []
  const watch = (m: string) => { const w = watchMarked(m); watches.push(w); return w }
  afterEach(async () => { for (const w of watches.splice(0)) await w.stop().catch(() => undefined) })

  it('sees a program that carries the mark, about twice a second, and not one that carries another', async () => {
    const a = mark('watchA'), b = mark('watchB')
    const w = watch(a)
    await w.ready
    const pa = await waiter(a), pb = await waiter(b)
    expect(await w.saw(pa.pid!, 10_000), `the watcher never saw ${pa.pid}: ${JSON.stringify(w.seen())}`).toBe(true)
    const before = w.polls()
    await sleep(2000)
    // About twice a second: at least three listings in two seconds, and not a busy loop.
    expect(w.polls() - before).toBeGreaterThanOrEqual(3)
    expect(w.polls() - before).toBeLessThanOrEqual(6)
    const seen = await w.stop()
    expect(seen).toEqual([pa.pid])
    expect(seen).not.toContain(pb.pid)
  }, 60_000)

  it('sees a program that lives one second once the watcher is ready', async () => {
    const m = mark('watchBrief')
    const w = watch(m)
    await w.ready
    const c = spawn(process.execPath, ['-e', `setTimeout(() => {}, 1000) // ${m}`], { stdio: 'ignore', windowsHide: true })
    await ended(c)
    expect(await w.stop()).toEqual([c.pid])
  }, 60_000)

  it('a listing never sees another listing: with nothing marked running, a watcher and marked() beside it find nothing', async () => {
    // Each listing is a process whose own command line would hold the mark if it were written there: one listing
    // would then see the other (an endMarked beside a watcher would end the watcher, and noneMarkedWithin would never
    // say none). Neither holds it.
    const m = mark('watchAlone')
    const w = watch(m)
    await w.ready
    const sync: number[][] = []
    for (let i = 0; i < 6; i++) { sync.push(marked(m)); await sleep(200) }
    expect(sync).toEqual([[], [], [], [], [], []])
    expect(await noneMarkedWithin(m, 300)).toBe(true)
    expect(w.polls()).toBeGreaterThanOrEqual(3)
    expect(await w.stop()).toEqual([])
  }, 60_000)

  it('stop() ends the watcher within a second or two, and a second stop() gives the same answer', async () => {
    const m = mark('watchStop')
    const w = watch(m)
    await w.ready
    const t0 = Date.now()
    const first = await w.stop()
    expect(Date.now() - t0).toBeLessThan(3000)
    const polls = w.polls()
    expect(await w.stop()).toEqual(first)
    await sleep(1200)
    expect(w.polls(), 'the watcher kept listing after it was stopped').toBe(polls)
  }, 60_000)

  it('saw() answers false after its time for a pid the watcher never saw', async () => {
    const m = mark('watchNever')
    const w = watch(m)
    await w.ready
    const t0 = Date.now()
    expect(await w.saw(process.pid, 1200)).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1100)
    expect(await w.stop()).toEqual([])
  }, 60_000)
})
