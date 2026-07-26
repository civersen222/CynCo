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
import { getShellInfo } from './shellInfo.js'

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
    run: async () => 0,
    ...over,
  }
}

/**
 * `Verification command exits 0: <cmd>` is the form the mission driver and every
 * harness-authored contract use, and it was the ONE assertion shape whose whole
 * purpose is to be executed — yet `assertionCheck` did not recognise it, so it
 * fell through to "no machine check" and was passed on the model's own say-so.
 *
 * That made the harness-contract path, the only route to a measured
 * `taskCompleted`, a self-report. `taskCompleted: 1` meant "the agent said the
 * check would pass", which is exactly the plausible default this module exists
 * to refuse.
 */
describe('assertionCheck — a verification command is a claim the machine can settle', () => {
  test('reads the command back out of the harness template', () => {
    expect(assertionCheck('Verification command exits 0: pytest -q gilded/')).toEqual({
      kind: 'command',
      command: 'pytest -q gilded/',
    })
  })

  test('a multi-line command survives', () => {
    expect(assertionCheck('Verification command exits 0: cd x &&\npytest -q')).toEqual({
      kind: 'command',
      command: 'cd x &&\npytest -q',
    })
  })

  test('an empty command is not a check', () => {
    expect(assertionCheck('Verification command exits 0: ')).toBeNull()
  })
})

describe('verifyAssertion — command', () => {
  test('exit 0 confirms the assertion', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'true' }, probe({ run: async () => 0 }), null)
    expect(v.status).toBe('confirmed')
  })

  test('a nonzero exit contradicts it, and says which code', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'false' }, probe({ run: async () => 1 }), null)
    expect(v.status).toBe('contradicted')
    expect(v.status === 'contradicted' && v.detail).toContain('exit code 1')
  })

  test('a command that could not be run at all is unverifiable, not failed', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'x' }, probe({ run: async () => null }), null)
    expect(v.status).toBe('unverifiable')
  })

  test('needs no git baseline — it is the one check that stands alone', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'true' }, probe({ head: async () => null }), null)
    expect(v.status).toBe('confirmed')
  })
})

describe('gitProbe.run — really executes', () => {
  test('reports 0 for a passing command and nonzero for a failing one', async () => {
    const p = gitProbe(process.cwd())
    expect(await p.run('exit 0')).toBe(0)
    expect(await p.run('exit 3')).toBe(3)
  })

  /**
   * The check script is written in the same dialect as every other command in
   * the session, because whoever wrote the brief wrote both. `exec` defaults to
   * cmd.exe on Windows, which would have failed a PowerShell check on syntax and
   * reported it as the work being wrong.
   */
  test('runs in the same shell the Bash tool uses', async () => {
    const p = gitProbe(process.cwd())
    const probeCommand = getShellInfo().isPowerShell
      ? 'if ($PSVersionTable) { exit 0 } else { exit 9 }'
      : 'test -n "$BASH_VERSION" && exit 0 || exit 9'
    expect(await p.run(probeCommand)).toBe(0)
  })
})

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
