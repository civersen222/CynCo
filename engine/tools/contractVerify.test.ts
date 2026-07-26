import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertionCheck,
  verifyAssertion,
  gitProbe,
  fileModifiedAssertion,
  fileExistsAssertion,
  COMMITTED_ASSERTION,
  type RepoProbe,
} from './contractVerify.js'

describe('assertionCheck — recovering the claim from engine-generated text', () => {
  test('reads back the templates contractAutoCreate emits', () => {
    expect(assertionCheck(fileModifiedAssertion('gilded/grip.py'))).toEqual({ kind: 'file_modified', path: 'gilded/grip.py' })
    expect(assertionCheck(fileExistsAssertion('a/b.ts'))).toEqual({ kind: 'file_exists', path: 'a/b.ts' })
    expect(assertionCheck(COMMITTED_ASSERTION)).toEqual({ kind: 'committed' })
  })

  test('a judgement-call assertion has no machine check', () => {
    expect(assertionCheck('Analysis or answer was provided to the user')).toBeNull()
    expect(assertionCheck('Task was completed — user request fully addressed')).toBeNull()
  })
})

function probe(over: Partial<RepoProbe> = {}): RepoProbe {
  return {
    head: async () => 'aaaaaaaa',
    isDirty: async () => false,
    changedSince: async () => false,
    exists: () => true,
    ...over,
  }
}

describe('verifyAssertion', () => {
  test('an untouched file contradicts "was modified"', async () => {
    const v = await verifyAssertion({ kind: 'file_modified', path: 'grip.py' }, probe(), 'aaaaaaaa')
    expect(v.status).toBe('contradicted')
  })

  test('uncommitted edits confirm "was modified"', async () => {
    const v = await verifyAssertion({ kind: 'file_modified', path: 'grip.py' }, probe({ isDirty: async () => true }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })

  test('a commit since the baseline confirms "was modified"', async () => {
    const v = await verifyAssertion({ kind: 'file_modified', path: 'grip.py' }, probe({ changedSince: async () => true }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })

  test('dirtiness is judged per file, not repo-wide', async () => {
    const p = probe({ isDirty: async (path) => path === 'other.py' })
    expect((await verifyAssertion({ kind: 'file_modified', path: 'grip.py' }, p, 'aaaaaaaa')).status).toBe('contradicted')
  })

  test('HEAD still at the baseline contradicts "committed"', async () => {
    const v = await verifyAssertion({ kind: 'committed' }, probe(), 'aaaaaaaa')
    expect(v.status).toBe('contradicted')
    expect((v as { detail: string }).detail).toContain('no commit was made')
  })

  test('a moved HEAD confirms "committed"', async () => {
    const v = await verifyAssertion({ kind: 'committed' }, probe({ head: async () => 'bbbbbbbb' }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })

  test('a pre-existing commit does not count — the baseline is what makes it falsifiable', async () => {
    // The exact live failure: the model passed "Changes committed to git" citing
    // 1166a60, a commit made before this task began.
    const v = await verifyAssertion({ kind: 'committed' }, probe({ head: async () => '1166a60' }), '1166a60')
    expect(v.status).toBe('contradicted')
  })

  test('missing file contradicts "exists"', async () => {
    const v = await verifyAssertion({ kind: 'file_exists', path: 'nope.py' }, probe({ exists: () => false }), null)
    expect(v.status).toBe('contradicted')
  })

  test('no git repo is unverifiable, not confirmed', async () => {
    const none = probe({ head: async () => null, isDirty: async () => null, changedSince: async () => null })
    expect((await verifyAssertion({ kind: 'file_modified', path: 'x.py' }, none, 'aaaaaaaa')).status).toBe('unverifiable')
    expect((await verifyAssertion({ kind: 'committed' }, none, 'aaaaaaaa')).status).toBe('unverifiable')
  })

  test('no baseline is unverifiable, not confirmed', async () => {
    expect((await verifyAssertion({ kind: 'committed' }, probe(), null)).status).toBe('unverifiable')
    expect((await verifyAssertion({ kind: 'file_modified', path: 'x.py' }, probe(), null)).status).toBe('unverifiable')
  })
})

describe('gitProbe against a real repository', () => {
  let dir: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cvfy-'))
    git('init', '-q')
    git('config', 'user.email', 't@t.t')
    git('config', 'user.name', 'T')
    writeFileSync(join(dir, 'a.py'), 'print(1)\n')
    writeFileSync(join(dir, 'b.py'), 'print(2)\n')
    git('add', '.')
    git('commit', '-qm', 'base')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a clean repo contradicts both claims', async () => {
    const p = gitProbe(dir)
    const baseline = await p.head()
    expect((await verifyAssertion({ kind: 'file_modified', path: 'a.py' }, p, baseline)).status).toBe('contradicted')
    expect((await verifyAssertion({ kind: 'committed' }, p, baseline)).status).toBe('contradicted')
  })

  test('editing one file confirms only that file', async () => {
    const p = gitProbe(dir)
    const baseline = await p.head()
    writeFileSync(join(dir, 'a.py'), 'print(99)\n')
    expect((await verifyAssertion({ kind: 'file_modified', path: 'a.py' }, p, baseline)).status).toBe('confirmed')
    expect((await verifyAssertion({ kind: 'file_modified', path: 'b.py' }, p, baseline)).status).toBe('contradicted')
  })

  test('committing an edit confirms both claims', async () => {
    const p = gitProbe(dir)
    const baseline = await p.head()
    writeFileSync(join(dir, 'a.py'), 'print(99)\n')
    git('add', '.')
    git('commit', '-qm', 'change')
    expect((await verifyAssertion({ kind: 'file_modified', path: 'a.py' }, p, baseline)).status).toBe('confirmed')
    expect((await verifyAssertion({ kind: 'committed' }, p, baseline)).status).toBe('confirmed')
  })

  test('outside a git repo the probe answers null, not false', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cvfy-nogit-'))
    try {
      expect(await gitProbe(plain).head()).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
