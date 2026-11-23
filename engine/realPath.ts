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
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

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
