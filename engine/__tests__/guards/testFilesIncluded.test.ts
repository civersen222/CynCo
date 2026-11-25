/**
 * Every test file of the repository is a file the suite runs (F244).
 *
 * When bun test was replaced by vitest (8fc8bcea, 2026-05-02) nothing listed the test folders that sit
 * beside their package rather than under engine/__tests__, and their 160 tests went unrun by every suite
 * run and every CI job until 2026-11-24. A test file that matches no `include` glob of vitest.config.ts
 * is not reported as anything: it is simply not there. This guard lists every `*.test.ts` and
 * `*.test.mjs` file git knows (tracked, and new files not ignored) and fails on one no glob takes.
 *
 * engine/cybernetics-core's tests run from the repository root the same way, so its own package.json
 * names no test script (NOW.md, 2026-11-24): a second way to run them would be a second configuration.
 * Its vitest devDependency stays, because its committed lock file records it and a new lock needs a download.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import config from '../../../vitest.config'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** A glob of the kind vitest.config.ts uses (`**`, `*`, `?`) as a whole-path regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** The test files that no include glob takes. Paths are repository-relative with forward slashes. */
export function notIncluded(files: string[], include: string[]): string[] {
  const res = include.map(globToRegExp)
  return files.filter(f => !res.some(r => r.test(f)))
}

const TEST_FILE = /\.test\.(ts|mjs)$/

describe('every test file matches an include glob of vitest.config.ts (F244)', () => {
  it('the matcher: a file under a listed folder is taken, one beside it is named', () => {
    const include = ['engine/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']
    expect(notIncluded([
      'engine/__tests__/a.test.ts', 'engine/__tests__/deep/er/b.test.ts', 'scripts/__tests__/c.test.mjs',
      'engine/memory/__tests__/d.test.ts', 'scripts/__tests__/e.test.ts', 'engine/__tests__x/f.test.ts',
    ], include)).toEqual(['engine/memory/__tests__/d.test.ts', 'scripts/__tests__/e.test.ts', 'engine/__tests__x/f.test.ts'])
  })

  it('no test file git knows is left out of the suite', () => {
    const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    expect(r.status, String(r.stderr)).toBe(0)
    const files = String(r.stdout).split('\0').filter(f => TEST_FILE.test(f))
    // A floor, so that a listing that came back empty cannot pass as "nothing left out".
    expect(files.length).toBeGreaterThan(500)
    const include = (config as { test?: { include?: string[] } }).test?.include ?? []
    expect(include.length).toBeGreaterThan(0)
    expect(notIncluded(files, include), 'test files that no include glob of vitest.config.ts takes: add their folder to the globs').toEqual([])
  })
})

describe('engine/cybernetics-core runs its tests from the repository root only', () => {
  // Changed on purpose in wave 15c (pin 5): round one also took the vitest devDependency out, which left the
  // committed package-lock.json naming one package.json did not. Regenerating the lock needs a download, which
  // is not allowed, so the devDependency is back exactly as at 222a0b5e and this case pins that the two files
  // agree instead of pinning vitest's absence. The test SCRIPTS (the second way to run the tests) stay out.
  it('its package.json names no test script, and declares exactly what its lock file records', () => {
    type Deps = { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'engine', 'cybernetics-core', 'package.json'), 'utf8')) as Deps & {
      scripts?: Record<string, string>
    }
    const lock = JSON.parse(readFileSync(join(ROOT, 'engine', 'cybernetics-core', 'package-lock.json'), 'utf8')) as {
      packages: Record<string, Deps>
    }
    expect(Object.keys(pkg.scripts ?? {}).filter(k => /^test/.test(k))).toEqual([])
    const root = lock.packages['']
    expect({ dev: pkg.devDependencies ?? {}, deps: pkg.dependencies ?? {} }, 'package.json and package-lock.json name the same packages')
      .toEqual({ dev: root.devDependencies ?? {}, deps: root.dependencies ?? {} })
    expect(config.test?.include).toContain('engine/cybernetics-core/tests/**/*.test.ts')
  })
})
