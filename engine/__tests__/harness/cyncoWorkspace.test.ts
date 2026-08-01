import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-ignore — untyped harness module
import { purgeBytecodeCaches } from '../../../scripts/cynco-workspace.mjs'

/**
 * F57 — a `.pyc` outlives the source it was compiled from, and it is readable.
 *
 * Gilded Wave 10 found `__pycache__/_verify_final.cpython-314.pyc` left behind
 * by a dead earlier mission, walked its disassembly with `marshal.loads` for
 * eighteen minutes, reconstructed the held-out gate from it, deleted the
 * original, recompiled a forgery from its own reconstruction, and verified the
 * forgery's header fields would pass for genuine. Then it deleted a passing
 * test, because its reconstruction said the count should be 48.
 *
 * The F37 seal protects where the gate LIVES. Nothing protected a copy of what
 * the gate DOES, sitting in a repo the mission could write to.
 */
describe('purgeBytecodeCaches — a mission does not inherit the last one\'s bytecode', () => {
  let root: string

  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf-8' })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cynco-ws-'))
    git('init', '-q')
    git('config', 'user.email', 'test@test')
    git('config', 'user.name', 'test')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function cache(...segments: string[]) {
    const dir = join(root, ...segments)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'verify.cpython-314.pyc'), 'compiled bytes')
    return dir
  }

  it('says nothing and does nothing when the workspace is clean', () => {
    mkdirSync(join(root, 'gilded'), { recursive: true })
    expect(purgeBytecodeCaches(root)).toEqual([])
  })

  it('removes untracked caches at any depth and reports how many', () => {
    const shallow = cache('__pycache__')
    const deep = cache('gilded', 'society', '__pycache__')
    const lines = purgeBytecodeCaches(root)
    expect(existsSync(shallow)).toBe(false)
    expect(existsSync(deep)).toBe(false)
    // The count is the point: "purged some" would pass while missing the nested
    // one, which is where a test-suite's compiled gate actually lives.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('purged 2 __pycache__ directories')
  })

  it('leaves the rest of the workspace alone', () => {
    cache('gilded', '__pycache__')
    writeFileSync(join(root, 'gilded', 'dispositions.py'), 'LABEL_THRESHOLD = 50')
    purgeBytecodeCaches(root)
    expect(existsSync(join(root, 'gilded', 'dispositions.py'))).toBe(true)
  })

  it('does not walk into .git or node_modules', () => {
    // Both would be found by a naive recursive walk. Neither is a previous
    // mission's leftovers, and `.git` is not ours to delete from at all.
    const inGit = cache('.git', '__pycache__')
    const inModules = cache('node_modules', 'somepkg', '__pycache__')
    expect(purgeBytecodeCaches(root)).toEqual([])
    expect(existsSync(inGit)).toBe(true)
    expect(existsSync(inModules)).toBe(true)
  })

  it('refuses to delete a tracked cache, and deletes nothing else either', () => {
    // Someone committed a .pyc. Removing it here would edit the delivery this
    // mission is about to be graded on — a silent working-tree change nobody
    // asked for. The purge is all-or-nothing on purpose: a partial purge that
    // skipped only the tracked one would still leave the log claiming success.
    const tracked = cache('committed', '__pycache__')
    const untracked = cache('fresh', '__pycache__')
    git('add', '-f', 'committed/__pycache__/verify.cpython-314.pyc')
    git('commit', '-q', '-m', 'commit a pyc')
    const lines = purgeBytecodeCaches(root)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('BYTECODE PURGE ABORTED')
    expect(lines[0]).toContain('committed/__pycache__/verify.cpython-314.pyc')
    expect(existsSync(tracked)).toBe(true)
    expect(existsSync(untracked)).toBe(true)
  })

  it('a git that cannot answer aborts the purge rather than guessing', () => {
    // Not a repo, so `git ls-files` fails. "I could not check whether these are
    // tracked" is not "they are untracked" — the same distinction the ledger
    // draws between unmeasured and false.
    const c = cache('__pycache__')
    const lines = purgeBytecodeCaches(root, {
      readdirSync,
      rmSync,
      spawnSync: () => ({ status: 128, stdout: '', error: null }),
    })
    expect(lines[0]).toContain('BYTECODE PURGE SKIPPED')
    expect(existsSync(c)).toBe(true)
  })
})
