/**
 * Wave 19b: can a path through a link whose target cannot be resolved get past the sealed-path, the
 * secret-path or the immutable-path check? These three read a path's real form through
 * `realPathOf` (`engine/realPath.ts`), which never throws; only the path check of a contained run
 * uses `realPathChecked` (`toolPaths.ts`), which refuses such a link by name.
 *
 * Decided by reading, and pinned here: no.
 *   - A link whose target exists resolves (`realpathSync.native`), and the call is judged where it
 *     lands.
 *   - A link whose target is gone and whose stored target Node can read (an ordinary symbolic link
 *     or junction, the only kinds a test can make) is followed by `realPathOf` (`lstat` + `readlink`)
 *     and judged where it WOULD land: the cases below, each refused or answered by its check.
 *   - The one kind `realPathOf` answers with its own path (a junction a low-integrity process made,
 *     stored as `\??\Global\X:\...`; measured 2026-11-24) is a directory junction, and a junction
 *     whose target folder is gone leads nowhere: the system fails every open below it and creates
 *     nothing (the second half of each case shows that for the kinds a test can make; the system
 *     resolves both stored forms the same way). The gate, the token file and a declared brief are
 *     reached only through a folder that exists, and through an existing folder the link resolves.
 *   - What remains is the race every link has (a target made again between the check and the
 *     use), the path check's own "a link made between the check and the write"; in a contained run
 *     the path check (executor step 4c) refuses such a call by name in any case.
 *
 * Linux: the links are directory symbolic links, which `lstat` reads as links and `readlink` reads
 * back, so every case runs there as here; a system that cannot make one skips by the name
 * `CAN_LINK_DIRS`.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTouchesSealed, setTaskSealedPaths } from '../../tools/sealedPaths.js'
import { secretPathOf } from '../../tools/secretPaths.js'
import { immutableTargetOf, setTaskImmutablePaths } from '../../tools/executor.js'

/** A directory link (a junction on Windows) to `target`, which need not exist; false when none can be made. */
function linkDir(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (e) {
    console.log(`[test] no directory link could be made here: ${(e as Error).message}`)
    return false
  }
}
const CAN_LINK_DIRS = (() => {
  const d = mkdtempSync(join(tmpdir(), 'linkprobe-'))
  const ok = linkDir(d, join(d, 'l'))
  if (ok) unlinkSync(join(d, 'l'))
  rmSync(d, { recursive: true, force: true })
  return ok
})()

/** A fresh folder, and its removal: the link first (never followed), then the folder. */
function withRoot(body: (root: string, links: string[]) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'cynco-unresolved-'))
  const links: string[] = []
  try {
    body(root, links)
  } finally {
    for (const l of links) {
      try { unlinkSync(l) } catch (e) { console.log(`[test] link not removed: ${(e as Error).message}`) }
    }
    rmSync(root, { recursive: true, force: true })
  }
}

/** Nothing can be written through `link` while its target folder is gone, and the target is not made. */
function leadsNowhere(link: string, target: string): void {
  expect(() => writeFileSync(join(link, 'probe.txt'), 'x')).toThrow()
  expect(existsSync(target)).toBe(false)
}

describe('a link whose target cannot be resolved does not get past the sealed, secret or immutable check (19b)', () => {
  it.skipIf(!CAN_LINK_DIRS)('sealed: a write through a link to a gone folder of the gates directory is refused', () => {
    withRoot((root, links) => {
      const gates = join(root, 'gates')
      mkdirSync(gates)
      const gate = join(gates, 'verify_w19.py')
      writeFileSync(gate, 'MUTATIONS = []\n')
      const target = join(gates, 'gone')
      const alias = join(root, 'alias')
      expect(linkDir(target, alias)).toBe(true)
      links.push(alias)
      setTaskSealedPaths([gate])
      try {
        // Judged where it would land: inside the sealed gates directory.
        expect(callTouchesSealed('Write', { file_path: join(alias, 'x.py'), content: 'x' }, root)).toBe(true)
        // An ordinary path beside it stays allowed: the refusal is the link's target, not the folder.
        expect(callTouchesSealed('Write', { file_path: join(root, 'x.py'), content: 'x' }, root)).toBe(false)
      } finally {
        setTaskSealedPaths([])
      }
      leadsNowhere(alias, target)
    })
  })

  it.skipIf(!CAN_LINK_DIRS)('secret: a write of the token file through a link to its gone folder is refused', () => {
    withRoot((root, links) => {
      const home = join(root, 'state')
      const alias = join(root, 'alias')
      expect(linkDir(home, alias)).toBe(true)
      links.push(alias)
      const before = process.env.CYNCO_HOME
      process.env.CYNCO_HOME = home
      try {
        expect(secretPathOf('Write', { file_path: join(alias, 'tokens.json'), content: '{}' }, root)?.action).toBe('refuse')
        expect(secretPathOf('Write', { file_path: join(alias, 'notes.txt'), content: 'x' }, root)).toBeNull()
      } finally {
        if (before === undefined) delete process.env.CYNCO_HOME
        else process.env.CYNCO_HOME = before
      }
      leadsNowhere(alias, home)
    })
  })

  it.skipIf(!CAN_LINK_DIRS)('immutable: a write of a declared brief through a link to its gone folder is refused', () => {
    withRoot((root, links) => {
      const briefs = join(root, 'briefs')
      const brief = join(briefs, 'brief.md')
      const alias = join(root, 'alias')
      expect(linkDir(briefs, alias)).toBe(true)
      links.push(alias)
      setTaskImmutablePaths([brief])
      try {
        expect(immutableTargetOf('Write', { file_path: join(alias, 'brief.md'), content: 'x' }, root)).toBe(brief)
        expect(immutableTargetOf('Write', { file_path: join(alias, 'other.md'), content: 'x' }, root)).toBeNull()
      } finally {
        setTaskImmutablePaths([])
      }
      leadsNowhere(alias, briefs)
    })
  })
})
