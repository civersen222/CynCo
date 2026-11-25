/**
 * Best-of-N's git in a candidate's worktree and in the mission folder (wave 19c, check D19b-6): the
 * patch extraction's `git add -A` / `git diff --cached` / `git reset` and the winner's
 * `git apply --check` / `git apply` start `harnessGitBin` with one argument vector, no shell, under the
 * package's cap (`GIT_TIMEOUT_MS`), as every other git call of the package does. Until wave 19c they ran
 * through `execSync` with no cap, so a git that hung (a lock held, a slow volume) held the engine's
 * event loop for good (F225 class).
 *
 * `child_process` is the seam: it records each of these five calls and, for the one a case names,
 * starts a process that hangs in its place, under the options the site gave, with the site's cap scaled
 * down so the case ends in a second. Every other git runs for real. Plain git repositories, Node and
 * temp folders only: the cases run on the Linux CI as they are.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const seam = vi.hoisted(() => ({
  active: false,
  hang: null as string | null,
  calls: [] as Array<{ via: string; file?: string; args?: string[]; command?: string; timeout?: unknown; windowsHide?: unknown }>,
}))

/** The package's cap (`GIT_TIMEOUT_MS`, worktreeManager.ts), written out because the mock is hoisted above imports. */
const SITE_CAP_MS = 60_000
/** What a hanging git is given in place of the site's cap, so a case ends quickly. */
const HANG_CAP_MS = 400

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const SITE_CALLS = new Set(['add', 'diff', 'reset', 'apply'])
  const keyOf = (args: string[]) => (args[0] === 'apply' && args.includes('--check') ? 'apply --check' : args[0]!)
  const execFileSync = ((file: string, args: readonly string[], options: Record<string, unknown> = {}) => {
    if (seam.active && Array.isArray(args) && SITE_CALLS.has(args[0])) {
      seam.calls.push({ via: 'execFileSync', file, args: [...args], timeout: options.timeout, windowsHide: options.windowsHide })
      if (seam.hang === keyOf([...args])) {
        // A git that never answers. The site's own cap ends it, scaled down only when it is the
        // package's cap; with no cap the process ends by itself after 20 s and the case fails.
        const timeout = options.timeout === SITE_CAP_MS ? HANG_CAP_MS : options.timeout
        return real.execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { ...options, timeout } as never)
      }
    }
    return real.execFileSync(file, args as string[], options as never)
  }) as typeof real.execFileSync
  const execSync = ((command: string, options: Record<string, unknown> = {}) => {
    if (seam.active) seam.calls.push({ via: 'execSync', command, timeout: options.timeout })
    return real.execSync(command, options as never)
  }) as typeof real.execSync
  return { ...real, execFileSync, execSync }
})

const { extractPatch } = await import('../../bestOfN/patchExtractor.js')
const { applyPatch } = await import('../../bestOfN/sampler.js')
const { GIT_TIMEOUT_MS } = await import('../../bestOfN/worktreeManager.js')
const { harnessGitBin, harnessGitEnv } = await import('../../harnessGit.js')

const temps: string[] = []
afterEach(() => {
  seam.active = false; seam.hang = null; seam.calls.length = 0
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-gitcap-'))
  temps.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@test.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'hello.txt'), 'hello world\n')
  git('add', 'hello.txt')
  git('commit', '-q', '-m', 'init')
  return dir
}

/** A repository with one change, its patch, and the repository put back to HEAD. */
function patchOf(dir: string): string {
  writeFileSync(join(dir, 'hello.txt'), 'hello world\nand a line\n')
  const patch = extractPatch(dir, 'candidate 1')
  execFileSync('git', ['checkout', '--', '.'], { cwd: dir, stdio: 'pipe' })
  return patch
}

describe('best-of-N runs its git in a worktree and the mission folder by argument vector, under the cap (wave 19c, check D19b-6)', () => {
  it('the five calls start harnessGitBin of the harness environment with GIT_TIMEOUT_MS, and none is shell text', () => {
    expect(GIT_TIMEOUT_MS).toBe(SITE_CAP_MS)
    const dir = repo()
    const bin = harnessGitBin(harnessGitEnv(process.env, { repo: dir }))
    writeFileSync(join(dir, 'hello.txt'), 'hello world\nand a line\n')
    seam.active = true
    const patch = extractPatch(dir, 'candidate 1')
    seam.active = false
    expect(patch).toContain('+and a line')
    execFileSync('git', ['checkout', '--', '.'], { cwd: dir, stdio: 'pipe' })
    seam.active = true
    const why: string[] = []
    expect(applyPatch(dir, patch, w => why.push(w))).toBe(true)
    seam.active = false
    expect(why).toEqual([])
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello world\nand a line\n')
    expect(seam.calls.filter(c => c.via === 'execSync')).toEqual([])
    expect(seam.calls.map(c => c.args!.join(' '))).toEqual([
      'add -A',
      'diff --no-ext-diff --no-textconv --cached HEAD',
      'reset HEAD',
      'apply --check -',
      'apply -',
    ])
    for (const c of seam.calls) expect([c.file, c.timeout, c.windowsHide]).toEqual([bin, GIT_TIMEOUT_MS, true])
  })

  for (const call of ['add', 'diff', 'reset'] as const) {
    it(`extractPatch: a git ${call} that hangs is ended by the cap, and the candidate gives no patch`, () => {
      const dir = repo()
      writeFileSync(join(dir, 'hello.txt'), 'hello world\nchanged\n')
      seam.active = true
      seam.hang = call
      const t0 = Date.now()
      const patch = extractPatch(dir, 'candidate 2')
      const ms = Date.now() - t0
      seam.active = false
      expect(patch).toBe('')
      expect(ms).toBeLessThan(15_000)
      expect(seam.calls.filter(c => c.args?.[0] === call)).toHaveLength(1)
    }, 30_000)
  }

  for (const [call, reason] of [
    ['apply --check', /^git apply --check refused it: .*ETIMEDOUT/],
    ['apply', /^git apply failed: .*ETIMEDOUT/],
  ] as const) {
    it(`applyPatch: a git ${call} that hangs is ended by the cap; the patch is not applied and the reason says why`, () => {
      const dir = repo()
      const patch = patchOf(dir)
      expect(patch).toContain('+and a line')
      seam.active = true
      seam.hang = call
      const why: string[] = []
      const t0 = Date.now()
      const applied = applyPatch(dir, patch, w => why.push(w))
      const ms = Date.now() - t0
      seam.active = false
      expect(applied).toBe(false)
      expect(why).toHaveLength(1)
      expect(why[0]).toMatch(reason)
      expect(ms).toBeLessThan(15_000)
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello world\n')
    }, 30_000)
  }
})
