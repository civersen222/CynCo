/**
 * engine/daemon/housekeeping.ts (F242, slice S8): the daily page about a service log over 1 GiB.
 * Every dependency is injected: the clock, the page, the listing. The one case that uses the real
 * listing reads a folder that does not exist, so nothing is created and nothing is sent.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LOG_PAGE_BYTES } from '../../logCap.js'
import {
  LOG_PAGE_TITLE, PAGED_FILE, REFUSED_RUN_TITLE, loadLastPaged, logPageMessage, onceADayRefusals, refusedRunKey, runHousekeeping, saveLastPaged,
} from '../../daemon/housekeeping.js'

const HOUR = 60 * 60 * 1000
const GIB = 1024 * 1024 * 1024

function harness(files: Array<{ path: string; bytes: number }>, answers: Array<boolean | Error> = []) {
  let t = 1_000_000
  const pages: Array<{ title: string; message: string }> = []
  const lines: string[] = []
  const asked: Array<{ dir: string; minBytes: number }> = []
  const lastPaged = new Map<string, number>()
  const deps = {
    logsDir: 'C:\\home\\.cynco',
    now: () => t,
    lastPaged,
    list: (dir: string, minBytes: number) => { asked.push({ dir, minBytes }); return files },
    publish: async (p: { title: string; message: string }) => {
      pages.push(p)
      const a = answers.length ? answers.shift()! : true
      if (a instanceof Error) throw a
      return a
    },
    log: (line: string) => { lines.push(line) },
  }
  return { deps, pages, lines, asked, lastPaged, advance: (ms: number) => { t += ms } }
}

describe('runHousekeeping', () => {
  it('lists the given folder at the 1 GiB threshold', async () => {
    const h = harness([])
    await runHousekeeping(h.deps)
    expect(h.asked).toEqual([{ dir: 'C:\\home\\.cynco', minBytes: LOG_PAGE_BYTES }])
    expect(LOG_PAGE_BYTES).toBe(GIB)
    expect(h.pages).toEqual([])
  })

  it('an oversized log pages once, with the specified title and message', async () => {
    const path = 'C:\\home\\.cynco\\embed-server.log'
    const h = harness([{ path, bytes: 25_990_666_616 }])
    await runHousekeeping(h.deps)
    expect(h.pages).toEqual([{
      title: 'CynCo: a log is over 1 GiB',
      message: `${path} is 24.2 GiB. A service log is rotated only when its service starts: stop and start its service with scripts\\cynco-services.ps1. The rotation keeps it as ${path}.1, so delete that by hand afterwards to free the space.`,
    }])
    expect(LOG_PAGE_TITLE).toBe('CynCo: a log is over 1 GiB')
    expect(h.lastPaged.get(path)).toBe(h.deps.now())
    expect(h.lines).toEqual([])
  })

  // Review of wave 5: a restart renames the 26 GB log to .1 and frees nothing; the .1 has its own page.
  it('the previous file the rotation keeps (<log>.1) over the size pages with its own message', async () => {
    const path = 'C:\\home\\.cynco\\embed-server.log.1'
    const h = harness([{ path, bytes: 25_990_666_616 }])
    await runHousekeeping(h.deps)
    expect(h.pages).toEqual([{
      title: 'CynCo: a log is over 1 GiB',
      message: `${path} is the previous log the rotation keeps (24.2 GiB); nothing deletes it until the log passes its cap again. Delete it by hand to free the space.`,
    }])
  })

  it('does not page again within 24 hours, and pages again after', async () => {
    const path = 'C:\\home\\.cynco\\daemon.log'
    const h = harness([{ path, bytes: 2 * GIB }])
    await runHousekeeping(h.deps)
    h.advance(HOUR)
    await runHousekeeping(h.deps)
    h.advance(22 * HOUR)
    await runHousekeeping(h.deps)
    expect(h.pages).toHaveLength(1)
    h.advance(HOUR) // 24 hours after the first page
    await runHousekeeping(h.deps)
    expect(h.pages).toHaveLength(2)
    expect(h.pages[1]!.message).toBe(logPageMessage(path, 2 * GIB))
  })

  it('a publish that resolves false is logged and tried again on the next pass', async () => {
    const path = 'C:\\home\\.cynco\\daemon.log'
    const h = harness([{ path, bytes: 2 * GIB }], [false, true])
    await expect(runHousekeeping(h.deps)).resolves.toBeUndefined()
    expect(h.lastPaged.has(path)).toBe(false)
    expect(h.lines).toEqual([`[daemon] log page not sent: ${path}: the server did not take it`])
    h.advance(HOUR)
    await runHousekeeping(h.deps)
    expect(h.pages).toHaveLength(2)
    expect(h.lastPaged.get(path)).toBe(h.deps.now())
  })

  it('a publish that rejects is logged with its error, nothing throws, and it is tried again', async () => {
    const path = 'C:\\home\\.cynco\\daemon.log'
    const h = harness([{ path, bytes: 2 * GIB }], [new Error('connect ECONNREFUSED')])
    await expect(runHousekeeping(h.deps)).resolves.toBeUndefined()
    expect(h.lines).toEqual([`[daemon] log page not sent: ${path}: connect ECONNREFUSED`])
    h.advance(HOUR)
    await runHousekeeping(h.deps)
    expect(h.pages).toHaveLength(2)
    expect(h.lastPaged.has(path)).toBe(true)
  })

  it('two oversized files page separately, and one failing does not stop the other', async () => {
    const a = 'C:\\home\\.cynco\\a.log'
    const b = 'C:\\home\\.cynco\\b.log'
    const h = harness([{ path: a, bytes: 3 * GIB }, { path: b, bytes: 1.5 * GIB }], [new Error('down'), true])
    await runHousekeeping(h.deps)
    expect(h.pages.map(p => p.message.split(' is ')[0])).toEqual([a, b])
    expect(h.pages[1]!.message.startsWith(`${b} is 1.5 GiB.`)).toBe(true)
    expect(h.lastPaged.has(a)).toBe(false)
    expect(h.lastPaged.has(b)).toBe(true)
    h.advance(HOUR)
    await runHousekeeping(h.deps)
    // Only the one that was not taken is sent again.
    expect(h.pages.map(p => p.message.split(' is ')[0])).toEqual([a, b, a])
  })

  it('a listing that throws is logged and pages nothing', async () => {
    const h = harness([])
    h.deps.list = () => { throw new Error('EACCES') }
    await expect(runHousekeeping(h.deps)).resolves.toBeUndefined()
    expect(h.pages).toEqual([])
    expect(h.lines).toEqual(['[daemon] the service logs in C:\\home\\.cynco could not be listed: EACCES'])
  })

  it('a folder that does not exist pages nothing (the real listing)', async () => {
    const pages: unknown[] = []
    const errors: string[] = []
    const orig = console.error
    console.error = (line: string) => { errors.push(String(line)) }
    try {
      await runHousekeeping({
        logsDir: join(tmpdir(), `cynco-housekeeping-absent-${process.pid}-${Date.now()}`),
        now: () => 0,
        lastPaged: new Map(),
        publish: async (p) => { pages.push(p); return true },
      })
    } finally {
      console.error = orig
    }
    expect(pages).toEqual([])
    expect(errors.some(l => l.startsWith('[log-cap] '))).toBe(true)
  })
})

// Wave 15 (NOW.md:89, :94): what the daemon last paged about survives a restart, and a refused due
// run is paged at most once a day for each reason. Every file is under this block's own temp folder.
describe('wave 15: the record of what was paged, and the refused-run limit', () => {
  const made: string[] = []
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
  const tmpFile = () => { const d = mkdtempSync(join(tmpdir(), 'cynco-paged-')); made.push(d); return join(d, PAGED_FILE) }

  it('the record round-trips through its file; a missing file is empty, a broken one is empty and said', () => {
    const f = tmpFile()
    const lines: string[] = []
    expect(loadLastPaged(f, l => lines.push(l)).size).toBe(0)
    expect(lines).toEqual([])
    saveLastPaged(f, new Map([['C:\a.log', 5]]), () => 10, l => lines.push(l))
    expect([...loadLastPaged(f, l => lines.push(l))]).toEqual([['C:\a.log', 5]])
    writeFileSync(f, '{ torn')
    expect(loadLastPaged(f, l => lines.push(l)).size).toBe(0)
    expect(lines.some(l => l.startsWith(`[daemon] the record of pages sent (${f}) cannot be read`))).toBe(true)
  })

  it('a record older than a day is dropped when the file is written', () => {
    const f = tmpFile()
    saveLastPaged(f, new Map([['old', 0], ['new', 2 * 24 * HOUR]]), () => 2 * 24 * HOUR + 1)
    expect([...loadLastPaged(f)]).toEqual([['new', 2 * 24 * HOUR]])
  })

  it('a log paged before a restart is not paged again by the restarted daemon within the day', async () => {
    const f = tmpFile()
    const big = { path: 'C:\home\.cynco\embed-server.log', bytes: LOG_PAGE_BYTES + 1 }
    const h = harness([big])
    await runHousekeeping({ ...h.deps, save: m => saveLastPaged(f, m, h.deps.now) })
    expect(h.pages).toHaveLength(1)
    // The restart: a new daemon, a new map, read from the file.
    const h2 = harness([big])
    h2.lastPaged.clear()
    for (const [k, v] of loadLastPaged(f)) h2.lastPaged.set(k, v)
    await runHousekeeping(h2.deps)
    expect(h2.pages).toEqual([])
  })

  it('a refused run is paged once a day for each reason; any other page passes; a page not taken is tried again', async () => {
    let t = 1_000_000
    const sent: Array<{ title: string; message: string }> = []
    const answers: boolean[] = []
    const saved: number[] = []
    const lines: string[] = []
    const lastPaged = new Map<string, number>()
    const publish = onceADayRefusals({
      publish: async p => { sent.push(p); return answers.length ? answers.shift()! : true },
      lastPaged, now: () => t, save: m => { saved.push(m.size) }, log: l => lines.push(l),
    })
    const refused = (why: string) => ({ title: 'CynCo refused a run of mission dynasty', message: `REFUSED: integrity: ${why}` })
    expect(await publish(refused('the models record does not match'))).toBe(true)
    t += HOUR
    expect(await publish(refused('the models record does not match'))).toBe(true)
    expect(sent).toHaveLength(1)
    expect(lines).toEqual(['[daemon] not paged again today (paged at 1970-01-01T00:16:40.000Z): CynCo refused a run of mission dynasty: REFUSED: integrity: the models record does not match'])
    expect(await publish(refused('the sandbox root is missing'))).toBe(true)
    expect(sent).toHaveLength(2)
    expect(await publish({ title: 'CynCo stuck on mission dynasty', message: 'x' })).toBe(true)
    expect(await publish({ title: 'CynCo stuck on mission dynasty', message: 'x' })).toBe(true)
    expect(sent).toHaveLength(4)
    t += 24 * HOUR
    expect(await publish(refused('the models record does not match'))).toBe(true)
    expect(sent).toHaveLength(5)
    // Not taken: not recorded, so the next due run pages.
    answers.push(false)
    expect(await publish(refused('a new reason'))).toBe(false)
    expect(await publish(refused('a new reason'))).toBe(true)
    expect(sent.filter(p => p.message.endsWith('a new reason'))).toHaveLength(2)
    expect(saved.length).toBe(4)
  })

  // Wave 15b (check P1-C10): a reason that names a run id, a time or a count changes from one due run to the next;
  // keyed on the message as it was, each one paged again.
  it('the key leaves out what changes from one due run to the next: run ids, times and numbers; another reason still pages', async () => {
    expect(refusedRunKey('CynCo refused a run of mission dynasty', 'REFUSED: integrity: the baseline process exited 1 (walk of daemon-dynasty-t1-20261124T101500-0a1b took 6123 ms at 2026-11-24T10:15:06.123Z)'))
      .toBe('refused|CynCo refused a run of mission dynasty|REFUSED: integrity: the baseline process exited # (walk of <run> took # ms at <time>)')
    let t = 1_000_000
    const sent: string[] = []
    const publish = onceADayRefusals({ publish: async p => { sent.push(p.message); return true }, lastPaged: new Map(), now: () => t, log: () => {} })
    const page = (m: string) => publish({ title: 'CynCo refused a run of mission dynasty', message: m })
    await page('REFUSED: integrity: no integrity baseline could be taken (the baseline process exited 1 (daemon-dynasty-t1-20261124T101500-0a1b: 6123 ms))')
    t += HOUR
    await page('REFUSED: integrity: no integrity baseline could be taken (the baseline process exited 1 (daemon-dynasty-t1-20261124T111500-9f9f: 5987 ms))')
    expect(sent).toHaveLength(1)
    await page('REFUSED: containment: the sandbox root C:/cynco-sandbox is not an existing folder')
    expect(sent).toHaveLength(2)
  })

  it('the refused-run title the limit reads is the one the mission runner writes', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'daemon', 'missionRunner.ts'), 'utf-8')
    const title = /title: `(CynCo refused a run of mission )\$\{/.exec(src)
    expect(title, 'the refused-run page title in missionRunner.ts').not.toBeNull()
    expect(REFUSED_RUN_TITLE.test(`${title![1]}dynasty`)).toBe(true)
  })
})
