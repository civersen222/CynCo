/**
 * extractPatch walks the candidate's worktree before git does (wave 15c, check B4-5).
 *
 * Wave 15b asked `git ls-files --others --ignored --exclude-standard --directory` what git ignores
 * before the link walk, so the junctions an install makes under an ignored node_modules would not
 * refuse an honest candidate. But that listing walks the work tree itself, and git takes a junction
 * for a folder (F6): a candidate's junction that is not ignored, leading to a drive root or the
 * profile, was walked by git for up to a minute before the walk that refuses it ran, synchronously
 * on the event loop the dashboard and the phone are served from (F225), and the cap (execSync's
 * timeout on a command string) ended the shell, not git. Now the walk goes first, by the folders'
 * own listings and never into a link, one level at a time; git is asked only `check-ignore` about
 * the folders and links of that level (it reads ignore rules, it walks nothing) and `ls-files`
 * about the index. A folder is skipped only when git ignores it and the index holds nothing under
 * it: `git add -A` still stages a tracked file inside an ignored folder.
 *
 * The git calls are recorded by wrapping child_process (each still runs for real).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const calls = vi.hoisted(() => [] as string[])
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  return {
    ...real,
    execSync: ((cmd: string, o?: object) => { calls.push(String(cmd)); return real.execSync(cmd, o as never) }) as typeof real.execSync,
    execFileSync: ((file: string, args?: readonly string[], o?: { input?: unknown }) => {
      calls.push([file.split(/[\\/]/).pop(), ...(args ?? [])].join(' ') + (o?.input !== undefined ? ` <stdin ${String(o.input).split('\0').filter(Boolean).join('|')}>` : ''))
      return real.execFileSync(file, args as string[], o as never)
    }) as typeof real.execFileSync,
  }
})

const { extractPatch } = await import('../../bestOfN/patchExtractor.js')

const made: string[] = []
const links: string[] = []
afterEach(() => {
  calls.splice(0)
  vi.restoreAllMocks()
  // Junctions are removed as entries first, so the folder removal cannot reach through one.
  for (const l of links.splice(0)) { try { rmdirSync(l) } catch { /* gone with its test */ } }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

function repo(ignore?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-patch-walk-'))
  made.push(dir)
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' })
  run('git init -q')
  run('git config user.email "t@t"')
  run('git config user.name "T"')
  writeFileSync(join(dir, 'hello.txt'), 'hello\n')
  if (ignore !== undefined) writeFileSync(join(dir, '.gitignore'), ignore)
  run('git add -A')
  run('git commit -q -m init')
  calls.splice(0)
  return dir
}

/** A folder of `n` folders of 100 files each, outside the worktree. */
function bigOutside(n: number): string {
  const d = mkdtempSync(join(tmpdir(), 'cynco-patch-walk-big-'))
  made.push(d)
  for (let i = 0; i < n; i++) {
    mkdirSync(join(d, `d${i}`))
    for (let j = 0; j < 100; j++) writeFileSync(join(d, `d${i}`, `f${j}.txt`), '')
  }
  return d
}

function junction(target: string, at: string): void {
  symlinkSync(target, at, 'junction')
  links.push(at)
}

const gitCalls = () => calls.filter(c => /^git(\.exe)? /.test(c) || c.startsWith('git '))

describe('extractPatch: git never walks through a link the candidate made', () => {
  it('a junction to a large folder that git does not ignore is refused without git listing the work tree', () => {
    const r = repo('node_modules/\n')
    junction(bigOutside(40), join(r, 'lead-out'))
    writeFileSync(join(r, 'hello.txt'), 'changed\n')
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')) })
    const t0 = Date.now()
    const patch = extractPatch(r, 'candidate 2')
    const ms = Date.now() - t0
    expect(patch).toBe('')
    expect(said.some(l => l.startsWith('[bestOfN] candidate 2 (') && l.includes('made a link (lead-out)')), said.join('\n')).toBe(true)
    // No git command walked the work tree: no listing of untracked files, nothing staged.
    expect(gitCalls().filter(c => /ls-files.*--others/.test(c) || / add /.test(c) || / status/.test(c)), gitCalls().join('\n')).toEqual([])
    // Nothing under the link was ever named to git.
    expect(gitCalls().filter(c => c.includes('lead-out/')), gitCalls().join('\n')).toEqual([])
    expect(ms).toBeLessThan(5000)
  }, 60_000)

  it('a junction under an ignored folder is not walked and does not refuse the candidate', () => {
    const r = repo('node_modules/\n')
    mkdirSync(join(r, 'node_modules'))
    junction(bigOutside(1), join(r, 'node_modules', 'pkg'))
    writeFileSync(join(r, 'hello.txt'), 'changed\n')
    const patch = extractPatch(r)
    expect(patch).toContain('+changed')
    expect(gitCalls().filter(c => c.includes('node_modules/')), gitCalls().join('\n')).toEqual([])
  }, 60_000)

  it('an ignored folder that holds a tracked file is still walked: a link that replaces a tracked folder in it is refused', () => {
    const r = mkdtempSync(join(tmpdir(), 'cynco-patch-walk-'))
    made.push(r)
    const run = (cmd: string) => execSync(cmd, { cwd: r, stdio: 'pipe' })
    run('git init -q'); run('git config user.email "t@t"'); run('git config user.name "T"')
    mkdirSync(join(r, 'build', 'x'), { recursive: true })
    writeFileSync(join(r, 'build', 'x', 'f.txt'), 'tracked\n')
    run('git add build/x/f.txt')
    writeFileSync(join(r, '.gitignore'), 'build/\n')
    run('git add .gitignore')
    run('git commit -q -m init')
    // The candidate replaces the tracked folder build/x with a junction to a folder holding f.txt:
    // `git add -A` would stage the outside file as the tracked one's new content.
    rmSync(join(r, 'build', 'x'), { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'cynco-patch-walk-out-'))
    made.push(outside)
    writeFileSync(join(outside, 'f.txt'), 'not the candidate\'s\n')
    junction(outside, join(r, 'build', 'x'))
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')) })
    expect(extractPatch(r)).toBe('')
    expect(said.some(l => l.includes('made a link (build') && l.includes('x)')), said.join('\n')).toBe(true)
  }, 60_000)

  /**
   * Wave 19, check C4-8: a folder git takes for an embedded repository (its own `.git` with a commit
   * checked out) is staged as one gitlink and never entered by `git add -A` (measured, git 2.53:
   * `add 'x/'`), so the walk does not enter it either: a link inside it is not the candidate's to
   * stage. A folder whose `.git` is not a repository git can read (a `.git` file naming nothing, an
   * empty `.git` folder) is entered by `git add -A`, which then stages what a junction in it leads to
   * (measured: `add 'x/lead/s.txt'`), so the walk enters it as before and refuses the link.
   */
  function nested(kind: 'repo' | 'fake-file' | 'empty-dir'): { r: string; outside: string } {
    const r = repo()
    const x = join(r, 'x')
    mkdirSync(x)
    const run = (cmd: string) => execSync(cmd, { cwd: x, stdio: 'pipe' })
    if (kind === 'repo') {
      run('git init -q'); run('git config user.email "t@t"'); run('git config user.name "T"')
      writeFileSync(join(x, 'n.txt'), 'nested\n')
      run('git add n.txt'); run('git commit -q -m n')
    } else if (kind === 'fake-file') {
      writeFileSync(join(x, '.git'), 'gitdir: nowhere\n')
    } else {
      mkdirSync(join(x, '.git'))
    }
    const outside = mkdtempSync(join(tmpdir(), 'cynco-patch-walk-out-'))
    made.push(outside)
    writeFileSync(join(outside, 's.txt'), 'not the candidate\'s\n')
    junction(outside, join(x, 'lead'))
    writeFileSync(join(r, 'hello.txt'), 'changed\n')
    calls.splice(0)
    return { r, outside }
  }

  it('an embedded repository is not entered: a link inside it does not refuse the candidate', () => {
    const { r } = nested('repo')
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')) })
    const patch = extractPatch(r, 'candidate 1')
    expect(patch, said.join('\n')).toContain('+changed')
    expect(patch).not.toContain('not the candidate')
    expect(gitCalls().filter(c => c.includes('x/lead')), gitCalls().join('\n')).toEqual([])
  }, 60_000)

  it('a folder whose .git is a file naming nothing is entered, and its link refuses the candidate', () => {
    const { r } = nested('fake-file')
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')) })
    expect(extractPatch(r, 'candidate 1')).toBe('')
    expect(said.some(l => l.includes('made a link (x/lead)')), said.join('\n')).toBe(true)
  }, 60_000)

  it('a folder whose .git is an empty folder is entered, and its link refuses the candidate', () => {
    const { r } = nested('empty-dir')
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')) })
    expect(extractPatch(r, 'candidate 1')).toBe('')
    expect(said.some(l => l.includes('made a link (x/lead)')), said.join('\n')).toBe(true)
  }, 60_000)

  it('a folder git cannot be asked about refuses the candidate', () => {
    const r = mkdtempSync(join(tmpdir(), 'cynco-patch-walk-nogit-'))
    made.push(r)
    mkdirSync(join(r, 'sub'))
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')) })
    expect(extractPatch(r)).toBe('')
  }, 60_000)
})
