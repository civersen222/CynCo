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
  fileAbsentAssertion,
  COMMITTED_ASSERTION,
  testCensusAssertion,
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

  test('an absence claim is not mistaken for an existence claim', () => {
    // Both templates start `File <path> ` and end `exists after changes`, and the
    // path capture is greedy, so the exists pattern will happily swallow
    // "realm_eb29375.py no longer" as a path unless absence is read first.
    expect(assertionCheck(fileAbsentAssertion('realm_eb29375.py'))).toEqual({
      kind: 'file_absent',
      path: 'realm_eb29375.py',
    })
  })
})

/**
 * Watched live on L2f: the brief's first task was "Delete `realm_eb29375.py` from
 * the repo root", and the auto-contract turned it into "File realm_eb29375.py was
 * modified (git diff shows changes)". The file was UNTRACKED, so no git diff could
 * ever show a change to it, and once deleted it did not exist at all — an
 * assertion nothing could satisfy, attached to an instruction that was carried out
 * correctly within seconds. CynCo read it and rationalised: "this means the file
 * should be deleted (modification includes deletion)".
 *
 * A deletion is a claim about absence. git diff is the wrong instrument.
 */
describe('verifyAssertion — a deletion is settled by absence', () => {
  test('confirmed when the file is gone', async () => {
    const v = await verifyAssertion({ kind: 'file_absent', path: 'scratch.py' }, probe({ exists: () => false }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })

  test('contradicted while the file is still there', async () => {
    const v = await verifyAssertion({ kind: 'file_absent', path: 'scratch.py' }, probe({ exists: () => true }), 'aaaaaaaa')
    expect(v.status).toBe('contradicted')
  })

  test('needs no git and no baseline — the filesystem answers on its own', async () => {
    const v = await verifyAssertion(
      { kind: 'file_absent', path: 'scratch.py' },
      probe({
        exists: () => false,
        head: async () => null,
        isDirty: async () => null,
        changedSince: async () => null,
      }),
      null,
    )
    expect(v.status).toBe('confirmed')
  })
})

function probe(over: Partial<RepoProbe> = {}): RepoProbe {
  return {
    head: async () => 'aaaaaaaa',
    isDirty: async () => false,
    dirtyPaths: async () => [],
    changedSince: async () => false,
    exists: () => true,
    read: () => null,
    run: async () => 'passed',
    ...over,
  }
}

/**
 * Finding (w). Every other assertion shape describes the product; a contract
 * built only from those is silent about whether the suite that measures the
 * product survived, and the reward gate was reading that silence as consent.
 */
describe('verifyAssertion — a census floor is answered by the file', () => {
  const suite = (n: number) =>
    Array.from({ length: n }, (_, i) => `def test_case_${i}():\n    assert True\n`).join('\n')

  test('confirmed when the file still declares at least the floor', async () => {
    const v = await verifyAssertion(
      { kind: 'test_census', path: 'tests/test_a.py', min: 40 },
      probe({ read: () => suite(45) }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })

  test('contradicted when cases were deleted below the floor, and says by how many', async () => {
    const v = await verifyAssertion(
      { kind: 'test_census', path: 'tests/test_a.py', min: 45 },
      probe({ read: () => suite(41) }), 'aaaaaaaa')
    expect(v.status).toBe('contradicted')
    expect(v.status === 'contradicted' && v.detail).toContain('declares 41 test cases')
  })

  test('contradicted, not unverifiable, when the file cannot be read', async () => {
    // A deleted file declares no cases. Calling that unmeasurable would let the
    // most complete removal there is settle as "we could not tell".
    const v = await verifyAssertion(
      { kind: 'test_census', path: 'tests/test_a.py', min: 1 },
      probe({ read: () => null }), 'aaaaaaaa')
    expect(v.status).toBe('contradicted')
  })

  test('a case declared with nothing in it still counts as declared', async () => {
    // The census is a floor on DECLARATIONS. Gutting is a different measurement
    // (`casesLost` reads it from the two file versions) and this must not be
    // read as covering it.
    const v = await verifyAssertion(
      { kind: 'test_census', path: 'tests/test_a.py', min: 2 },
      probe({ read: () => 'def test_a():\n    pass\n\ndef test_b():\n    pass\n' }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })

  test('round-trips through the template', () => {
    expect(assertionCheck(testCensusAssertion('gilded/tests/test_ui_broadsheet.py', 45)))
      .toEqual({ kind: 'test_census', path: 'gilded/tests/test_ui_broadsheet.py', min: 45 })
  })

  test('reads a real file through gitProbe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-'))
    try {
      writeFileSync(join(dir, 'test_a.py'), suite(3))
      expect(gitProbe(dir).read('test_a.py')).toContain('def test_case_2')
      expect(gitProbe(dir).read('missing.py')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

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
    const v = await verifyAssertion({ kind: 'command', command: 'true' }, probe({ run: async () => 'passed' }), null)
    expect(v.status).toBe('confirmed')
  })

  test('a failing command contradicts it without naming an exit code', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'false' }, probe({ run: async () => 'failed' }), null)
    expect(v.status).toBe('contradicted')
    const detail = v.status === 'contradicted' ? v.detail : ''
    expect(detail).toContain('did not exit 0')
    // The shell collapses a program's real code, so any number here would be
    // one the engine never measured.
    expect(detail).not.toMatch(/exit code \d/)
  })

  test('a timeout says it was killed, because that part really was measured', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'sleep 999' }, probe({ run: async () => 'timeout' }), null)
    expect(v.status).toBe('contradicted')
    const detail = v.status === 'contradicted' ? v.detail : ''
    expect(detail).toContain('killed')
    expect(detail).not.toMatch(/exit code \d/)
  })

  test('a command that could not be run at all is unverifiable, not failed', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'x' }, probe({ run: async () => 'unrunnable' }), null)
    expect(v.status).toBe('unverifiable')
  })

  test('needs no git baseline — it is the one check that stands alone', async () => {
    const v = await verifyAssertion({ kind: 'command', command: 'true' }, probe({ head: async () => null }), null)
    expect(v.status).toBe('confirmed')
  })
})

describe('gitProbe.run — really executes', () => {
  test('reports passed for a passing command and failed for a failing one', async () => {
    const p = gitProbe(process.cwd())
    expect(await p.run('exit 0')).toBe('passed')
    expect(await p.run('exit 3')).toBe('failed')
  })

  /**
   * Why `run` deliberately does not return the exit code. This used to assert
   * `p.run('exit 3') === 3` and passed — but `exit 3` is the SHELL exiting, and a
   * shell reports its own status faithfully. A verification command is almost
   * never that; it is `python -m pytest ...`, a child program, and PowerShell
   * collapses a child's status to 1. The old message read "failed with exit code
   * 1" for a program that exited 3.
   */
  test('a child program\'s real exit code does not survive the shell', async () => {
    if (!getShellInfo().isPowerShell) return
    const { execSync } = await import('child_process')
    let observed = 0
    try {
      execSync('python -c "import sys; sys.exit(3)"', { shell: getShellInfo().shell, stdio: 'ignore' })
    } catch (err) {
      observed = (err as { status?: number }).status ?? 0
    }
    expect(observed).not.toBe(3)
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
    expect(await p.run(probeCommand)).toBe('passed')
  })

  /**
   * Finding (o), measured on the L3-3.4 run.
   *
   * The contract carried the check the brief carried:
   *
   *   GILDED_NARRATE=0 SDL_VIDEODRIVER=dummy python -m pytest gilded/ ...
   *
   * The work was correct — 446 tests passing, 22 of 22 behavioural checks green,
   * committed. But `NAME=value command` is a parse error in every PowerShell,
   * so the shell rejected the line with CommandNotFoundException before python
   * ever started. The engine saw a numeric status and reported "the
   * verification command did not exit 0", and the agent spent the rest of the
   * run trying to fix code that was already right.
   *
   * The engine already owns this translation: `checkShellDialect` hands the
   * model the exact PowerShell rewrite when the model makes this mistake. It
   * simply was not applied to the one command the engine runs itself. A brief
   * and its contract are written by the same hand in the same dialect, so a
   * contract command written POSIX-style must run, not be scored as failure.
   *
   * This is the reward-grounding rule in its sharpest form: a fabricated
   * NEGATIVE is worse than a fabricated positive. It teaches the model that
   * correct work is failure.
   */
  test('a POSIX env prefix is run, not scored as the work failing', async () => {
    const p = gitProbe(process.cwd())
    expect(await p.run('GREETING=hello python -c "import os,sys; sys.exit(0 if os.environ.get(\'GREETING\')==\'hello\' else 7)"'))
      .toBe('passed')
  })

  test('a genuinely failing command still fails when it carries an env prefix', async () => {
    // The translation must not become a way to pass. Only the dialect changes.
    const p = gitProbe(process.cwd())
    expect(await p.run('GREETING=hello python -c "import sys; sys.exit(1)"')).toBe('failed')
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

  /**
   * Finding (ae), measured on the Gilded L4.6d run.
   *
   * The agent made two commits and left `gilded/tests/test_ai.py` modified in
   * the working tree — the file carrying two of the wave's four jobs. It then
   * marked "Changes committed to git" passed, citing both SHAs, and the engine
   * confirmed it: HEAD had moved, which was the whole of the test.
   *
   * Measured consequence: on the delivered working tree the harness scored
   * 12/12; at HEAD it scored 10/12. Everything anybody else would ever clone was
   * missing the work.
   *
   * A moved HEAD proves a commit happened. It does not prove the work is IN it.
   * The previous wave had the same defect by a different route (a wholly new
   * file that `git diff --name-only` could never mention) and was answered with
   * an instruction in the brief. It recurred, which is the argument for
   * answering it here instead: the repository can settle this, so it should.
   */
  test('a moved HEAD does not confirm "committed" while tracked files are still dirty', async () => {
    const v = await verifyAssertion(
      { kind: 'committed' },
      probe({ head: async () => 'bbbbbbbb', dirtyPaths: async () => ['gilded/tests/test_ai.py'] }),
      'aaaaaaaa',
    )
    expect(v.status).toBe('contradicted')
    expect((v as { detail: string }).detail).toContain('gilded/tests/test_ai.py')
  })

  test('a probe that cannot list dirty paths does not block a moved HEAD', async () => {
    // Absent is a legitimate answer. It must not become a fabricated negative:
    // a repository that cannot answer must not be read as answering "no".
    const v = await verifyAssertion(
      { kind: 'committed' },
      probe({ head: async () => 'bbbbbbbb', dirtyPaths: async () => null }),
      'aaaaaaaa',
    )
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

  test('committing one edit and leaving another dirty contradicts "committed"', async () => {
    // The live L4.6d shape, reproduced exactly: some work committed, one file
    // left behind in the working tree.
    const p = gitProbe(dir)
    const baseline = await p.head()
    writeFileSync(join(dir, 'a.py'), 'print(99)\n')
    git('add', 'a.py')
    git('commit', '-qm', 'change')
    writeFileSync(join(dir, 'b.py'), 'print(98)\n')
    const v = await verifyAssertion({ kind: 'committed' }, p, baseline)
    expect(v.status).toBe('contradicted')
    expect((v as { detail: string }).detail).toContain('b.py')
  })

  test('an untracked file does not contradict "committed"', async () => {
    // Scratch files predate the task and are none of this assertion's business.
    // Failing on them would fire on every task forever, and a check that always
    // fires teaches nothing.
    const p = gitProbe(dir)
    const baseline = await p.head()
    writeFileSync(join(dir, 'a.py'), 'print(99)\n')
    git('add', 'a.py')
    git('commit', '-qm', 'change')
    writeFileSync(join(dir, 'scratch.md'), 'notes\n')
    expect((await verifyAssertion({ kind: 'committed' }, p, baseline)).status).toBe('confirmed')
  })

  test('a staged-but-uncommitted file contradicts "committed"', async () => {
    // `git add` is not `git commit`. The index is still the working tree.
    const p = gitProbe(dir)
    const baseline = await p.head()
    writeFileSync(join(dir, 'a.py'), 'print(99)\n')
    git('add', 'a.py')
    git('commit', '-qm', 'change')
    writeFileSync(join(dir, 'b.py'), 'print(98)\n')
    git('add', 'b.py')
    const v = await verifyAssertion({ kind: 'committed' }, p, baseline)
    expect(v.status).toBe('contradicted')
    expect((v as { detail: string }).detail).toContain('b.py')
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

/**
 * F34: a withheld command is the held-out gate, and the failure message named it.
 *
 * `HELD_OUT_GATE_TEXT` promises the model "it is not yours to run and you are
 * not told what it is". Every one of the three non-passing outcomes then
 * interpolated `check.command` into the detail the model reads, so one
 * ContractAssertPass on a gate that had not been satisfied yet handed over the
 * gate's path — and a gate is a file. Wave 8b's gate lists all 22 mutation
 * anchors and their replacements; a model that reads it can write tests that
 * pin those 22 strings and nothing else, which is the exact failure two prior
 * waves (L4.6d, 7i) were dispatched to correct.
 *
 * The redaction is only on WITHHELD commands. A visible `Verification command
 * exits 0: <cmd>` assertion names its command in its own text, so hiding it
 * from the failure message would help nobody.
 */
describe('verifyAssertion — a withheld command is not named in its own failure (F34)', () => {
  const gate = 'python C:/tmp/verify_ui8b.py C:/Users/civer/civkings'
  const withheld = { kind: 'command', command: gate, withheld: true } as const
  const visible = { kind: 'command', command: gate } as const
  const outcomes = ['failed', 'timeout', 'unrunnable'] as const

  for (const outcome of outcomes) {
    test(`withheld + ${outcome}: the detail does not leak the command`, async () => {
      const v = await verifyAssertion(withheld, probe({ run: async () => outcome }), 'aaaaaaaa')
      expect(v.status).not.toBe('confirmed')
      const detail = (v as { detail: string }).detail
      expect(detail, `leaked the gate: ${detail}`).not.toContain('verify_ui8b')
      expect(detail).not.toContain(gate)
      // Silence is not the fix either — the model must still learn WHY it was
      // refused, or it retries the same assertion forever.
      expect(detail.length).toBeGreaterThan(20)
    })

    test(`visible + ${outcome}: the command IS named, because the text already names it`, async () => {
      const v = await verifyAssertion(visible, probe({ run: async () => outcome }), 'aaaaaaaa')
      expect((v as { detail: string }).detail).toContain(gate)
    })
  }

  test('a withheld command that passes is confirmed, exactly as a visible one is', async () => {
    const v = await verifyAssertion(withheld, probe({ run: async () => 'passed' }), 'aaaaaaaa')
    expect(v.status).toBe('confirmed')
  })
})
