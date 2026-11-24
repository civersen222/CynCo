/**
 * engine/audit/toolAudit.ts (F242): the tool-call audit of unattended runs.
 *
 * Every case builds its folders under its own mkdtemp root and writes the marker itself; nothing
 * here resolves the live audit folder. The two cases that call the handles with no argument resolve
 * the suite's default (setup/containment.ts points it at a folder that is never created) and assert
 * that it refuses and that nothing was created.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUDIT_FILE_RE, AUDIT_GAP_RANGES, AUDIT_MARKER, AUDIT_NOT_WRITTEN, WITHHELD_SRC, auditRefusal, containmentFault, createToolAudit,
  harnessAudit, resolveAuditDir, setContainmentFaultSink, toolAudit, verifyAuditFiles, type AuditSrc,
} from '../../audit/toolAudit.js'
import { auditDir } from '../../paths.js'
import { isInside, realPathOf } from '../../realPath.js'
import { setRunContainment, testContainment } from '../../containment.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }) })

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  setContainmentFaultSink(null)
  setRunContainment(null)
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'cynco-toolaudit-'))
  roots.push(r)
  return r
}

/** A marked audit folder under a fresh root. */
function marked(): { root: string; dir: string } {
  const r = root()
  const dir = join(r, 'audit')
  mkdirSync(dir)
  writeFileSync(join(dir, AUDIT_MARKER), '')
  return { root: r, dir }
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A clock that stays at one instant until it is moved. */
function clock(start: Date): { now: () => Date; set: (d: Date) => void } {
  let t = start
  return { now: () => t, set: (d: Date) => { t = d } }
}

const FIXED = new Date(2026, 10, 23, 12, 0, 0)

function lines(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf-8').split('\n').filter(l => l !== '').map(l => JSON.parse(l))
}

function dayFiles(dir: string): string[] {
  return readdirSync(dir).filter(n => AUDIT_FILE_RE.test(n) && statSync(join(dir, n)).isFile()).sort()
}

function allRecords(dir: string): Array<Record<string, any>> {
  return dayFiles(dir).flatMap(n => lines(join(dir, n)))
}

/** A string of letters outside the hex alphabet, so no hash in the file can contain a piece of it. */
function letters(n: number): string {
  const abc = 'ghijklmnopqrstuvwxyz'
  return [...randomBytes(n)].map(b => abc[b % abc.length]).join('')
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

function ctxFor(r: string, audit: string | null, extra: { home?: string; runId?: string } = {}) {
  return testContainment({
    missionCwd: join(r, 'mission'),
    sandbox: { root: join(r, 'sb'), home: join(r, 'sb', 'home'), tmp: join(r, 'sb', 'tmp'), scratch: join(r, 'sb', 'scratch') },
    home: extra.home ?? join(r, 'home'),
    folders: { state: join(r, 'state'), models: join(r, 'models'), guard: join(r, 'guard'), audit },
    ...(extra.runId ? { runId: extra.runId } : {}),
  })
}

/** A directory link to `target` at `path` (a junction on Windows), or null when none can be made. */
function dirLink(target: string, path: string): string | null {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return path
  } catch (e) {
    console.log(`[test] no directory link here: ${(e as Error).message}`)
    return null
  }
}

// ─── auditDir ────────────────────────────────────────────────────────────────────────────────

describe('auditDir', () => {
  it('the override wins, empty is unset, the default is C:/cynco-audit on Windows and nothing elsewhere', () => {
    expect(auditDir({ LOCALCODE_AUDIT_DIR: 'E:/elsewhere' }, 'win32')).toBe('E:/elsewhere')
    expect(auditDir({ LOCALCODE_AUDIT_DIR: '/srv/audit' }, 'linux')).toBe('/srv/audit')
    expect(auditDir({ LOCALCODE_AUDIT_DIR: '' }, 'win32')).toBe('C:/cynco-audit')
    expect(auditDir({}, 'win32')).toBe('C:/cynco-audit')
    expect(auditDir({}, 'linux')).toBeNull()
    expect(auditDir({ LOCALCODE_AUDIT_DIR: '' }, 'linux')).toBeNull()
  })
})

// ─── resolveAuditDir ─────────────────────────────────────────────────────────────────────────

describe('resolveAuditDir', () => {
  const codeOf = (r: ReturnType<typeof resolveAuditDir>) => (r.ok ? 'ok' : r.code)
  const expectReason = (r: ReturnType<typeof resolveAuditDir>, code: string) => {
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe(code)
    expect(r.reason.startsWith(`${code}: `)).toBe(true)
  }

  it('null and empty give audit-dir-unset', () => {
    expectReason(resolveAuditDir({ dir: null, home: '/h', platform: 'linux' }), 'audit-dir-unset')
    expectReason(resolveAuditDir({ dir: '', home: '/h' }), 'audit-dir-unset')
    const r = resolveAuditDir({ dir: null, home: '/h', platform: 'linux' })
    expect(!r.ok && r.reason).toContain('no default audit folder on linux')
  })

  it('a relative path gives audit-dir-relative, judged as Windows and as the host', () => {
    expectReason(resolveAuditDir({ dir: 'cynco-audit', home: 'C:\\Users\\x', platform: 'win32' }), 'audit-dir-relative')
    expectReason(resolveAuditDir({ dir: 'C:cynco-audit', home: 'C:\\Users\\x', platform: 'win32' }), 'audit-dir-relative')
    expectReason(resolveAuditDir({ dir: join('rel', 'audit'), home: homedir() }), 'audit-dir-relative')
  })

  it('a network path gives audit-dir-network', () => {
    expectReason(resolveAuditDir({ dir: '\\\\nas\\share\\x', home: 'C:\\Users\\x', platform: 'win32' }), 'audit-dir-network')
  })

  it('a folder on an unprotected volume gives audit-dir-not-ntfs', () => {
    const r = resolveAuditDir({ dir: 'D:\\x', home: 'C:\\Users\\x', unprotectedVolumes: ['D:\\'], platform: 'win32' })
    expectReason(r, 'audit-dir-not-ntfs')
    expect(!r.ok && r.reason).toContain('is on D:\\')
    // compared without case, and a volume given as "d:" is the same one
    expectReason(resolveAuditDir({ dir: 'd:\\x', home: 'C:\\Users\\x', unprotectedVolumes: ['D:'], platform: 'win32' }), 'audit-dir-not-ntfs')
    // A letter with no drive behind it: a folder that passes the volume check has its real path asked,
    // and asking the camera drive (D:) wakes a sleeping USB disk (it timed out once under the full suite).
    expect(codeOf(resolveAuditDir({ dir: 'Q:\\x', home: 'C:\\Users\\x', unprotectedVolumes: ['E:\\'], platform: 'win32' }))).not.toBe('audit-dir-not-ntfs')
  })

  it('a folder inside the home folder, and one that contains it, give audit-dir-in-home', () => {
    const r = root()
    const home = join(r, 'home')
    mkdirSync(home)
    const inside = resolveAuditDir({ dir: join(home, 'audit'), home })
    expectReason(inside, 'audit-dir-in-home')
    expect(!inside.ok && inside.reason).toContain('(F242)')
    expectReason(resolveAuditDir({ dir: r, home }), 'audit-dir-in-home')
    expectReason(resolveAuditDir({ dir: home, home }), 'audit-dir-in-home')
  })

  it('a folder inside or around the run\'s working folder gives audit-dir-in-workspace', () => {
    const r = root()
    const mission = join(r, 'mission')
    mkdirSync(mission)
    expectReason(resolveAuditDir({ dir: join(mission, 'audit'), home: join(r, 'home'), missionCwd: mission }), 'audit-dir-in-workspace')
    const outer = join(r, 'outer')
    mkdirSync(join(outer, 'mission'), { recursive: true })
    expectReason(resolveAuditDir({ dir: outer, home: join(r, 'home'), missionCwd: join(outer, 'mission') }), 'audit-dir-in-workspace')
  })

  it('a link that lands in the home folder is judged by where it lands', (ctx) => {
    const r = root()
    const home = join(r, 'home')
    mkdirSync(join(home, 'x'), { recursive: true })
    const link = dirLink(join(home, 'x'), join(r, 'link'))
    if (link === null) { ctx.skip(); return }
    const res = resolveAuditDir({ dir: link, home })
    expectReason(res, 'audit-dir-in-home')
    expect(!res.ok && res.reason).toContain(realPathOf(join(home, 'x')))
  })

  it('a rooted path with no drive letter gives audit-dir-relative on Windows', () => {
    const r = resolveAuditDir({ dir: '\\no-such-audit-xyz', home: 'C:\\Users\\x', unprotectedVolumes: ['C:\\'], platform: 'win32' })
    expectReason(r, 'audit-dir-relative')
    expect(!r.ok && r.reason).toContain('names no drive letter')
    expectReason(resolveAuditDir({ dir: '/no-such-audit-xyz', home: 'C:\\Users\\x', platform: 'win32' }), 'audit-dir-relative')
  })

  it.skipIf(process.platform !== 'win32')('a junction on C: to a folder on an unprotected volume is judged by where it lands', (ctx) => {
    // The junction points at Q:, named as unprotected, whose folder does not exist: nothing on Q: is touched.
    const r = root()
    const link = dirLink('Q:\\cynco-audit-not-there', join(r, 'link'))
    if (link === null) { ctx.skip(); return }
    expect(realPathOf(link).toUpperCase().startsWith('Q:')).toBe(true)
    const res = resolveAuditDir({ dir: link, home: join(r, 'home'), unprotectedVolumes: ['Q:\\'] })
    expectReason(res, 'audit-dir-not-ntfs')
    expect(!res.ok && res.reason).toContain('resolves to Q:')
  })

  it('a folder inside the sandbox root or an extra root, or around one, gives audit-dir-in-workspace', () => {
    const r = root()
    const sb = join(r, 'sandbox-root')
    const extra = join(r, 'extra')
    mkdirSync(join(sb, 'audit'), { recursive: true })
    mkdirSync(join(extra, 'audit'), { recursive: true })
    const base = { home: join(r, 'home'), missionCwd: join(r, 'mission'), workspaceRoots: [sb, extra] }
    expectReason(resolveAuditDir({ ...base, dir: join(sb, 'audit') }), 'audit-dir-in-workspace')
    expectReason(resolveAuditDir({ ...base, dir: join(extra, 'audit') }), 'audit-dir-in-workspace')
    const res = resolveAuditDir({ ...base, dir: join(extra, 'audit') })
    expect(!res.ok && res.reason).toContain('a folder a contained run may write')
    expect(resolveAuditDir({ ...base, dir: join(r, 'audit') }).ok).toBe(true)
  })

  it('a good folder resolves to its real path', () => {
    const { root: r, dir } = marked()
    const res = resolveAuditDir({ dir, home: join(r, 'home'), missionCwd: join(r, 'mission'), unprotectedVolumes: [] })
    expect(res).toEqual({ ok: true, dir: realPathOf(dir) })
  })
})

// ─── Opening ─────────────────────────────────────────────────────────────────────────────────

describe('open', () => {
  it('a folder that does not exist gives audit-dir-missing and is not created', () => {
    const dir = join(root(), 'nope')
    const a = createToolAudit({ dir })
    const o = a.open()
    expect(o.ok).toBe(false)
    expect(!o.ok && o.reason).toMatch(/^audit-dir-missing: /)
    expect(existsSync(dir)).toBe(false)
    expect(a.start({ src: 'tool', tool: 'Bash', input: {}, cwd: dir })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-dir-missing') })
    expect(existsSync(dir)).toBe(false)
  })

  it('a folder without the marker gives audit-dir-foreign and nothing is written into it', () => {
    const dir = join(root(), 'audit')
    mkdirSync(dir)
    const a = createToolAudit({ dir })
    const o = a.open()
    expect(!o.ok && o.reason).toMatch(/^audit-dir-foreign: /)
    a.start({ src: 'tool', input: {}, cwd: dir })
    a.refused({ src: 'tool', by: 'executor', cwd: dir, reason: 'x' })
    expect(a.probe('dispatch')).toMatch(/^audit-dir-foreign: /)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a marker that is a directory is not a marker', () => {
    const dir = join(root(), 'audit')
    mkdirSync(join(dir, AUDIT_MARKER), { recursive: true })
    expect(createToolAudit({ dir }).probe('dispatch')).toMatch(/^audit-dir-foreign: /)
  })

  it('a marked folder opens with one open record (seq 1, the arguments hashed, cwd, ppid); a second open writes nothing', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, run: 'r-1', now: () => FIXED })
    expect(a.open()).toEqual({ ok: true, dir: realPathOf(dir) })
    const day = join(dir, `${localDate(FIXED)}.jsonl`)
    const recs = lines(day)
    expect(recs).toHaveLength(1)
    const r = recs[0]!
    expect(r).toMatchObject({ v: 1, kind: 'open', seq: 1, run: 'r-1', dir: realPathOf(dir), cwd: process.cwd(), ppid: process.ppid })
    const args = JSON.stringify(process.argv.slice(2))
    expect(r.script).toBe(process.argv[1])
    expect(r.argc).toBe(process.argv.length - 2)
    expect(r.argvSha256).toBe(sha(args))
    expect(r.argvBytes).toBe(Buffer.byteLength(args, 'utf8'))
    expect(r.argv).toBeUndefined()
    expect(r.ts).toBe(FIXED.toISOString())
    expect(r.proc).toMatch(/^\d+-[0-9a-z]+$/)
    expect(a.open().ok).toBe(true)
    expect(lines(day)).toHaveLength(1)
  })
})

describe('the open record never carries the process\'s arguments as text (rule 10)', () => {
  it('a process started with a withheld check command as an argument: the command is not in the day file', () => {
    const { dir } = marked()
    const secret = `bun gates/SEALED_GATE_${letters(16)}.test.ts`
    const saved = process.argv
    process.argv = [...saved.slice(0, 2), 'brief.md', 'MARK', secret]
    try {
      const a = createToolAudit({ dir, now: () => FIXED })
      expect(a.open().ok).toBe(true)
    } finally {
      process.argv = saved
    }
    const text = readFileSync(join(dir, `${localDate(FIXED)}.jsonl`), 'utf-8')
    expect(text).not.toContain(secret)
    expect(text).not.toContain(secret.slice(13, 25))
    expect(lines(join(dir, `${localDate(FIXED)}.jsonl`))[0]!.argc).toBe(3)
  })
})

// ─── Records ─────────────────────────────────────────────────────────────────────────────────

describe('start, end and refused', () => {
  it('the start carries the full input verbatim; the end pairs with it and cuts the output head at 2000', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    const big = letters(300 * 1024)
    const s = a.start({ src: 'tool', tool: 'Bash', input: { command: big }, cwd: '/w' })
    expect(s.ok).toBe(true)
    if (!s.ok) return
    a.end(s.call, { isError: true, exitCode: 3, ms: 12, output: 'o'.repeat(5000) })
    const [, start, end] = allRecords(dir)
    expect(start).toMatchObject({ kind: 'start', src: 'tool', tool: 'Bash', cwd: '/w', seq: s.call })
    expect(start!.input.command).toBe(big)
    expect(end).toMatchObject({ kind: 'end', src: 'tool', call: s.call, isError: true, exitCode: 3, ms: 12 })
    expect(end!.outputHead).toBe('o'.repeat(2000))
  })

  it('an exitCode key that was not passed is absent, and null is written as null', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    const s1 = a.start({ src: 'tool', tool: 'Read', input: {}, cwd: '/w' })
    const s2 = a.start({ src: 'tool', tool: 'Bash', input: {}, cwd: '/w' })
    if (!s1.ok || !s2.ok) throw new Error('start failed')
    a.end(s1.call, { isError: false, ms: 1, output: 'ok' })
    a.end(s2.call, { isError: true, exitCode: null, ms: 1, output: 'threw: x' })
    const ends = allRecords(dir).filter(r => r.kind === 'end')
    expect('exitCode' in ends[0]!).toBe(false)
    expect(ends[1]!.exitCode).toBeNull()
    expect('exitCode' in ends[1]!).toBe(true)
  })

  it('refused carries by, layer and the reason cut at 500', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    a.refused({ src: 'tool', by: 'executor', tool: 'Write', input: { file_path: 'x' }, cwd: '/w', layer: 'protected path', reason: 'r'.repeat(900) })
    const rec = allRecords(dir).find(r => r.kind === 'refused')!
    expect(rec).toMatchObject({ by: 'executor', tool: 'Write', layer: 'protected path', cwd: '/w', input: { file_path: 'x' } })
    expect(rec.reason).toBe('r'.repeat(500))
  })

  it('the session id is written when it is set', () => {
    const { dir } = marked()
    const before = process.env.LOCALCODE_SESSION_ID
    process.env.LOCALCODE_SESSION_ID = 'sess-42'
    try {
      createToolAudit({ dir, now: () => FIXED }).start({ src: 'tool', input: {}, cwd: '/w' })
    } finally {
      if (before === undefined) delete process.env.LOCALCODE_SESSION_ID
      else process.env.LOCALCODE_SESSION_ID = before
    }
    expect(allRecords(dir).find(r => r.kind === 'start')!.session).toBe('sess-42')
  })

  it('an escalate note is written with the start', () => {
    const { dir } = marked()
    const note = { rule: 'r', reason: 'why', targets: ['a'], recursive: false, isolation: 'verified' }
    createToolAudit({ dir, now: () => FIXED }).start({ src: 'tool', input: {}, cwd: '/w', escalate: note })
    expect(allRecords(dir).find(r => r.kind === 'start')!.escalate).toEqual(note)
  })
})

describe('withheld sources', () => {
  for (const src of WITHHELD_SRC) {
    it(`${src}: neither the command nor the output is in the day file; the hashes and lengths are`, () => {
      const { dir } = marked()
      const a = createToolAudit({ dir, now: () => FIXED })
      const command = `bun test ${letters(200)}`
      const output = `FAIL ${letters(3000)}`
      const s = a.start({ src, command, cwd: '/w' })
      if (!s.ok) throw new Error(s.reason)
      a.end(s.call, { isError: false, exitCode: 0, ms: 5, output })
      a.refused({ src, by: 'executor', input: { command }, cwd: '/w', reason: `Blocked: ${command}` })
      const text = readFileSync(join(dir, `${localDate(FIXED)}.jsonl`), 'utf-8')
      for (const secret of [command, output]) {
        for (let i = 0; i + 12 <= secret.length; i++) {
          const piece = secret.slice(i, i + 12)
          if (text.includes(piece)) throw new Error(`a 12-character piece of withheld text is in the day file: ${piece}`)
        }
      }
      const recs = allRecords(dir)
      const start = recs.find(r => r.kind === 'start')!
      const end = recs.find(r => r.kind === 'end')!
      expect(start).toMatchObject({ src, commandSha256: sha(command), commandBytes: Buffer.byteLength(command) })
      expect('command' in start).toBe(false)
      expect(end).toMatchObject({ src, call: s.call, exitCode: 0, ms: 5, outputSha256: sha(output), outputBytes: Buffer.byteLength(output) })
      expect('outputHead' in end || 'outputTail' in end).toBe(false)
    })
  }

  it('best-of-n: the command is verbatim and the end holds the LAST 2000 characters', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    const output = 'a'.repeat(1000) + 'b'.repeat(2000)
    const s = a.start({ src: 'best-of-n', command: 'npx vitest run x', cwd: '/w' })
    if (!s.ok) throw new Error(s.reason)
    a.end(s.call, { isError: false, exitCode: 0, ms: 1, output })
    const recs = allRecords(dir)
    expect(recs.find(r => r.kind === 'start')!.command).toBe('npx vitest run x')
    expect(recs.find(r => r.kind === 'end')!.outputTail).toBe('b'.repeat(2000))
  })
})

// ─── Sequence, failure, fsync ────────────────────────────────────────────────────────────────

describe('the sequence', () => {
  it('is contiguous across open, probe, start, end and refused', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    expect(a.probe('capability')).toBeNull()
    const s = a.start({ src: 'tool', input: {}, cwd: '/w' })
    if (!s.ok) throw new Error(s.reason)
    a.end(s.call, { isError: false, ms: 1, output: '' })
    a.refused({ src: 'tool', by: 'loop', cwd: '/w', reason: 'no' })
    const recs = allRecords(dir)
    expect(recs.map(r => r.kind)).toEqual(['open', 'probe', 'start', 'end', 'refused'])
    expect(recs.map(r => r.seq)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(recs.map(r => r.proc)).size).toBe(1)
    // open and probe of a capability probe come from an engine
    expect(recs[0]!.src).toBe('tool')
  })

  it('a write that fails consumes its number, and the next record shows the gap', () => {
    const { dir } = marked()
    const day1 = new Date(2026, 10, 20, 12), day2 = new Date(2026, 10, 21, 12), day3 = new Date(2026, 10, 22, 12)
    const c = clock(day1)
    const a = createToolAudit({ dir, now: c.now })
    expect(a.open().ok).toBe(true)
    mkdirSync(join(dir, `${localDate(day2)}.jsonl`))           // day 2's file cannot be written
    c.set(day2)
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-dir-unwritable') })
    c.set(day3)
    const s = a.start({ src: 'tool', input: {}, cwd: '/w' })
    expect(s).toEqual({ ok: true, call: 3 })
    expect(allRecords(dir).map(r => r.seq)).toEqual([1, 3])
  })
})

describe('a day file that cannot be written', () => {
  it('start refuses with the short text and does not throw; end, refused and probe do not throw', () => {
    const { dir } = marked()
    mkdirSync(join(dir, `${localDate(FIXED)}.jsonl`))
    const a = createToolAudit({ dir, now: () => FIXED })
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-dir-unwritable') })
    expect(() => a.end(1, { isError: false, ms: 1, output: 'x' })).not.toThrow()
    expect(() => a.refused({ src: 'tool', by: 'executor', cwd: '/w', reason: 'x' })).not.toThrow()
    expect(a.probe('dispatch')).toMatch(/^audit-dir-unwritable: /)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[tool-audit\] audit-dir-unwritable: /))
  })
})

describe('fsync', () => {
  it('is called for open, probe and start, and not for end or refused', () => {
    const { dir } = marked()
    const spy = vi.spyOn(fs, 'fsyncSync')
    syncBuiltinESMExports()
    const a = createToolAudit({ dir, now: () => FIXED })
    expect(a.open().ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(a.probe('dispatch')).toBeNull()
    expect(spy).toHaveBeenCalledTimes(2)
    const s = a.start({ src: 'tool', input: {}, cwd: '/w' })
    expect(spy).toHaveBeenCalledTimes(3)
    if (!s.ok) throw new Error(s.reason)
    a.end(s.call, { isError: false, ms: 1, output: '' })
    a.refused({ src: 'tool', by: 'executor', cwd: '/w', reason: 'x' })
    expect(spy).toHaveBeenCalledTimes(3)
    expect(allRecords(dir)).toHaveLength(5)
  })
})

// ─── Files: roll, midnight, retention, shrunk ────────────────────────────────────────────────

describe('day files', () => {
  it('a full file is left as it is: the next record starts <date>.1.jsonl, which a second writer adopts', () => {
    const { dir } = marked()
    const day = join(dir, `${localDate(FIXED)}.jsonl`)
    const probeDir = marked().dir
    // The cap is set just above the size of an open record, so the start after it fills the file.
    createToolAudit({ dir: probeDir, now: () => FIXED }).open()
    const cap = statSync(join(probeDir, `${localDate(FIXED)}.jsonl`)).size + 1
    const a = createToolAudit({ dir, now: () => FIXED, maxFileBytes: cap })
    const s = a.start({ src: 'tool', input: { big: 'x'.repeat(2000) }, cwd: '/w' })
    if (!s.ok) throw new Error(s.reason)
    const first = readFileSync(day)
    expect(first.length).toBeGreaterThanOrEqual(cap)
    a.end(s.call, { isError: false, ms: 1, output: 'ok' })
    const rolled = join(dir, `${localDate(FIXED)}.1.jsonl`)
    expect(lines(rolled).map(r => r.kind)).toEqual(['end'])
    expect(readFileSync(day).equals(first)).toBe(true)

    const b = createToolAudit({ dir, now: () => FIXED, maxFileBytes: cap, proc: 'other-1' })
    expect(b.open().ok).toBe(true)
    expect(lines(rolled).map(r => r.proc)).toContain('other-1')
    expect(readFileSync(day).equals(first)).toBe(true)
  })

  it('a clock crossing local midnight puts the end in the next day\'s file with the same proc and call', () => {
    const { dir } = marked()
    const c = clock(new Date(2026, 10, 23, 23, 59, 59))
    const a = createToolAudit({ dir, now: c.now })
    const s = a.start({ src: 'tool', input: {}, cwd: '/w' })
    if (!s.ok) throw new Error(s.reason)
    c.set(new Date(2026, 10, 24, 0, 0, 1))
    a.end(s.call, { isError: false, ms: 2000, output: '' })
    const d1 = lines(join(dir, '2026-11-23.jsonl'))
    const d2 = lines(join(dir, '2026-11-24.jsonl'))
    expect(d1.map(r => r.kind)).toEqual(['open', 'start'])
    expect(d2).toHaveLength(1)
    expect(d2[0]).toMatchObject({ kind: 'end', call: s.call, proc: d1[1]!.proc, seq: s.call + 1 })
  })

  it('retention at open: an old day file goes; the marker, a young file, a matching subfolder and another name stay', () => {
    const { dir } = marked()
    const now = FIXED.getTime()
    const old = new Date(now - 3 * 86_400_000)
    const put = (name: string, t: Date) => { writeFileSync(join(dir, name), '{}\n'); utimesSync(join(dir, name), t, t) }
    put('2026-11-01.jsonl', old)
    put('2026-11-02.1.jsonl', old)
    put('2026-11-22.jsonl', FIXED)
    put('notes.txt', old)
    mkdirSync(join(dir, '2026-11-03.jsonl'))
    utimesSync(join(dir, '2026-11-03.jsonl'), old, old)
    utimesSync(join(dir, AUDIT_MARKER), old, old)
    expect(createToolAudit({ dir, now: () => FIXED, keepDays: 1 }).open().ok).toBe(true)
    const left = readdirSync(dir).sort()
    expect(left).not.toContain('2026-11-01.jsonl')
    expect(left).not.toContain('2026-11-02.1.jsonl')
    for (const stay of [AUDIT_MARKER, '2026-11-22.jsonl', 'notes.txt', '2026-11-03.jsonl', `${localDate(FIXED)}.jsonl`]) {
      expect(left).toContain(stay)
    }
  })

  it('a truncated day file: the next start refuses with audit-file-shrunk, for good, and the file is not extended', () => {
    const { dir } = marked()
    const day = join(dir, `${localDate(FIXED)}.jsonl`)
    const a = createToolAudit({ dir, now: () => FIXED })
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' }).ok).toBe(true)
    truncateSync(day, 10)
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-file-shrunk') })
    expect(statSync(day).size).toBe(10)
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-file-shrunk') })
    expect(a.probe('dispatch')).toMatch(/^audit-file-shrunk: /)
    a.end(2, { isError: false, ms: 1, output: '' })
    a.refused({ src: 'tool', by: 'loop', cwd: '/w', reason: 'x' })
    expect(statSync(day).size).toBe(10)
  })

  it('a deleted day file: the same refusal, and the file is not recreated', () => {
    const { dir } = marked()
    const day = join(dir, `${localDate(FIXED)}.jsonl`)
    const a = createToolAudit({ dir, now: () => FIXED })
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' }).ok).toBe(true)
    unlinkSync(day)
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-file-shrunk') })
    expect(a.probe('dispatch')).toMatch(/^audit-file-shrunk: /)
    expect(existsSync(day)).toBe(false)
  })

  it('a roll to .1 is not a shrink', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED, maxFileBytes: 200 })
    for (let i = 0; i < 6; i++) {
      expect(a.start({ src: 'tool', input: { i, pad: 'p'.repeat(300) }, cwd: '/w' }).ok).toBe(true)
    }
    expect(dayFiles(dir).length).toBeGreaterThan(2)
    expect(a.probe('dispatch')).toBeNull()
  })

  it('probe writes a record on every call', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    expect(a.probe('dispatch')).toBeNull()
    expect(a.probe('task-runner')).toBeNull()
    const probes = allRecords(dir).filter(r => r.kind === 'probe')
    expect(probes.map(r => r.by)).toEqual(['dispatch', 'task-runner'])
    expect(probes.map(r => r.src)).toEqual(['driver', 'precheck'])
  })
})

// ─── toolAudit, harnessAudit, auditRefusal ───────────────────────────────────────────────────

describe('toolAudit', () => {
  it('is null with no context, and for a test context that names no audit folder', () => {
    expect(toolAudit(null)).toBeNull()
    expect(toolAudit()).toBeNull()
    expect(toolAudit(ctxFor(root(), null))).toBeNull()
  })

  it('a test context naming a marked folder gets a writing handle whose records carry its run id', () => {
    const { root: r, dir } = marked()
    const ctx = ctxFor(r, dir, { runId: 'test-run-one' })
    setRunContainment(ctx)
    const a = toolAudit()
    expect(a).not.toBeNull()
    expect(a!.start({ src: 'tool', tool: 'Bash', input: { command: 'echo hi' }, cwd: ctx.missionCwd }).ok).toBe(true)
    const recs = allRecords(dir)
    expect(recs.map(x => x.run)).toEqual(['test-run-one', 'test-run-one'])
    expect(recs[0]).toMatchObject({ kind: 'open', runKind: 'mission', missionCwd: ctx.missionCwd })
  })

  it('a context whose audit folder is inside its home gets a REFUSING handle, never null', () => {
    const r = root()
    const home = join(r, 'home')
    const dir = join(home, 'audit')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, AUDIT_MARKER), '')
    const a = toolAudit(ctxFor(r, dir, { home }))
    expect(a).not.toBeNull()
    expect(a!.start({ src: 'tool', input: {}, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-dir-in-home') })
    expect(a!.probe('capability')).toMatch(/^audit-dir-in-home: /)
    const o = a!.open()
    expect(!o.ok && o.reason).toMatch(/^audit-dir-in-home: /)
    expect(() => a!.end(1, { isError: false, ms: 1 })).not.toThrow()
    expect(() => a!.refused({ src: 'tool', by: 'loop', cwd: '/w', reason: 'x' })).not.toThrow()
    expect(readdirSync(dir)).toEqual([AUDIT_MARKER])
  })

  it('two calls with two contexts over one folder share one sequence', () => {
    const { root: r, dir } = marked()
    const one = toolAudit(ctxFor(r, dir, { runId: 'test-run-a' }))!
    const two = toolAudit(ctxFor(r, dir, { runId: 'test-run-b' }))!
    const s1 = one.start({ src: 'tool', input: {}, cwd: '/w' })
    const s2 = two.start({ src: 'subagent', input: {}, cwd: '/w' })
    expect(s1).toEqual({ ok: true, call: 2 })
    expect(s2).toEqual({ ok: true, call: 3 })
    const recs = allRecords(dir)
    expect(recs.map(x => x.seq)).toEqual([1, 2, 3])
    expect(new Set(recs.map(x => x.proc)).size).toBe(1)
    expect(recs.map(x => x.run)).toEqual(['test-run-a', 'test-run-a', 'test-run-b'])
  })
})

describe('harnessAudit and auditRefusal', () => {
  it('with a folder and a home passed: null after a real write', () => {
    const { root: r, dir } = marked()
    expect(auditRefusal({ dir, home: join(r, 'home'), by: 'dispatch' })).toBeNull()
    const h = harnessAudit({ dir, home: join(r, 'home'), run: 'grade-run' })
    const s = h.start({ src: 'gate', command: 'npx vitest run sealed', cwd: '/w' })
    expect(s.ok).toBe(true)
    const recs = allRecords(dir)
    expect(recs.map(x => x.kind)).toEqual(['open', 'probe', 'start'])
    expect(recs[1]).toMatchObject({ by: 'dispatch', src: 'driver', run: null })
    expect(recs[2]).toMatchObject({ src: 'gate', run: 'grade-run' })
  }, 60_000)

  it('with no argument: the suite\'s default folder refuses and nothing is created', () => {
    const def = auditDir()
    expect(def).not.toBeNull()
    expect(existsSync(def!)).toBe(false)
    // On Windows the suite's never-created folder is under the temp folder, which is inside the
    // real home, so the policy refuses it before the opening check does.
    const inHome = isInside(realPathOf(homedir(), { quiet: true }), realPathOf(def!, { quiet: true }))
    const code = inHome ? 'audit-dir-in-home' : 'audit-dir-missing'
    expect(auditRefusal()).toMatch(new RegExp(`^${code}: `))
    expect(harnessAudit().start({ src: 'gate', command: 'x', cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN(code) })
    expect(existsSync(def!)).toBe(false)
  }, 60_000)
})

// ─── The fault channel ───────────────────────────────────────────────────────────────────────

describe('the fault channel', () => {
  function unwritableHandle() {
    const { dir } = marked()
    mkdirSync(join(dir, `${localDate(FIXED)}.jsonl`))
    return createToolAudit({ dir, now: () => FIXED })
  }

  it('a failed start calls the sink once with the audit layer and the short text', () => {
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    unwritableHandle().start({ src: 'tool', input: {}, cwd: '/w' })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('audit', AUDIT_NOT_WRITTEN('audit-dir-unwritable'))
  })

  it('with no sink it only logs', () => {
    unwritableHandle().start({ src: 'tool', input: {}, cwd: '/w' })
    expect(errSpy).toHaveBeenCalledWith(`[containment] fault: audit: ${AUDIT_NOT_WRITTEN('audit-dir-unwritable')}`)
  })

  it('a sink that throws does not make start throw', () => {
    setContainmentFaultSink(() => { throw new Error('boom') })
    expect(unwritableHandle().start({ src: 'tool', input: {}, cwd: '/w' }).ok).toBe(false)
    expect(errSpy).toHaveBeenCalledWith('[containment] fault sink threw: boom')
  })

  it('containmentFault prints and hands the fault on', () => {
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    containmentFault('integrity', 'a protected folder changed')
    expect(errSpy).toHaveBeenCalledWith('[containment] fault: integrity: a protected folder changed')
    expect(sink).toHaveBeenCalledWith('integrity', 'a protected folder changed')
  })

  it('a policy refusal raises the fault too', () => {
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    const r = root()
    const home = join(r, 'home')
    mkdirSync(join(home, 'audit'), { recursive: true })
    toolAudit(ctxFor(r, join(home, 'audit'), { home }))!.start({ src: 'tool', input: {}, cwd: '/w' })
    expect(sink).toHaveBeenCalledWith('audit', AUDIT_NOT_WRITTEN('audit-dir-in-home'))
  })
})

// ─── verifyAuditFiles ────────────────────────────────────────────────────────────────────────

describe('verifyAuditFiles', () => {
  const rec = (proc: string, seq: number, kind: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, ts: '2026-11-23T12:00:00.000Z', kind, proc, seq, src: 'tool', run: 'run-1', ...extra })

  it('finds a gap, a start with no end, pairs an end in the next day\'s file, and counts an unparsable line', () => {
    const dir = root()
    const p = 'p1-abc'
    const d1 = join(dir, '2026-11-23.jsonl')
    const d2 = join(dir, '2026-11-24.jsonl')
    writeFileSync(d1, [
      rec(p, 1, 'open'),
      rec(p, 2, 'start', { tool: 'Bash' }),
      rec(p, 3, 'start', { tool: 'Read' }),
      '{"half a record',
      rec(p, 5, 'start', { tool: 'Write' }),
    ].join('\n') + '\n')
    writeFileSync(d2, [rec(p, 6, 'end', { call: 2 }), rec(p, 7, 'end', { call: 5 })].join('\n') + '\n')
    const r = verifyAuditFiles([d1, d2])
    expect(r.unparsable).toBe(1)
    expect(r.procs).toHaveLength(1)
    const pr = r.procs[0]!
    expect(pr.proc).toBe(p)
    expect(pr.records).toBe(6)
    expect(pr.gaps).toEqual([{ from: 4, to: 4 }])
    expect(pr.gapCount).toBe(1)
    expect(pr.firstSeq).toBe(1)
    expect(pr.headMissing).toBe(false)
    expect(pr.runs).toEqual(['run-1'])
    expect(pr.openStarts.map(s => s.seq)).toEqual([3])
    expect(pr.openStarts[0]!.tool).toBe('Read')
  })

  it('a proc first seen at 40 is headMissing when its boot day\'s file was read, and not when only a later day\'s was', () => {
    const dir = root()
    const boot = new Date(2026, 10, 23, 9, 0, 0)
    const proc = `4242-${boot.getTime().toString(36)}`
    const bootDay = join(dir, `${localDate(boot)}.jsonl`)
    const nextDay = join(dir, `${localDate(new Date(2026, 10, 24, 9))}.jsonl`)
    writeFileSync(bootDay, rec(proc, 40, 'probe', { by: 'dispatch' }) + '\n')
    writeFileSync(nextDay, rec(proc, 41, 'probe', { by: 'dispatch' }) + '\n')
    const both = verifyAuditFiles([bootDay, nextDay]).procs[0]!
    expect(both.firstSeq).toBe(40)
    expect(both.headMissing).toBe(true)
    const later = verifyAuditFiles([nextDay]).procs[0]!
    expect(later.firstSeq).toBe(41)
    expect(later.headMissing).toBe(false)
  })

  it('reads what the writer wrote as clean', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    const s = a.start({ src: 'tool', input: {}, cwd: '/w' })
    if (!s.ok) throw new Error(s.reason)
    a.end(s.call, { isError: false, ms: 1, output: '' })
    const r = verifyAuditFiles(dayFiles(dir).map(n => join(dir, n)))
    expect(r.unparsable).toBe(0)
    expect(r.procs[0]).toMatchObject({ records: 3, firstSeq: 1, gaps: [], gapCount: 0, headMissing: false, openStarts: [] })
  })

  it('a seq that is huge, fractional, negative or zero is unparsable, and a far seq costs nothing', () => {
    const dir = root()
    const p = join(dir, '2026-11-23.jsonl')
    writeFileSync(p, [
      rec('a-1', 1, 'open'), rec('a-1', 20_000_000, 'probe'), rec('b-1', 1.5, 'open'),
      rec('c-1', -3, 'open'), rec('d-1', 0, 'open'), rec('e-1', 2 ** 60, 'open'),
    ].join('\n') + '\n')
    const t0 = Date.now()
    const r = verifyAuditFiles([p])
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.unparsable).toBe(4)
    expect(r.procs).toHaveLength(1)
    expect(r.procs[0]!.gaps).toEqual([{ from: 2, to: 19_999_999 }])
    expect(r.procs[0]!.gapCount).toBe(19_999_998)
  })

  it('lists at most AUDIT_GAP_RANGES ranges and counts them all', () => {
    const dir = root()
    const p = join(dir, '2026-11-23.jsonl')
    const recs: string[] = []
    for (let s = 1; s <= 2 * (AUDIT_GAP_RANGES + 50); s += 2) recs.push(rec('a-1', s, 'probe'))
    writeFileSync(p, recs.join('\n') + '\n')
    const pr = verifyAuditFiles([p]).procs[0]!
    expect(pr.gaps).toHaveLength(AUDIT_GAP_RANGES)
    expect(pr.gapCount).toBe(AUDIT_GAP_RANGES + 49)
  })

  it('a torn last line: the record written onto the fragment is still read', () => {
    const dir = root()
    const p = join(dir, '2026-11-23.jsonl')
    writeFileSync(p, rec('a-1', 1, 'open') + '\n' + '{"v":1,"ts":"2026-11-23T1' + '\0'.repeat(8) + rec('b-1', 1, 'open') + '\n')
    const r = verifyAuditFiles([p])
    expect(r.unparsable).toBe(1)
    expect(r.procs.map(x => x.proc).sort()).toEqual(['a-1', 'b-1'])
  })
})

describe('the review of 2026-11-23: the writer', () => {
  it('a record that cannot be serialised is a failed write: start refuses with its code, nothing throws', () => {
    const { dir } = marked()
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    const a = createToolAudit({ dir, now: () => FIXED })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const throwing = { toJSON() { throw new Error('no') } }
    for (const input of [{ n: 10n }, cyclic, throwing]) {
      expect(a.start({ src: 'tool', tool: 'Bash', input, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-record-unserialisable') })
      expect(a.start({ src: 'contract', input, cwd: '/w' })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-record-unserialisable') })
      expect(() => a.refused({ src: 'tool', by: 'executor', input, cwd: '/w', reason: 'x' })).not.toThrow()
      expect(() => a.refused({ src: 'gate', by: 'executor', input, cwd: '/w', reason: 'x' })).not.toThrow()
    }
    expect(a.start({ src: 'tool', input: {}, cwd: '/w', escalate: cyclic })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-record-unserialisable') })
    expect(a.start({ src: 'gate', command: 'x', cwd: '/w', escalate: cyclic })).toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-record-unserialisable') })
    expect(sink).toHaveBeenCalledWith('audit', AUDIT_NOT_WRITTEN('audit-record-unserialisable'))
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[tool-audit\] audit-record-unserialisable: /))
    // The numbers were consumed: the next good record shows the gaps.
    const ok = a.start({ src: 'tool', input: {}, cwd: '/w' })
    expect(ok.ok).toBe(true)
    const v = verifyAuditFiles(dayFiles(dir).map(n => join(dir, n))).procs[0]!
    expect(v.gapCount).toBeGreaterThan(0)
  })

  it('a withheld start hashes its escalate note: no target or reason text is written', () => {
    const { dir } = marked()
    const target = letters(24)
    const note = { rule: 'unresolved', reason: `delete ${target}`, targets: [target], recursive: true, isolation: 'verified' }
    expect(createToolAudit({ dir, now: () => FIXED }).start({ src: 'contract', command: 'x', cwd: '/w', escalate: note }).ok).toBe(true)
    const text = readFileSync(join(dir, `${localDate(FIXED)}.jsonl`), 'utf-8')
    expect(text).not.toContain(target.slice(0, 12))
    const s = lines(join(dir, `${localDate(FIXED)}.jsonl`)).find(x => x.kind === 'start')!
    expect(s.escalate).toBeUndefined()
    expect(s.escalateSha256).toBe(sha(JSON.stringify(note)))
  })

  it('the first write to a day file whose last record was torn starts on a line of its own', () => {
    const { dir } = marked()
    const day = join(dir, `${localDate(FIXED)}.jsonl`)
    writeFileSync(day, '{"v":1,"ts":"2026-11-23T12:00:00.000Z","kind":"start","proc":"9-x","seq":1,"ca' + '\0'.repeat(8))
    const a = createToolAudit({ dir, now: () => FIXED, proc: '2-b' })
    expect(a.start({ src: 'tool', input: {}, cwd: '/w' }).ok).toBe(true)
    const r = verifyAuditFiles([day])
    expect(r.unparsable).toBe(1)
    const pr = r.procs.find(x => x.proc === '2-b')!
    expect(pr).toMatchObject({ records: 2, firstSeq: 1, gapCount: 0 })
  })

  it('a day file deleted after it was written is not recreated by an end or a refused record', () => {
    const { dir } = marked()
    const a = createToolAudit({ dir, now: () => FIXED })
    const s = a.start({ src: 'tool', input: {}, cwd: '/w' })
    if (!s.ok) throw new Error(s.reason)
    const day = join(dir, `${localDate(FIXED)}.jsonl`)
    unlinkSync(day)
    a.end(s.call, { isError: false, ms: 1, output: '' })
    a.refused({ src: 'tool', by: 'executor', cwd: '/w', reason: 'x' })
    expect(existsSync(day)).toBe(false)
    expect(a.probe('dispatch')).toMatch(/^audit-file-shrunk: /)
  })

  it('retention by name as well as age: an old mtime on a young name keeps the file, and a file dated after the clock stops the prune', () => {
    const { dir } = marked()
    const today = localDate(FIXED)
    const put = (name: string, t: Date) => { writeFileSync(join(dir, name), '{}\n'); utimesSync(join(dir, name), t, t) }
    // A file named for a day after the clock: nothing at all is pruned, even a truly old one.
    put('2026-11-01.jsonl', new Date(2026, 9, 1))
    put('2026-12-25.jsonl', new Date(2026, 9, 1))
    expect(createToolAudit({ dir, now: () => FIXED, keepDays: 1 }).open().ok).toBe(true)
    expect(readdirSync(dir)).toContain('2026-11-01.jsonl')
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[tool-audit\] retention skipped: 2026-12-25\.jsonl is dated after the clock/))
    // A modification time 200 days old on files named for today and yesterday: both stay; an old name goes.
    const { dir: d2 } = marked()
    const longAgo = new Date(FIXED.getTime() - 200 * 86_400_000)
    const putIn = (name: string, t: Date) => { writeFileSync(join(d2, name), '{}\n'); utimesSync(join(d2, name), t, t) }
    const yesterday = localDate(new Date(FIXED.getTime() - 86_400_000))
    putIn(`${today}.1.jsonl`, longAgo)
    putIn(`${yesterday}.jsonl`, longAgo)
    putIn('2026-03-01.jsonl', longAgo)
    expect(createToolAudit({ dir: d2, now: () => FIXED, keepDays: 90 }).open().ok).toBe(true)
    const left = readdirSync(d2)
    expect(left).toContain(`${today}.1.jsonl`)
    expect(left).toContain(`${yesterday}.jsonl`)
    expect(left).not.toContain('2026-03-01.jsonl')
  })

  it('harnessAudit refuses a folder inside the sandbox root', () => {
    const r = root()
    const sb = join(r, 'sandbox-root')
    mkdirSync(join(sb, 'audit'), { recursive: true })
    writeFileSync(join(sb, 'audit', AUDIT_MARKER), '')
    const saved = process.env.LOCALCODE_SANDBOX_ROOT
    process.env.LOCALCODE_SANDBOX_ROOT = sb
    try {
      expect(harnessAudit({ dir: join(sb, 'audit'), home: join(r, 'home') }).probe('dispatch')).toMatch(/^audit-dir-in-workspace: /)
    } finally {
      process.env.LOCALCODE_SANDBOX_ROOT = saved
    }
    expect(readdirSync(join(sb, 'audit'))).toEqual([AUDIT_MARKER])
  })

  it('toolAudit refuses a context whose audit folder is inside its sandbox or an extra root', () => {
    const r = root()
    const sbAudit = join(r, 'sb', 'audit')
    mkdirSync(sbAudit, { recursive: true })
    writeFileSync(join(sbAudit, AUDIT_MARKER), '')
    expect(toolAudit(ctxFor(r, sbAudit))!.start({ src: 'tool', input: {}, cwd: '/w' }))
      .toEqual({ ok: false, reason: AUDIT_NOT_WRITTEN('audit-dir-in-workspace') })
    const extra = join(r, 'extra')
    mkdirSync(join(extra, 'audit'), { recursive: true })
    writeFileSync(join(extra, 'audit', AUDIT_MARKER), '')
    const ctx = testContainment({
      missionCwd: join(r, 'mission'),
      sandbox: { root: join(r, 'sb'), home: join(r, 'sb', 'home'), tmp: join(r, 'sb', 'tmp'), scratch: join(r, 'sb', 'scratch') },
      home: join(r, 'home'), extraRoots: [extra],
      folders: { state: join(r, 'state'), models: join(r, 'models'), guard: join(r, 'guard'), audit: join(extra, 'audit') },
    })
    expect(toolAudit(ctx)!.probe('capability')).toMatch(/^audit-dir-in-workspace: /)
    expect(readdirSync(join(extra, 'audit'))).toEqual([AUDIT_MARKER])
    expect(readdirSync(sbAudit)).toEqual([AUDIT_MARKER])
  })
})

// The source union is closed: a new source must be classified as text or withheld on purpose.
const _srcs: AuditSrc[] = ['tool', 'subagent', 'contract', 'best-of-n', 'lsp', 'precheck', 'driver', 'driver-probe', 'driver-marker', 'gate']
void _srcs
