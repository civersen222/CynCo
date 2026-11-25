/**
 * engine/logCap.ts (F242): the one deleting function of the containment work, and the two log
 * bounds beside it. Every case works in its own mkdtemp folder.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCapped, LOG_PAGE_BYTES, MISSION_LOG_KEEP_DAYS, MISSION_LOG_RE, oversizedLogs, pruneOldFiles, writeOwnFile,
  STREAM_LOG_MAX_BYTES,
} from '../logCap.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }) })
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'cynco-logcap-'))
  roots.push(r)
  return r
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

function file(dir: string, name: string, ageDays: number, text = 'x'): string {
  const p = join(dir, name)
  writeFileSync(p, text)
  const t = new Date(NOW - ageDays * DAY)
  utimesSync(p, t, t)
  return p
}

/** A symbolic link to a file, or null when this system will not make one for this account. */
function fileLink(target: string, path: string): string | null {
  try {
    symlinkSync(target, path, 'file')
    return path
  } catch (e) {
    console.log(`[test] no file symlink here: ${(e as Error).message}`)
    return null
  }
}

describe('pruneOldFiles', () => {
  const RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

  it('deletes only matching, old, regular files directly in the folder', () => {
    const dir = root()
    file(dir, '2026-01-01.jsonl', 10)
    file(dir, '2026-01-02.jsonl', 10)
    file(dir, '2026-11-20.jsonl', 0)                     // young
    file(dir, 'notes.txt', 10)                           // another name
    file(dir, '2026-01-03.jsonl', 10)                    // kept by name
    mkdirSync(join(dir, '2026-01-04.jsonl'))             // a directory with a matching name
    const nested = join(dir, 'sub')
    mkdirSync(nested)
    file(nested, '2026-01-05.jsonl', 10)                 // not directly in the folder
    const old = new Date(NOW - 10 * DAY)
    utimesSync(join(dir, '2026-01-04.jsonl'), old, old)

    const keepName = process.platform === 'win32' ? '2026-01-03.JSONL' : '2026-01-03.jsonl'
    const r = pruneOldFiles(dir, RE, 2, { now: NOW, keep: [keepName] })

    expect(r.failed).toEqual([])
    expect(r.deleted.sort()).toEqual(['2026-01-01.jsonl', '2026-01-02.jsonl'])
    const left = readdirSync(dir).sort()
    expect(left).toContain('2026-11-20.jsonl')
    expect(left).toContain('notes.txt')
    expect(left).toContain('2026-01-04.jsonl')
    expect(left).toContain('sub')
    expect(existsSync(join(nested, '2026-01-05.jsonl'))).toBe(true)
    // Kept by name (case-insensitively on Windows, where the name is given in capitals).
    expect(left).toContain('2026-01-03.jsonl')
  })

  it('leaves a symbolic link with a matching name, and the file it points at', (ctx) => {
    const dir = root()
    const outside = root()
    const target = file(outside, '2026-01-01.jsonl', 10)
    const link = fileLink(target, join(dir, '2026-01-02.jsonl'))
    if (link === null) { ctx.skip(); return }
    const old = new Date(NOW - 10 * DAY)
    fs.lutimesSync(link, old, old)
    const r = pruneOldFiles(dir, RE, 2, { now: NOW })
    expect(r.deleted).toEqual([])
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('leaves a junction with a matching name and never enters it (Windows)', (ctx) => {
    if (process.platform !== 'win32') { ctx.skip(); return }
    const dir = root()
    const outside = root()
    file(outside, '2026-01-01.jsonl', 10)
    symlinkSync(outside, join(dir, '2026-01-02.jsonl'), 'junction')
    const r = pruneOldFiles(dir, RE, 2, { now: NOW })
    expect(r.deleted).toEqual([])
    expect(existsSync(join(outside, '2026-01-01.jsonl'))).toBe(true)
  })

  it('refuses a relative folder and deletes nothing', () => {
    const r = pruneOldFiles('some/relative/folder', RE, 90)
    expect(r.deleted).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.error).toMatch(/not an absolute path/)
  })

  // A file name cannot hold a NUL, so even a refusal that failed could delete nothing here.
  const NEVER_MATCHES = /\0never/

  it.skipIf(process.platform !== 'win32')('refuses a path rooted on the current drive and a volume root (Windows)', () => {
    for (const d of ['\\no-such-folder-xyz-9', '/no-such-folder-xyz-9']) {
      const r = pruneOldFiles(d, NEVER_MATCHES, 90)
      expect(r.deleted).toEqual([])
      expect(r.failed[0]!.error).toMatch(/not an absolute path/)
    }
    for (const d of ['C:\\', 'C:/']) {
      const r = pruneOldFiles(d, NEVER_MATCHES, 90)
      expect(r.deleted).toEqual([])
      expect(r.failed[0]!.error).toMatch(/volume root/)
    }
  })

  it('refuses a volume root off Windows too', () => {
    if (process.platform === 'win32') return
    const r = pruneOldFiles("/", NEVER_MATCHES, 90)
    expect(r.failed[0]!.error).toMatch(/volume root/)
  })

  it('with nameTime, a file goes only when its name is old too; an undated name stays', () => {
    const dir = root()
    file(dir, '2020-01-01.jsonl', 400)
    file(dir, 'undated.jsonl', 400)
    const young = new Date(NOW)
    const youngName = `${young.getFullYear()}-${String(young.getMonth() + 1).padStart(2, '0')}-${String(young.getDate()).padStart(2, '0')}.jsonl`
    file(dir, youngName, 400)
    const nameTime = (n: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(n)
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime() : null
    }
    const r = pruneOldFiles(dir, /\.jsonl$/, 90, { nameTime })
    expect(r.deleted).toEqual(['2020-01-01.jsonl'])
    expect(readdirSync(dir).sort()).toEqual([youngName, 'undated.jsonl'].sort())
  })

  it('refuses an age limit of 0 (and one that is not a finite number) and deletes nothing', () => {
    const dir = root()
    file(dir, '2026-01-01.jsonl', 10)
    for (const bad of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = pruneOldFiles(dir, RE, bad, { now: NOW })
      expect(r.deleted).toEqual([])
      expect(r.failed).toHaveLength(1)
      expect(r.failed[0]!.name).toBe(dir)
    }
    expect(existsSync(join(dir, '2026-01-01.jsonl'))).toBe(true)
  })

  it('a folder that cannot be listed is a refusal, not a throw', () => {
    const dir = join(root(), 'does-not-exist')
    const r = pruneOldFiles(dir, RE, 90)
    expect(r.deleted).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.name).toBe(dir)
  })

  it('an unlink that fails is returned in failed and the rest proceed', () => {
    const dir = root()
    file(dir, '2026-01-01.jsonl', 10)
    file(dir, '2026-01-02.jsonl', 10)
    file(dir, '2026-01-03.jsonl', 10)
    const real = fs.unlinkSync
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith('2026-01-02.jsonl')) throw Object.assign(new Error('held open'), { code: 'EBUSY' })
      return real(p)
    })
    syncBuiltinESMExports()
    const r = pruneOldFiles(dir, RE, 2, { now: NOW })
    expect(r.deleted.sort()).toEqual(['2026-01-01.jsonl', '2026-01-03.jsonl'])
    expect(r.failed).toEqual([{ name: '2026-01-02.jsonl', error: 'EBUSY: held open' }])
    expect(existsSync(join(dir, '2026-01-02.jsonl'))).toBe(true)
  })
})

describe('appendCapped', () => {
  it('appends under the cap', () => {
    const p = join(root(), 'stream.log')
    appendCapped(p, 'one\n', 100)
    appendCapped(p, 'two\n', 100)
    expect(readFileSync(p, 'utf-8')).toBe('one\ntwo\n')
  })

  it('restarts the file in place with the header when the append would cross the cap', () => {
    const dir = root()
    const p = join(dir, 'stream.log')
    writeFileSync(p, 'Q'.repeat(90))
    appendCapped(p, 'b'.repeat(20), 100)
    const text = readFileSync(p, 'utf-8')
    expect(text).toMatch(/^--- log restarted \d{4}-\d{2}-\d{2}T[^ ]+: it passed 100 bytes ---\n/)
    expect(text.endsWith('b'.repeat(20))).toBe(true)
    expect(text).not.toContain('Q')
    expect(readdirSync(dir)).toEqual(['stream.log'])
  })

  it('never truncates or extends a file reached through a hard link', () => {
    const dir = root()
    const precious = join(dir, 'precious.db')
    writeFileSync(precious, 'P'.repeat(4096))
    const log = join(dir, '.cynco-stream.log')
    linkSync(precious, log)
    expect(() => appendCapped(log, 'iteration text\n', 1024)).toThrow(/hard link/)
    expect(() => appendCapped(log, 'x', 1 << 20)).toThrow(/hard link/)
    expect(readFileSync(precious, 'utf-8')).toBe('P'.repeat(4096))
  })

  it('never writes through a symbolic link or a junction with the log name', (ctx) => {
    const dir = root()
    const precious = join(dir, 'precious.db')
    writeFileSync(precious, 'P'.repeat(4096))
    const log = join(dir, 'stream.log')
    try {
      symlinkSync(precious, log, 'file')
    } catch (e) {
      console.log(`[test] no file symbolic link here: ${(e as Error).message}`)
      ctx.skip()
      return
    }
    expect(() => appendCapped(log, 'x'.repeat(10), 100)).toThrow(/not a regular file/)
    expect(readFileSync(precious, 'utf-8')).toBe('P'.repeat(4096))
  })

  it('a folder with the log name is not written', () => {
    const dir = root()
    mkdirSync(join(dir, 'stream.log'))
    expect(() => appendCapped(join(dir, 'stream.log'), 'x', 100)).toThrow(/not a regular file/)
  })

  it('creates a missing file and never creates a sibling', () => {
    const dir = root()
    const p = join(dir, 'new.log')
    appendCapped(p, 'hello\n', 1000)
    expect(readFileSync(p, 'utf-8')).toBe('hello\n')
    for (let i = 0; i < 20; i++) appendCapped(p, 'x'.repeat(100), 1000)
    expect(readdirSync(dir)).toEqual(['new.log'])
  })
})

describe('pruneOldFiles: dry run, keepIf and the cap (review of wave 5)', () => {
  it('a dry run names what would go and deletes nothing; keepIf keeps; maxDeletes stops and counts the rest', () => {
    const dir = root()
    const old = NOW - 10 * DAY
    for (const n of ['engine_a.log', 'engine_b.log', 'engine_c.log', 'engine_cited.log']) {
      writeFileSync(join(dir, n), 'x')
      utimesSync(join(dir, n), new Date(old), new Date(old))
    }
    const dry = pruneOldFiles(dir, MISSION_LOG_RE, 2, { now: NOW, dryRun: true, keepIf: (n) => n.includes('cited') })
    expect(dry.deleted.sort()).toEqual(['engine_a.log', 'engine_b.log', 'engine_c.log'])
    expect(readdirSync(dir).sort()).toEqual(['engine_a.log', 'engine_b.log', 'engine_c.log', 'engine_cited.log'])
    const capped = pruneOldFiles(dir, MISSION_LOG_RE, 2, { now: NOW, maxDeletes: 2, keepIf: (n) => n.includes('cited') })
    expect(capped.deleted).toHaveLength(2)
    expect(capped.left).toBe(1)
    expect(readdirSync(dir)).toHaveLength(2)
    expect(readdirSync(dir)).toContain('engine_cited.log')
  })
})

describe('appendCapped: the handle is the file the look found (review of wave 5)', () => {
  it('a file replaced between the look and the open is not written', () => {
    const dir = root()
    const p = join(dir, '.cynco-stream.log')
    writeFileSync(p, 'mine\n')
    // The same name, a different file: what a swap between lstat and open looks like to the handle.
    const other = join(dir, 'other.log')
    writeFileSync(other, 'PRECIOUS')
    const realOpen = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, flags: number) => realOpen(path === p ? other : path, flags)) as typeof fs.openSync)
    syncBuiltinESMExports()
    expect(() => appendCapped(p, 'x', 1000)).toThrow(/changed between the look and the open; it is not written/)
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    expect(readFileSync(other, 'utf-8')).toBe('PRECIOUS')
    expect(readFileSync(p, 'utf-8')).toBe('mine\n')
  })

  // Wave 19 (check C4-7 of wave 15b, for the stream log): a name that was free at the look is
  // created exclusively. Opened with O_CREAT alone, whatever was made under it in between (a
  // symbolic link to a file of the owner's, where the run may make one) was opened and written:
  // fstat shows a regular file with one name, and with nothing seen at the look there is nothing to
  // compare it with. A file that appears between the look and the open stands in for that link.
  it('a file that appeared under a name free at the look is not written', () => {
    const dir = root()
    const p = join(dir, '.cynco-stream.log')
    const realLstat = fs.lstatSync
    let raced = 0
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      try {
        return (realLstat as (...a: unknown[]) => fs.Stats)(target, ...rest)
      } catch (e) {
        if (String(target) === p && (e as NodeJS.ErrnoException).code === 'ENOENT' && raced === 0) {
          raced++
          writeFileSync(p, 'the owner\'s notes\n')
        }
        throw e
      }
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    expect(() => appendCapped(p, 'iteration text\n', 1000)).toThrow(/EEXIST/)
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    expect(raced).toBe(1)
    expect(readFileSync(p, 'utf-8')).toBe('the owner\'s notes\n')
  })
})

describe('writeOwnFile (wave 19: the one own-file rule, which the loop\'s debug file uses too)', () => {
  it('writes a new file, and replaces a longer one whole', () => {
    const dir = root()
    const p = join(dir, '.cynco-debug.json')
    writeOwnFile(p, '{"a":1}')
    expect(readFileSync(p, 'utf-8')).toBe('{"a":1}')
    writeFileSync(p, 'x'.repeat(5000))
    writeOwnFile(p, '{"b":2}')
    expect(readFileSync(p, 'utf-8')).toBe('{"b":2}')
    expect(readdirSync(dir)).toEqual(['.cynco-debug.json'])
  })

  it('never writes a hard link, a folder, or a file swapped in after the look', () => {
    const dir = root()
    const precious = join(dir, 'precious.db')
    writeFileSync(precious, 'P'.repeat(64))
    const linked = join(dir, 'linked.json')
    linkSync(precious, linked)
    expect(() => writeOwnFile(linked, '{}')).toThrow(/hard link/)
    mkdirSync(join(dir, 'folder.json'))
    expect(() => writeOwnFile(join(dir, 'folder.json'), '{}')).toThrow(/not a regular file/)
    expect(readFileSync(precious, 'utf-8')).toBe('P'.repeat(64))
    // The same name, a different file (one name of its own): a swap between the look and the open.
    const mine = join(dir, 'mine.json')
    writeFileSync(mine, 'mine')
    const other = join(dir, 'other.db')
    writeFileSync(other, 'O'.repeat(64))
    const realOpen = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, flags: number) => realOpen(path === mine ? other : path, flags)) as typeof fs.openSync)
    syncBuiltinESMExports()
    expect(() => writeOwnFile(mine, '{}')).toThrow(/changed between the look and the open; it is not written/)
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    expect(readFileSync(other, 'utf-8')).toBe('O'.repeat(64))
    expect(readFileSync(mine, 'utf-8')).toBe('mine')
  })
})

describe('oversizedLogs', () => {
  it('lists only *.log (and the one previous *.log.1) regular files over the threshold', () => {
    const dir = root()
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(200))
    writeFileSync(join(dir, 'big.log.1'), 'x'.repeat(300))
    writeFileSync(join(dir, 'big.log.2'), 'x'.repeat(300))
    writeFileSync(join(dir, 'small.log'), 'x'.repeat(10))
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200))
    mkdirSync(join(dir, 'x.log'))
    const r = oversizedLogs(dir, 100).sort((a, b) => (a.path < b.path ? -1 : 1))
    expect(r).toEqual([{ path: join(dir, 'big.log'), bytes: 200 }, { path: join(dir, 'big.log.1'), bytes: 300 }])
  })

  it('returns [] for a folder that does not exist, and does not throw', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(oversizedLogs(join(root(), 'nope'), 1)).toEqual([])
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[log-cap\] /))
  })
})

describe('the log constants', () => {
  it('MISSION_LOG_RE names the mission logs and pid files and nothing else', () => {
    for (const ok of ['engine_a.log', 'driver_a.pid', 'engine_idle_after_a.log', 'driver_x.log', 'engine_b.pid']) {
      expect(MISSION_LOG_RE.test(ok), ok).toBe(true)
    }
    for (const no of ['engine.log', 'driver_a.txt', 'xdriver_a.log', 'engine_.log', 'Engine_a.log']) {
      expect(MISSION_LOG_RE.test(no), no).toBe(false)
    }
  })

  it('the sizes and the age are the specified ones', () => {
    expect(STREAM_LOG_MAX_BYTES).toBe(16 * 1024 * 1024)
    expect(LOG_PAGE_BYTES).toBe(1024 * 1024 * 1024)
    expect(MISSION_LOG_KEEP_DAYS).toBe(90)
  })
})
