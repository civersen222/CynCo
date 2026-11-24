/**
 * engine/daemon/housekeeping.ts (F242, slice S8): the daily page about a service log over 1 GiB.
 * Every dependency is injected: the clock, the page, the listing. The one case that uses the real
 * listing reads a folder that does not exist, so nothing is created and nothing is sent.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LOG_PAGE_BYTES } from '../../logCap.js'
import { LOG_PAGE_TITLE, logPageMessage, runHousekeeping } from '../../daemon/housekeeping.js'

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
