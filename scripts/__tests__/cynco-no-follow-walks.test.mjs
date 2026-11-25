/**
 * One table of cases, run against both listing-based walks that remove a tree without ever following a link:
 * the suite's run folder (engine/__tests__/setup/suiteRunFolder.ts `removeRunFolder`) and calibration's BASE
 * folder (scripts/cynco-campaign-calibrate.mjs `removeNoFollow`). A contained process (a grader at low
 * integrity, a test) wrote what both remove, so a fix to one is a fix to both (wave 19, C5-1 and C5-2):
 *
 * - C5-1: the walk's first look (is the folder itself a link?) asked engine/realPath.ts `isLinkEntry`, which
 *   lists the parent itself, so the `list` seam could not reach it, and the branch for a folder its parent's
 *   listing does not show was never run by a test. Both walks now take that look through `list`.
 * - C5-2: a folder without its owner's write permission. On this PC (Windows, Node 24.14.1 and Bun 1.3.13)
 *   rmdir of a folder with the read-only attribute is NOT refused, and a file inside one can be removed
 *   (measured 2026-11-25: C:\cynco-recovery-2026-11-22\phase3\w19\scratch\g\out\ro-measure-*.txt). On POSIX
 *   (the CI job) a folder without write permission refuses the removal of what is in it, so both walks give a
 *   folder they entered at its own path its owner's permissions back before they walk it.
 *
 * Every case builds its tree under a folder of this file's own, removed at the end.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { listEntries } from '../../engine/realPath.js'
import { makeRunFolder, removeRunFolder } from '../../engine/__tests__/setup/suiteRunFolder.js'
import { removeNoFollow } from '../cynco-campaign-calibrate.mjs'

const ROOT = mkdtempSync(join(tmpdir(), 'cynco-nofollow-walks-'))
const links = []
afterAll(() => {
  // Every folder under ROOT is given its write permission back and every link is removed as an entry (a case
  // that failed half way may leave either), never entering a link; then this file's own folder goes.
  const visit = (d) => {
    try { chmodSync(d, 0o777) } catch (e) { console.error(`[test] ${d} could not be made writable: ${e.message}`) }
    for (const e of listEntries(d)) {
      const p = join(d, e.name)
      if (e.kind === 'link') links.push(p)
      else if (e.kind === 'dir') visit(p)
    }
  }
  visit(ROOT)
  /** Is `l` still an entry of its parent (a walk that passed removed it with its folder)? existsSync follows a link. */
  const entryThere = (l) => { try { return readdirSync(dirname(l)).includes(basename(l)) } catch { return false } }
  for (const l of links) {
    if (!entryThere(l)) continue
    try { rmdirSync(l) } catch (e) { console.error(`[test] the link ${l} could not be removed as an entry: ${e.message}`) }
  }
  const left = []
  const linksUnder = (d) => { for (const e of listEntries(d)) { if (e.kind === 'link') left.push(join(d, e.name)); else if (e.kind === 'dir') linksUnder(join(d, e.name)) } }
  linksUnder(ROOT)
  if (left.length > 0) throw new Error(`links are left under ${ROOT}, so it is not removed: ${left.join(', ')}`)
  rmSync(ROOT, { recursive: true, force: true })
})

/** Both walks, each answering with the list of what it would not or could not remove (empty: the folder is gone). */
const WALKS = [
  { name: 'removeRunFolder (the suite\'s run folder)', key: 'run', remove: (dir, list) => removeRunFolder(dir, dirname(dir), list) },
  {
    name: 'removeNoFollow (calibration\'s BASE folder)', key: 'base',
    remove: (dir, list) => { try { list ? removeNoFollow(dir, list) : removeNoFollow(dir); return [] } catch (e) { return [e.message] } },
  },
]

/**
 * A fresh tree: `<t>/cynco-suite-runs/cv-<6 hex>` (a name both walks take), and `<t>/outside/keep.txt`, the file
 * a link must never reach. `build` fills the folder; it returns a listing to hand the walk, or nothing.
 */
const fresh = () => {
  const t = mkdtempSync(join(ROOT, 't-'))
  const outside = join(t, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep.txt'), 'the owner\'s file')
  const dir = makeRunFolder(t)
  return { t, dir, outside }
}

const CASES = [
  {
    what: 'a nested tree and a read-only file are removed',
    build: ({ dir }) => {
      mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(dir, 'a', 'b', 'c', 'f.txt'), 'x')
      writeFileSync(join(dir, 'a', 'pack.idx'), 'z')
      chmodSync(join(dir, 'a', 'pack.idx'), 0o444)
    },
    gone: true,
  },
  {
    what: 'a read-only folder holding a file and a read-only folder inside it are removed (C5-2)',
    build: ({ dir }) => {
      const ro = join(dir, 'a', 'ro')
      mkdirSync(join(ro, 'inner'), { recursive: true })
      writeFileSync(join(ro, 'f.txt'), 'x')
      writeFileSync(join(ro, 'inner', 'g.txt'), 'y')
      chmodSync(join(ro, 'inner'), 0o555)
      chmodSync(ro, 0o555)
    },
    gone: true,
  },
  {
    what: 'the walk\'s own folder read-only is removed (C5-2)',
    build: ({ dir }) => {
      writeFileSync(join(dir, 'top.txt'), 'y')
      chmodSync(dir, 0o555)
    },
    gone: true,
  },
  {
    what: 'a junction to an outside folder is removed as an entry, and the file it points at stays',
    build: ({ dir, outside }) => {
      mkdirSync(join(dir, 'a'))
      const j = join(dir, 'a', 'to-outside')
      symlinkSync(outside, j, 'junction')
      links.push(j)
    },
    gone: true,
  },
  {
    what: 'an entry the listing calls a folder but that resolves elsewhere is named and not entered, and the folder is kept',
    build: ({ dir, outside }) => {
      const j = join(dir, 'to-outside')
      symlinkSync(outside, j, 'junction')
      links.push(j)
      return (d) => listEntries(d).map(e => (e.name === 'to-outside' ? { ...e, kind: 'dir' } : e))
    },
    kept: {
      run: /to-outside: resolves to .*outside, not to .*to-outside; not entered$/,
      base: /to-outside resolves to .*outside, not to .*to-outside; it was not entered and nothing beneath it was removed$/,
    },
    still: (dir) => [join(dir, 'to-outside')],
  },
  {
    // On Windows the runtime removes a read-only folder by itself (the rows above pass either way there), so this
    // row is what shows, on every platform, that the walk gave a folder it entered its write permission back.
    what: 'a read-only folder the walk entered has its write permission back, even where the walk then stops (C5-2)',
    build: ({ dir, outside }) => {
      const ro = join(dir, 'ro')
      mkdirSync(ro)
      const j = join(ro, 'to-outside')
      symlinkSync(outside, j, 'junction')
      links.push(j)
      chmodSync(ro, 0o555)
      return (d) => listEntries(d).map(e => (e.name === 'to-outside' ? { ...e, kind: 'dir' } : e))
    },
    kept: {
      run: /to-outside: resolves to .*outside, not to .*to-outside; not entered$/,
      base: /to-outside resolves to .*outside, not to .*to-outside; it was not entered and nothing beneath it was removed$/,
    },
    still: (dir) => [join(dir, 'ro', 'to-outside')],
    after: (dir) => expect(statSync(join(dir, 'ro')).mode & 0o200, 'the entered folder is writable by its owner').not.toBe(0),
  },
  {
    what: 'a folder its parent\'s listing does not show is refused by name, and nothing in it is removed (C5-1)',
    build: ({ dir }) => {
      writeFileSync(join(dir, 'inside.txt'), 'i')
      const hidden = basename(dir).toLowerCase()
      return (d) => listEntries(d).filter(e => e.name.toLowerCase() !== hidden)
    },
    kept: {
      run: /: not in its parent's listing; nothing was removed$/,
      base: / is not in the listing of .*, so whether it is a link is not known; nothing was removed$/,
    },
    still: (dir) => [join(dir, 'inside.txt')],
  },
  {
    // Check G19-5 (wave 19b): the first look's other null, a parent that cannot be listed at all. It is refused
    // the same way as a name the listing does not show; read as "not a link", the walk would go on in.
    what: 'a folder whose parent cannot be listed is refused by name, and nothing in it is removed (C5-1)',
    build: ({ dir }) => {
      writeFileSync(join(dir, 'inside.txt'), 'i')
      const parent = dirname(dir).toLowerCase()
      return (d) => {
        if (d.toLowerCase() === parent) throw Object.assign(new Error(`EIO: the listing of ${d} failed`), { code: 'EIO' })
        return listEntries(d)
      }
    },
    kept: {
      run: /: not in its parent's listing; nothing was removed$/,
      base: / is not in the listing of .*, so whether it is a link is not known; nothing was removed$/,
    },
    still: (dir) => [join(dir, 'inside.txt')],
  },
]

describe.each(WALKS)('$name', (walk) => {
  it.each(CASES)('$what', (c) => {
    const tree = fresh()
    const list = c.build(tree) ?? undefined
    const failed = walk.remove(tree.dir, list)
    expect(readFileSync(join(tree.outside, 'keep.txt'), 'utf8'), 'the file outside is never reached').toBe('the owner\'s file')
    expect(existsSync(dirname(tree.dir)), 'the parent stays').toBe(true)
    if (c.gone) {
      expect(failed).toEqual([])
      expect(existsSync(tree.dir)).toBe(false)
    } else {
      expect(failed.length).toBeGreaterThanOrEqual(1)
      expect(failed[0]).toMatch(c.kept[walk.key])
      expect(existsSync(tree.dir), 'a walk that refused keeps the folder').toBe(true)
      for (const p of c.still(tree.dir)) expect(existsSync(p) || listEntries(dirname(p)).some(e => e.name === basename(p)), `${p} is still there`).toBe(true)
    }
    c.after?.(tree.dir)
  })
})

// Check G19-5 (wave 19b): a POSIX folder that keeps its write bit but lacks its read bit (0o300) cannot be
// listed, so a walk that restored only the write bit would stop there. Skipped on Windows, where a folder has
// no read bit to take away (only the read-only attribute); it runs on the Linux CI job.
describe.each(WALKS)('$name, POSIX permissions', (walk) => {
  it.skipIf(process.platform === 'win32')('a folder with write but no read permission (0o300) holding a file is removed (skipped on Windows)', () => {
    const tree = fresh()
    const wx = join(tree.dir, 'a', 'wx')
    mkdirSync(wx, { recursive: true })
    writeFileSync(join(wx, 'f.txt'), 'x')
    chmodSync(wx, 0o300)
    expect(walk.remove(tree.dir, undefined)).toEqual([])
    expect(existsSync(tree.dir)).toBe(false)
    expect(readFileSync(join(tree.outside, 'keep.txt'), 'utf8')).toBe('the owner\'s file')
  })
})

describe('the read-only cases are what they say', () => {
  // A chmod that did nothing would make the C5-2 rows pass for the wrong reason: the folder must really be
  // without its owner's write permission (on Windows: the read-only attribute, which stat reports as 0o444).
  it('chmodSync(0o555) takes the owner\'s write permission off a folder on this platform', () => {
    const { dir } = fresh()
    const d = join(dir, 'probe')
    mkdirSync(d)
    chmodSync(d, 0o555)
    expect(statSync(d).mode & 0o200).toBe(0)
    chmodSync(d, 0o777)
  })
})
