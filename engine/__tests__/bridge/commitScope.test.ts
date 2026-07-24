import { describe, it, expect } from 'vitest'
import { checkCommitScope } from '../../bridge/commitScope.js'

const bash = (command: string) => ({ command })

describe('checkCommitScope', () => {
  it('refuses git add -A', () => {
    expect(checkCommitScope('Bash', bash('git add -A')).allowed).toBe(false)
  })

  it('refuses git add --all and git add -u', () => {
    expect(checkCommitScope('Bash', bash('git add --all')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git add -u')).allowed).toBe(false)
  })

  it('refuses git add .', () => {
    expect(checkCommitScope('Bash', bash('git add .')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git add . && git commit -m "x"')).allowed).toBe(false)
  })

  it('refuses git commit -a, -am, and --all', () => {
    expect(checkCommitScope('Bash', bash('git commit -a -m "x"')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git commit -am "x"')).allowed).toBe(false)
    expect(checkCommitScope('Bash', bash('git commit --all -m "x"')).allowed).toBe(false)
  })

  it('permits explicit pathspecs', () => {
    expect(checkCommitScope('Bash', bash('git add game.py test_wonder.py')).allowed).toBe(true)
    expect(checkCommitScope('Bash', bash('git add ./src/foo.ts')).allowed).toBe(true)
    expect(checkCommitScope('Bash', bash('git add src/a.ts && git commit -m "msg"')).allowed).toBe(true)
  })

  it('does not treat --amend or -m as staging-all', () => {
    expect(checkCommitScope('Bash', bash('git commit --amend --no-edit')).allowed).toBe(true)
    expect(checkCommitScope('Bash', bash('git commit -m "add all the things"')).allowed).toBe(true)
  })

  it('is not fooled by a quoted occurrence', () => {
    expect(checkCommitScope('Bash', bash('echo "git add -A" >> notes.txt')).allowed).toBe(true)
  })

  it('ignores non-git commands and non-Bash tools', () => {
    expect(checkCommitScope('Bash', bash('python -m pytest')).allowed).toBe(true)
    expect(checkCommitScope('Edit', bash('git add -A')).allowed).toBe(true)
  })

  it('explains what to do instead when it refuses', () => {
    const v = checkCommitScope('Bash', bash('git add -A'))
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/by name/i)
  })

  // Fix 3: Git tool bypass
  it('blocks repo-wide staging through the Git tool', () => {
    const v = checkCommitScope('Git', { subcommand: 'add', args: '-A' })
    expect(v.allowed).toBe(false)
  })

  it('blocks git commit --all through the Git tool', () => {
    expect(checkCommitScope('Git', { subcommand: 'commit', args: '--all -m "x"' }).allowed).toBe(false)
  })

  it('permits a scoped add through the Git tool', () => {
    expect(checkCommitScope('Git', { subcommand: 'add', args: 'src/foo.ts' }).allowed).toBe(true)
  })

  // Fix 4: false positives across command separators
  it('does not block a scoped commit followed by an unrelated flag-bearing command', () => {
    expect(checkCommitScope('Bash', { command: 'git commit -m "x" && ls -la' }).allowed).toBe(true)
  })

  it('does not block a scoped add followed by ls -A', () => {
    expect(checkCommitScope('Bash', { command: 'git add file.ts && ls -A' }).allowed).toBe(true)
  })

  it('does not block a scoped add followed by git status -u', () => {
    expect(checkCommitScope('Bash', { command: 'git add a.ts && git status -u' }).allowed).toBe(true)
  })

  it('still blocks a repo-wide add hidden after a separator', () => {
    expect(checkCommitScope('Bash', { command: 'echo hi && git add -A' }).allowed).toBe(false)
  })

  // Fix 5: bare glob and stage alias
  it('blocks a bare glob add', () => {
    expect(checkCommitScope('Bash', { command: 'git add *' }).allowed).toBe(false)
  })

  it('blocks the stage alias', () => {
    expect(checkCommitScope('Bash', { command: 'git stage -A' }).allowed).toBe(false)
  })

  it('still permits a glob scoped to a directory', () => {
    expect(checkCommitScope('Bash', { command: 'git add src/*.ts' }).allowed).toBe(true)
  })
})
