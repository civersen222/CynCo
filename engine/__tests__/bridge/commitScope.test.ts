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
})
