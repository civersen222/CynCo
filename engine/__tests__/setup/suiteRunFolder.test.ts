/**
 * The suite's run folder (setup/suiteRunFolder.ts): made once per run, the temp variables pointed at it,
 * removed after a run with no failure by a walk that never enters a link, kept otherwise with its path said.
 * Everything here happens under a folder of this file's own, removed at the end.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync,
  realpathSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { listEntries } from '../../realPath.js'
import { ownIntegrityLevel } from '../../containment.js'
import setup, { KEEP_DAYS, makeRunFolder, pruneKeptRunFolders, removeRunFolder, runOutcome, RUN_NAME, RUNS_PARENT } from './suiteRunFolder.js'

const ROOT = mkdtempSync(join(tmpdir(), 'cynco-runfolder-test-'))
const links: string[] = []
/** Every link under `d` by the listing (a junction made at low integrity reads as a folder to lstat), never entered. */
function linksUnder(d: string, out: string[] = []): string[] {
  for (const e of listEntries(d)) {
    if (e.kind === 'link') out.push(join(d, e.name))
    else if (e.kind === 'dir') linksUnder(join(d, e.name), out)
  }
  return out
}
afterAll(() => {
  // Links first, as entries, so that the recursive removal of this file's own folder meets none: the ones the
  // cases registered, then any the listing still shows (a case that failed half way).
  /** Is `l` still an entry of its parent (existsSync follows a link, so it cannot answer for a dangling one)? */
  const entryThere = (l: string): boolean => {
    try { return readdirSync(dirname(l)).includes(basename(l)) } catch { return false }
  }
  for (const l of [...links, ...linksUnder(ROOT)]) {
    if (!entryThere(l)) continue
    try { rmdirSync(l) } catch (e) { console.error(`[test] the link ${l} could not be removed as an entry: ${(e as Error).message}`) }
  }
  const left = linksUnder(ROOT)
  if (left.length > 0) throw new Error(`links are left under ${ROOT}, so it is not removed: ${left.join(', ')}`)
  rmSync(ROOT, { recursive: true, force: true })
})

const ok = { ok: () => true }
const bad = { ok: () => false }

describe('this run', () => {
  it('runs in the run folder: the worker\'s temp folder and the suite\'s CynCo home are inside cynco-suite-runs/cv-<6 hex>', () => {
    const run = tmpdir()
    console.log(`[test] this run's temp folder: ${run}; CYNCO_HOME ${process.env.CYNCO_HOME}`)
    expect(basename(run)).toMatch(RUN_NAME)
    expect(basename(dirname(run))).toBe(RUNS_PARENT)
    expect(dirname(process.env.CYNCO_HOME!)).toBe(run)
    expect(basename(process.env.CYNCO_HOME!)).toMatch(/^cynco-test-home-/)
  })
})

describe('runOutcome', () => {
  it('passed only when every module is ok, nothing errored outside a test, and the run was not cancelled', () => {
    expect(runOutcome({ cancelling: false, modules: [ok, ok], unhandled: [] })).toBe('passed')
    expect(runOutcome({ cancelling: false, modules: [ok, bad], unhandled: [] })).toBe('failed')
    expect(runOutcome({ cancelling: false, modules: [ok], unhandled: [new Error('x')] })).toBe('failed')
    expect(runOutcome({ cancelling: true, modules: [ok], unhandled: [] })).toBe('interrupted')
    expect(runOutcome({ cancelling: false, modules: [], unhandled: [] })).toBe('unknown')
    expect(runOutcome({ cancelling: false, modules: null, unhandled: [] })).toBe('unknown')
  })
})

describe('makeRunFolder and removeRunFolder', () => {
  it('makes <temp>/cynco-suite-runs/cv-<6 hex>, a new one each time', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const a = makeRunFolder(temp)
    const b = makeRunFolder(temp)
    expect(basename(dirname(a))).toBe(RUNS_PARENT)
    expect(basename(a)).toMatch(RUN_NAME)
    expect(a).not.toBe(b)
    expect(readdirSync(dirname(a)).sort()).toEqual([basename(a), basename(b)].sort())
  })

  it('removes files, folders and a read-only file, and removes a junction as an entry without entering it', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const outside = join(ROOT, `outside-${basename(temp)}`)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'the owner\'s file')
    const run = makeRunFolder(temp)
    mkdirSync(join(run, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(run, 'a', 'b', 'c', 'f.txt'), 'x')
    writeFileSync(join(run, 'top.txt'), 'y')
    const ro = join(run, 'a', 'readonly.pack')
    writeFileSync(ro, 'z')
    chmodSync(ro, 0o444)
    const junction = join(run, 'a', 'to-outside')
    symlinkSync(outside, junction, 'junction')
    links.push(junction)
    expect(removeRunFolder(run, dirname(run))).toEqual([])
    expect(existsSync(run)).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    expect(existsSync(dirname(run)), 'the parent stays').toBe(true)
  })

  it('refuses a folder that is not a run folder, not directly in the parent, or itself a link, and removes nothing', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const parent = dirname(makeRunFolder(temp))
    const other = join(parent, 'not-a-run')
    mkdirSync(other)
    writeFileSync(join(other, 'x.txt'), 'x')
    expect(removeRunFolder(other, parent)[0]).toMatch(/not a run folder name/)
    const deeper = join(parent, 'not-a-run', 'cv-abcdef')
    mkdirSync(deeper)
    expect(removeRunFolder(deeper, parent)[0]).toMatch(/not directly in/)
    const target = join(ROOT, `target-${basename(temp)}`)
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'k')
    const linked = join(parent, 'cv-123456')
    symlinkSync(target, linked, 'junction')
    links.push(linked)
    expect(removeRunFolder(linked, parent)[0]).toMatch(/is a link; nothing was removed/)
    expect(existsSync(join(other, 'x.txt'))).toBe(true)
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })

  // P5-C2 (wave 15): the junction above is made by this (medium) process, which lstat reads as a link, so that
  // case cannot tell the listing walk from a walk that asks lstat. This one is made by a LOW-integrity process:
  // Windows stores it with the substitute name \??\Global\..., for which lstat answers with the target's stat
  // (engine/realPath.ts listEntries). The walk must still remove it as an entry and leave the target's file.
  const SYS = (n: string) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', n)
  const run = (file: string, args: string[], o: { verbatim?: boolean; cwd?: string } = {}) => {
    const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: o.verbatim, cwd: o.cwd, timeout: 60_000 })
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? ` (${r.error.message})` : ''}` }
  }
  const icaclsOk = (args: string[]) => {
    const r = run(SYS('icacls.exe'), args)
    if (r.code !== 0) throw new Error(`icacls ${args.join(' ')} failed (${r.code}): ${r.out.trim().slice(0, 300)}`)
  }
  // B5-8 (wave 15c): a process that is already low integrity cannot set a label (icacls /setintegritylevel is
  // refused), and without USERNAME there is no user to grant the low copy to: the case is skipped by name
  // there, not failed, since nothing is wrong with the walk.
  const cannotMakeLow = process.platform !== 'win32' || ownIntegrityLevel() === 'low' || !process.env.USERNAME
  it.skipIf(cannotMakeLow)('Windows: removes a junction a LOW-integrity process made as an entry, and leaves the file it points at (skipped off Windows, in a process already low integrity, or with USERNAME unset)', () => {
    const user = process.env.USERNAME
    expect(user, 'USERNAME names the user the low copy of cmd.exe is granted to').toBeTruthy()
    const temp = mkdtempSync(join(ROOT, 't-'))
    // A copy of cmd.exe labelled low starts at low integrity (the real-denials file does this with powershell.exe).
    const lowCmd = join(temp, 'lowcmd.exe')
    copyFileSync(SYS('cmd.exe'), lowCmd)
    icaclsOk([lowCmd, '/grant', `${user}:(F)`])
    icaclsOk([lowCmd, '/setintegritylevel', 'low'])
    const who = run(lowCmd, ['/d', '/c', `${SYS('whoami.exe')} /groups`])
    expect(who.out, 'the copy of cmd.exe runs at low integrity (S-1-16-4096)').toMatch(/S-1-16-4096/)
    const runDir = makeRunFolder(temp)
    // The target must be writable at low too: the kernel refuses a low process a junction to a medium folder.
    const outside = join(temp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'the file the junction points at')
    for (const d of [runDir, outside]) {
      icaclsOk([d, '/grant', `${user}:(OI)(CI)(F)`])
      icaclsOk([d, '/setintegritylevel', '(OI)(CI)low'])
    }
    const junction = join(runDir, 'a', 'to-outside')
    links.push(junction)
    const made = run(lowCmd, [`/d /c mkdir a && mklink /J "${junction}" "${outside}"`], { verbatim: true, cwd: runDir })
    expect(made.code, `the low cmd made the junction: ${made.out.trim()}`).toBe(0)
    // The shape of the F242 hazard: the listing calls it a link; what lstat says is printed, not asserted.
    expect(listEntries(join(runDir, 'a'))).toEqual([{ name: 'to-outside', kind: 'link' }])
    console.log(`[test] lstat of the low-made junction: isSymbolicLink ${lstatSync(junction).isSymbolicLink()}, isDirectory ${lstatSync(junction).isDirectory()}`)
    expect(removeRunFolder(runDir, dirname(runDir))).toEqual([])
    expect(existsSync(runDir)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the file the junction points at')
  })

  // B5-3 (wave 15c): the listing calls every junction above a link, so the walk's second line, the own-path
  // check before it enters what a listing called a folder, was never reached. Here the listing is told to call
  // a junction a folder (a reparse kind a listing does not flag, or an entry swapped after it was listed): the
  // walk must name it, enter nothing beneath it, and keep the run folder.
  it('an entry the listing calls a folder but that resolves elsewhere is named, not entered, and the run folder is kept', () => {
    const temp = mkdtempSync(join(ROOT, 't-'))
    const outside = join(temp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'the owner\'s file')
    const runDir = makeRunFolder(temp)
    writeFileSync(join(runDir, 'top.txt'), 'y')
    const junction = join(runDir, 'to-outside')
    symlinkSync(outside, junction, 'junction')
    links.push(junction)
    const lying = (d: string) => listEntries(d).map(e => (e.name === 'to-outside' ? { ...e, kind: 'dir' as const } : e))
    const failed = removeRunFolder(runDir, dirname(runDir), lying)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatch(/to-outside: resolves to .*outside, not to .*to-outside; not entered$/)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the owner\'s file')
    expect(existsSync(runDir), 'a walk that left something keeps the run folder').toBe(true)
    expect(existsSync(join(runDir, 'top.txt')), 'the rest of the walk went on').toBe(false)
  })

  // P5-C2 (wave 15): removeRunFolder deletes only through its own walk. noAsyncRm.test.ts reads production
  // files only and the async forms only, so this file is pinned here: no rmSync, no fs.rm, no rimraf in its code.
  it('suiteRunFolder.ts calls no recursive remove: no rmSync, no rm, no rimraf in its code', () => {
    const text = readFileSync(new URL('./suiteRunFolder.ts', import.meta.url), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).toContain('rmdirSync(')
    expect(code).not.toMatch(/\brmSync\b/)
    expect(code).not.toMatch(/\brm\s*\(|[{,]\s*rm\s*[,}]|\.rm\b/)
    expect(code).not.toMatch(/rimraf|fs\/promises|\bpromises\b/)
    // B5-3 (wave 15c): nor a shell delete (cmd's rd, PowerShell's Remove-Item) or any child process at all.
    expect(code).not.toMatch(/spawn|exec|\brd\b|Remove-Item/)
  })
})

// Wave 19: a failing run keeps its folder and nothing pruned them (140 were kept on 2026-11-24). The global
// setup removes its OWN kept run folders older than seven days: `cv-<6 hex>` folders of its own
// cynco-suite-runs folder and nothing else, by the walk that never follows a link, and says how many; a folder
// it cannot remove is named and left. Every case runs against a temp parent of this file's own, never the real
// one, and moves the clock instead of the folders (a folder's creation time cannot be set back).
const DAY = 24 * 60 * 60 * 1000
describe('pruneKeptRunFolders', () => {
  /** A temp parent with the current run folder in it, and an outside folder a link must never reach. */
  const parentWithRun = () => {
    const temp = mkdtempSync(join(ROOT, 'p-'))
    const current = makeRunFolder(temp)
    const outside = join(temp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'the owner\'s file')
    return { temp, parent: dirname(current), current, outside }
  }
  const entries = (d: string) => listEntries(d).map(e => `${e.name}:${e.kind}`).sort()

  it(`keeps seven days: KEEP_DAYS is ${7}`, () => {
    expect(KEEP_DAYS).toBe(7)
  })

  it('removes its own kept run folders older than seven days by the no-follow walk, and nothing else', () => {
    const { parent, current, outside } = parentWithRun()
    // Old: a kept run with a tree, a read-only file and a junction to the outside folder in it.
    const old = join(parent, 'cv-0000a1')
    mkdirSync(join(old, 'x', 'y'), { recursive: true })
    writeFileSync(join(old, 'x', 'y', 'f.txt'), 'x')
    writeFileSync(join(old, 'x', 'pack.idx'), 'z')
    chmodSync(join(old, 'x', 'pack.idx'), 0o444)
    const inner = join(old, 'x', 'to-outside')
    symlinkSync(outside, inner, 'junction')
    links.push(inner)
    // Young: last written two days from now, so at eight days from now it is six days old.
    const young = join(parent, 'cv-0000b2')
    mkdirSync(young)
    const twoDays = new Date(Date.now() + 2 * DAY)
    utimesSync(young, twoDays, twoDays)
    // Not this suite's run folders: a name that is not cv-<6 hex>, a file with a run folder's name, a junction with one.
    mkdirSync(join(parent, 'cv-zzzzzz'))
    mkdirSync(join(parent, 'keep-me'))
    writeFileSync(join(parent, 'cv-0000c3'), 'a file')
    const topLink = join(parent, 'cv-0000d4')
    symlinkSync(outside, topLink, 'junction')
    links.push(topLink)
    const before = entries(parent)
    const r = pruneKeptRunFolders(parent, current, Date.now() + 8 * DAY)
    expect(r).toEqual({ removed: 1, left: [] })
    expect(entries(parent)).toEqual(before.filter(e => e !== 'cv-0000a1:dir'))
    expect(existsSync(current), 'the current run folder is never pruned, however old the clock says it is').toBe(true)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the owner\'s file')
    expect(readdirSync(outside)).toEqual(['keep.txt'])
  })

  it('a folder younger than seven days is kept, by its creation time and its last write alike', () => {
    const { parent, current } = parentWithRun()
    const made = join(parent, 'cv-0000e5')
    mkdirSync(made)
    // Last written thirty days ago, but made now: six days from now it is six days old by its creation time.
    const longAgo = new Date(Date.now() - 30 * DAY)
    utimesSync(made, longAgo, longAgo)
    if (statSync(made).birthtimeMs > 0) {
      expect(pruneKeptRunFolders(parent, current, Date.now() + 6 * DAY)).toEqual({ removed: 0, left: [] })
      expect(existsSync(made)).toBe(true)
    } else {
      // A file system that keeps no creation time: the last write is all there is to go by.
      console.log('[test] this file system reports no creation time; the six-day half is not asked')
    }
    expect(pruneKeptRunFolders(parent, current, Date.now() + 8 * DAY)).toEqual({ removed: 1, left: [] })
    expect(existsSync(made)).toBe(false)
  })

  it('a kept run folder it cannot remove is named and left, with what it left in it', () => {
    const { parent, current, outside } = parentWithRun()
    const old = join(parent, 'cv-0000f6')
    mkdirSync(old)
    writeFileSync(join(old, 'top.txt'), 'y')
    const j = join(old, 'to-outside')
    symlinkSync(outside, j, 'junction')
    links.push(j)
    // A listing that calls the junction a folder: the walk names it, enters nothing beneath it, keeps the folder.
    const lying = (d: string) => listEntries(d).map(e => (e.name === 'to-outside' ? { ...e, kind: 'dir' as const } : e))
    const r = pruneKeptRunFolders(parent, current, Date.now() + 8 * DAY, lying)
    expect(r.removed).toBe(0)
    expect(r.left).toHaveLength(1)
    expect(r.left[0]).toMatch(/cv-0000f6 \(.*to-outside: resolves to .*outside, not to .*to-outside; not entered\)$/)
    expect(existsSync(old)).toBe(true)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the owner\'s file')
  })

  it('a folder another run removed while this one looked at it is neither counted nor named', () => {
    const { parent, current } = parentWithRun()
    const old = join(parent, 'cv-0000f7')
    mkdirSync(old)
    // The parent's first listing shows the folder; before the next one another run's prune really takes it.
    // (Wave 19b, check G19-6: the folder is now removed for real here. A listing that merely stops showing a
    // folder still on disk is not "another run removed it": that case is the next one, and is named.)
    let first = true
    const racing = (d: string) => {
      if (d.toLowerCase() !== realpathSync.native(parent).toLowerCase()) return listEntries(d)
      if (first) { first = false; return listEntries(d) }
      if (existsSync(old)) rmdirSync(old)
      return listEntries(d)
    }
    expect(pruneKeptRunFolders(parent, current, Date.now() + 8 * DAY, racing)).toEqual({ removed: 0, left: [] })
    expect(existsSync(old)).toBe(false)
  })

  // Check G19-6 (wave 19b): after a failed removal, a parent listing that no longer shows the folder (or that
  // throws) is not proof that it is gone. Only a folder lstat no longer finds is skipped unsaid; one still on
  // disk is named, so a stuck folder is never under-reported.
  it('a folder its parent\'s listing stops showing but that is still there is named, not dropped', () => {
    const { parent, current } = parentWithRun()
    const old = join(parent, 'cv-0000f8')
    mkdirSync(old)
    let first = true
    const forgetful = (d: string) => {
      if (d.toLowerCase() !== realpathSync.native(parent).toLowerCase()) return listEntries(d)
      if (first) { first = false; return listEntries(d) }
      return listEntries(d).filter(e => e.name !== 'cv-0000f8')
    }
    const r = pruneKeptRunFolders(parent, current, Date.now() + 8 * DAY, forgetful)
    expect(r.removed).toBe(0)
    expect(r.left).toHaveLength(1)
    expect(r.left[0]).toMatch(/cv-0000f8 \(.*cv-0000f8: not in its parent's listing; nothing was removed\)$/)
    expect(existsSync(old)).toBe(true)
    let listed = 0
    const throwing = (d: string) => {
      if (d.toLowerCase() !== realpathSync.native(parent).toLowerCase()) return listEntries(d)
      if (listed++ === 0) return listEntries(d)
      throw Object.assign(new Error('EIO: the listing failed'), { code: 'EIO' })
    }
    const t = pruneKeptRunFolders(parent, current, Date.now() + 8 * DAY, throwing)
    expect(t.left).toHaveLength(1)
    expect(t.left[0]).toMatch(/cv-0000f8 \(/)
  })

  it('a parent that cannot be listed removes nothing and says so', () => {
    const { parent, current } = parentWithRun()
    const r = pruneKeptRunFolders(join(parent, 'not-there'), current, Date.now() + 8 * DAY)
    expect(r.removed).toBe(0)
    expect(r.left).toHaveLength(1)
    expect(r.left[0]).toMatch(/not-there: could not be listed/)
  })
})

describe('the global setup and its teardown', () => {
  const project = (modules: Array<{ ok(): boolean }>, cancelling = false) => ({ vitest: { isCancelling: cancelling, state: { getTestModules: () => modules, getUnhandledErrors: () => [] } } })
  const withTemp = <T>(fn: () => T): T => {
    const keep = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
    const temp = mkdtempSync(join(ROOT, 's-'))
    process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp
    try { return fn() } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }
  const quiet = <T>(fn: () => T): { r: T; said: string[] } => {
    const said: string[] = []
    const oe = console.error
    console.error = (m: unknown) => { said.push(String(m)) }
    try { return { r: fn(), said } } finally { console.error = oe }
  }

  it('points TEMP, TMP and TMPDIR at the run folder; a passing run removes it and puts the variables back', () => {
    withTemp(() => {
      const before = process.env.TEMP
      const teardown = setup(project([ok]))
      const run = process.env.TEMP!
      expect(basename(run)).toMatch(RUN_NAME)
      expect(process.env.TMP).toBe(run)
      expect(process.env.TMPDIR).toBe(run)
      expect(tmpdir()).toBe(run)
      writeFileSync(join(mkdtempSync(join(tmpdir(), 'x-')), 'f.txt'), 'made by a test')
      const { said } = quiet(() => teardown())
      expect(said).toEqual([])
      expect(existsSync(run)).toBe(false)
      expect(process.env.TEMP).toBe(before)
    })
  })

  // P5-C8 (wave 15): the teardown wrote one value back to all three, so a TMPDIR that was unset came back set
  // and a TMP that differed from TEMP came back as TEMP. Each is put back as it was, an unset one unset.
  it('puts TEMP, TMP and TMPDIR back each as it was, and leaves one that was unset unset', () => {
    const keep = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
    const temp = mkdtempSync(join(ROOT, 'e-'))
    const tmpOther = mkdtempSync(join(ROOT, 'f-'))
    try {
      // os.tmpdir() reads TMPDIR first where it is set (POSIX), TEMP then TMP on Windows: TMPDIR unset here.
      process.env.TEMP = temp; process.env.TMP = tmpOther; delete process.env.TMPDIR
      const t1 = setup(project([ok]))
      expect(process.env.TMPDIR).toBe(process.env.TEMP)
      quiet(() => t1())
      expect(process.env.TEMP).toBe(temp)
      expect(process.env.TMP).toBe(tmpOther)
      expect('TMPDIR' in process.env).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('before the run, removes its own kept run folders older than seven days and says how many', () => {
    withTemp(() => {
      const parent = join(realpathSync.native(tmpdir()), RUNS_PARENT)
      const old = join(parent, 'cv-0000a7')
      mkdirSync(old, { recursive: true })
      writeFileSync(join(old, 'f.txt'), 'x')
      const { r: teardown, said } = quiet(() => setup(project([ok]), { now: () => Date.now() + 8 * DAY }))
      expect(said).toEqual([`[suite] removed 1 kept run folder older than 7 days from ${parent}`])
      expect(existsSync(old)).toBe(false)
      const run = process.env.TEMP!
      expect(existsSync(run), 'this run\'s own folder is made and kept for the run').toBe(true)
      expect(quiet(() => teardown()).said).toEqual([])
    })
  })

  it('a kept run folder younger than seven days is left, and nothing is said', () => {
    withTemp(() => {
      const parent = join(realpathSync.native(tmpdir()), RUNS_PARENT)
      const kept = join(parent, 'cv-0000a8')
      mkdirSync(kept, { recursive: true })
      const { r: teardown, said } = quiet(() => setup(project([ok])))
      expect(said).toEqual([])
      expect(existsSync(kept)).toBe(true)
      quiet(() => teardown())
    })
  })

  it('a run whose outcome is not known (no test module) keeps the folder and says so', () => {
    withTemp(() => {
      const teardown = setup(project([]))
      const run = process.env.TEMP!
      const { said } = quiet(() => teardown())
      expect(said).toEqual([`[suite] the run's outcome is not known: its temp folder is kept: ${run}`])
      expect(existsSync(run)).toBe(true)
    })
  })

  it('a failed run and an interrupted run keep the folder and print its path', () => {
    withTemp(() => {
      for (const [p, word] of [[project([bad]), 'the run failed'], [project([ok], true), 'the run interrupted']] as const) {
        const teardown = setup(p)
        const run = process.env.TEMP!
        const { said } = quiet(() => teardown())
        expect(said).toEqual([`[suite] ${word}: its temp folder is kept: ${run}`])
        expect(existsSync(run)).toBe(true)
      }
    })
  })
})
