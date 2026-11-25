/**
 * Removing a candidate worktree walks it for links whatever its size (wave 15b, check C4-1).
 *
 * remove() takes every link out as an entry before git or rmSync deletes the worktree (F242). It used
 * the walk with extractPatch's bound (LINK_WALK_LIMIT, 200,000 entries), so a worktree over the bound
 * with no link at all (a candidate that ran an install) was "not removed: the walk did not see
 * everything", left registered and on disk, and every later manager refused it again: the package's
 * "never leave a worktree behind" (F162) broken. The bound is a refusal bound for applying a patch,
 * not for removal. A folder the walk cannot list still keeps the worktree in place, named.
 *
 * The listing of one marked folder is mocked (200,001 extra entries, or a listing error); every other
 * listing, git and the disk are real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'

const marks = vi.hoisted(() => ({ big: '', unlistable: '' }))

vi.mock('../../realPath.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../realPath.js')>()
  return {
    ...real,
    listEntries: (dir: string) => {
      if (marks.unlistable && basename(dir) === marks.unlistable) throw new Error('EACCES: permission denied, scandir')
      const entries = real.listEntries(dir)
      if (marks.big && basename(dir) === marks.big) {
        for (let i = 0; i <= 200_000; i++) entries.push({ name: `f${i}.js`, kind: 'file' as const })
      }
      return entries
    },
  }
})

const { WorktreeManager, LINK_WALK_LIMIT } = await import('../../bestOfN/worktreeManager.js')

const made: string[] = []
afterEach(() => {
  marks.big = ''
  marks.unlistable = ''
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

function repo(): { dir: string; tmpRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-wt-walk-repo-'))
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cynco-wt-walk-root-'))
  made.push(dir, tmpRoot)
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' })
  run('git init')
  run('git config user.email "test@test.com"')
  run('git config user.name "Test"')
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n')
  run('git add hello.txt')
  run('git commit -m "init"')
  return { dir, tmpRoot }
}

function said(fn: () => void): string[] {
  const lines: string[] = []
  const log = console.log
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try { fn() } finally { console.log = log }
  return lines
}

describe('WorktreeManager.remove walks a worktree of any size', () => {
  it(`a worktree with more than LINK_WALK_LIMIT entries and no link is removed from disk and from git`, async () => {
    const { dir, tmpRoot } = repo()
    const m = new WorktreeManager(dir, { tmpRoot })
    const wt = await m.create()
    mkdirSync(join(wt, 'node_modules'))
    writeFileSync(join(wt, 'node_modules', 'index.js'), 'x\n')
    marks.big = 'node_modules'
    const lines = said(() => m.cleanup(wt))
    expect(lines.filter(l => l.includes('is not removed')), lines.join('\n')).toEqual([])
    expect(existsSync(wt)).toBe(false)
    expect(m.registered().some(r => basename(r.path) === basename(wt))).toBe(false)
    expect(LINK_WALK_LIMIT).toBe(200_000)
  }, 60_000)

  it('a worktree holding a folder that cannot be listed is still kept in place, and named', async () => {
    const { dir, tmpRoot } = repo()
    const m = new WorktreeManager(dir, { tmpRoot })
    const wt = await m.create()
    mkdirSync(join(wt, 'locked-away'))
    marks.unlistable = 'locked-away'
    const lines = said(() => m.cleanup(wt))
    expect(lines.some(l => l.includes(`${wt} is not removed`) && l.includes('locked-away could not be listed')), lines.join('\n')).toBe(true)
    expect(existsSync(wt)).toBe(true)
    marks.unlistable = ''
    // The test's own worktree: git removes it now that the folder lists.
    m.cleanup(wt)
    expect(existsSync(wt)).toBe(false)
  }, 60_000)
})
