/**
 * engine/realPath.ts: where a path really lands on disk.
 *
 * `isInside`, `realPathOf` and `realInside`, moved from engine/projects/layout.ts
 * (which re-exports them) so that a core package can judge a path by its real
 * location without importing the projects package: the containment of
 * unattended runs (engine/containment.ts, F242) compares every folder it is
 * given on real paths. The two log lines keep the `[projects]` prefix they were
 * written with. One addition: `realPathOf(p, { quiet: true })` logs nothing, for
 * a caller that asks about many paths that may not resolve.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** What a folder's own listing says one of its entries is. */
export type EntryKind = 'link' | 'dir' | 'file'

/**
 * The entries of `dir`, each with the kind the directory listing itself gives it. Any reparse point
 * (a symbolic link, a junction, a mount point, a cloud placeholder) is `'link'`, wherever it points
 * and however its target is stored. Throws what `readdirSync` throws.
 *
 * Why not `lstat`: Windows stores a junction made by a low-integrity process with the substitute
 * name `\??\Global\X:\...`. libuv, and so Node and Bun, take only `\??\X:\...` for a link: for the
 * other form `lstatSync` answers with the TARGET's stat (a directory, with the target's dev and
 * ino), `readlinkSync` throws EINVAL and the JS `realpathSync` returns the junction's own path
 * (measured 2026-11-24 under Bun 1.3.13 and Node 24, F242). A walk that asks `lstat` whether an
 * entry is a link therefore ENTERS such a junction. The listing reads the entry's own attribute and
 * reports it as a link; `realpathSync.native` resolves it to its target.
 */
export function listEntries(dir: string): Array<{ name: string; kind: EntryKind }> {
  return readdirSync(dir, { withFileTypes: true }).map(d => ({
    name: d.name,
    kind: d.isSymbolicLink() ? 'link' as const : d.isDirectory() ? 'dir' as const : 'file' as const,
  }))
}

/**
 * Is the entry at `p` a link, by its parent's listing (see `listEntries`)? `null` when that cannot be
 * told: the parent cannot be listed, or lists no such name (a name given in its 8.3 short form is
 * not found either). A caller that must not enter a link treats `null` as "do not enter".
 * A volume root is an entry of nothing: `false`.
 */
export function isLinkEntry(p: string): boolean | null {
  const full = resolve(p)
  const parent = dirname(full)
  if (parent === full) return false
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const name = fold(basename(full))
  let entries: Array<{ name: string; kind: EntryKind }>
  try {
    entries = listEntries(parent)
  } catch (e) {
    void e
    return null
  }
  const hit = entries.find(e => fold(e.name) === name)
  return hit === undefined ? null : hit.kind === 'link'
}

/**
 * Why the folder entry `name` of the folder whose native real path is `parentReal` is not where its
 * path says, or null when it is: `realpathSync.native` of it must be `parentReal` joined with `name`
 * (compared without case on Windows). A walk asks this before it enters an entry its listing called
 * a folder, so that an entry swapped for a link after it was listed, or a reparse kind a listing
 * does not flag, is not entered. Never throws: a path that cannot be resolved is a reason.
 */
export function whyNotAtOwnPath(parentReal: string, name: string): string | null {
  const expected = join(parentReal, name)
  let real: string
  try {
    real = realpathSync.native(expected)
  } catch (e) {
    return `could not be resolved to its real path (${(e as Error).message})`
  }
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  return fold(real) === fold(expected) ? null : `resolves to ${real}, not to ${expected}`
}

/** True when `candidate` resolves to `root` or somewhere beneath it. Case-folded on win32. */
export function isInside(root: string, candidate: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const r = norm(root), c = norm(candidate)
  return c === r || c.startsWith(r + sep)
}

/** `realpathSync.native` (the OS's own resolution, junctions included), else the JS one; null when neither resolves. */
function realOf(p: string, quiet = false): string | null {
  try {
    return realpathSync.native(p)
  } catch (nativeErr) {
    try {
      return realpathSync(p)
    } catch (jsErr) {
      const code = (jsErr as NodeJS.ErrnoException).code
      // ENOENT/ENOTDIR are the expected "not there yet" answers (a Write of a
      // new file); anything else is worth a line.
      if (!quiet && code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[projects] realpath failed for ${p}: ${(nativeErr as Error).message} / ${(jsErr as Error).message}`)
      return null
    }
  }
}

/**
 * Where `p` really lands on disk: the deepest existing ancestor resolved
 * through every symlink and junction, with the not-yet-existing tail appended
 * back. A dangling link counts as existing (`lstat`) and is followed to its
 * target, so a Write through a link whose target does not exist yet is
 * judged by where it would land.
 */
export function realPathOf(p: string, opts?: { quiet?: boolean }): string {
  const quiet = opts?.quiet === true
  let cur = resolve(p)
  const tail: string[] = []
  for (let hops = 0; hops < 64; hops++) {
    const real = realOf(cur, quiet)
    if (real !== null) return tail.length ? join(real, ...tail.reverse()) : real
    let link: string | null = null
    try {
      if (lstatSync(cur).isSymbolicLink()) link = resolve(dirname(cur), readlinkSync(cur))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!quiet && code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[projects] lstat failed for ${cur}: ${(e as Error).message}`)
    }
    if (link !== null) { cur = link; continue }
    const parent = dirname(cur)
    if (parent === cur) return tail.length ? join(cur, ...tail.reverse()) : cur
    tail.push(basename(cur))
    cur = parent
  }
  return resolve(p)
}

/**
 * `isInside` after following links: a symlink or junction inside the project
 * that points outside it is outside (spec §5, "no symlink escapes"). Returns
 * the real path it judged, so a refusal can name where the call would land.
 */
export function realInside(root: string, candidate: string): { inside: boolean; real: string } {
  const real = realPathOf(candidate)
  return { inside: isInside(realPathOf(root), real), real }
}
