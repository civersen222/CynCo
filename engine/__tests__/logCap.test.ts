/**
 * engine/logCap.ts (F242): the one deleting function of the containment work, and the two log
 * bounds beside it. Every case works in its own mkdtemp folder.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCapped, LOG_PAGE_BYTES, MISSION_LOG_KEEP_DAYS, MISSION_LOG_RE, oversizedLogs, pruneOldFiles,
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

  it('creates a missing file and never creates a sibling', () => {
    const dir = root()
    const p = join(dir, 'new.log')
    appendCapped(p, 'hello\n', 1000)
    expect(readFileSync(p, 'utf-8')).toBe('hello\n')
    for (let i = 0; i < 20; i++) appendCapped(p, 'x'.repeat(100), 1000)
    expect(readdirSync(dir)).toEqual(['new.log'])
  })
})

describe('oversizedLogs', () => {
  it('lists only *.log regular files over the threshold', () => {
    const dir = root()
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(200))
    writeFileSync(join(dir, 'small.log'), 'x'.repeat(10))
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200))
    mkdirSync(join(dir, 'x.log'))
    const r = oversizedLogs(dir, 100)
    expect(r).toEqual([{ path: join(dir, 'big.log'), bytes: 200 }])
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
