import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { commitsSince } from '../../training/gitFacts.js'

// Finding (x): after a compaction the agent did not know what it had already
// committed and redid work that was already on disk. The summary carried the
// brief but nothing about the task's own history, and the model has no way to
// recover that by reasoning -- only by measuring.

describe('commitsSince', () => {
  let repo: string
  let baseSha: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'commitssince-'))
    const run = (c: string) => execSync(c, { cwd: repo, stdio: 'pipe' })
    run('git init -q')
    run('git config user.email t@t.t')
    run('git config user.name t')
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1\n')
    run('git add -A')
    run('git commit -q -m "base commit before the task"')
    baseSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  const commit = (file: string, body: string, msg: string) => {
    writeFileSync(join(repo, file), body)
    execSync('git add -A', { cwd: repo, stdio: 'pipe' })
    execSync(`git commit -q -m "${msg}"`, { cwd: repo, stdio: 'pipe' })
  }

  it('lists the subject of every commit made since the baseline', () => {
    commit('a.ts', 'a\n', 'restore the deleted cases')
    commit('b.ts', 'b\n', 'add the four missing tests')

    const out = commitsSince(repo, baseSha)!
    expect(out).toContain('restore the deleted cases')
    expect(out).toContain('add the four missing tests')
  })

  it('excludes commits that were already there when the task began', () => {
    commit('a.ts', 'a\n', 'work done during the task')
    expect(commitsSince(repo, baseSha)).not.toContain('base commit before the task')
  })

  it('returns an empty string when the task has committed nothing yet', () => {
    expect(commitsSince(repo, baseSha)).toBe('')
  })

  it('returns null — not an empty string — when there is no baseline to measure from', () => {
    // Nothing to compare against is "not measured". An empty string here would
    // be the positive claim that the task has committed nothing, and would tell
    // the model to redo everything.
    expect(commitsSince(repo, null)).toBeNull()
  })

  it('returns null when git cannot answer', () => {
    expect(commitsSince(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
    expect(commitsSince(join(tmpdir(), 'no-such-repo-' + Date.now()), baseSha)).toBeNull()
  })

  it('names the files each commit touched, so the model can see what is already done', () => {
    commit('ledger.py', 'x\n', 'add the ledger')
    const out = commitsSince(repo, baseSha)!
    expect(out).toContain('ledger.py')
  })
})
