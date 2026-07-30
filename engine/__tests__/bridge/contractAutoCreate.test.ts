// P4.2: contract origination — intent-classified auto-create (with stale-
// complete rollover, STATE doc Phase 4(a)) and harness-supplied contracts.
// Pure unit tests against an injected ContractState (no loop spin-up).
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { ContractState } from '../../tools/contract.js'
import {
  applyHarnessContract,
  harnessContractCommandError,
  harnessGatePaths,
  maybeAutoCreateContract,
} from '../../bridge/contractAutoCreate.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

/** A workspace containing exactly `files` — the repository the assertions are about. */
function workspace(...files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'cynco-contract-'))
  dirs.push(d)
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true })
    writeFileSync(join(d, f), '# content\n', 'utf-8')
  }
  return d
}

describe('maybeAutoCreateContract (P4.2)', () => {
  it('edit message → file-modified assertion + commit assertion', () => {
    const c = new ContractState()
    const cwd = workspace('engine/parser.ts')
    expect(maybeAutoCreateContract('fix the parser in engine/parser.ts', cwd, c)).toBe(true)
    const snap = c.snapshot()
    expect(snap.active).toBe(true)
    expect(snap.assertions.map(a => a.text)).toEqual([
      'File engine/parser.ts was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  it('create-file message → file-exists assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('create a new file utils/helper.ts with helpers', workspace(), c)).toBe(true)
    expect(c.snapshot().assertions[0].text).toBe('File utils/helper.ts exists after changes')
  })

  it('analysis message → answer assertions', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('explain how the streaming translator works', workspace(), c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Analysis or answer was provided to the user',
      'Response directly addresses what the user asked',
    ])
  })

  it('run message → execution assertions', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('run the full suite now please', workspace(), c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Command was executed',
      'Output or result was reported to the user',
    ])
  })

  it('general message → single default assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('hello there my good friend', workspace(), c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Task was completed — user request fully addressed',
    ])
  })

  it('short message (≤15 chars) → no contract', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('fix bug', workspace(), c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  it('INCOMPLETE active contract is kept (live task / follow-up)', () => {
    const c = new ContractState()
    c.create('original task', 'brief', ['still pending'])
    expect(maybeAutoCreateContract('also update the readme documentation', workspace(), c)).toBe(false)
    expect(c.snapshot().title).toBe('original task')
  })

  it('COMPLETE active contract is replaced (P4.2 rollover — taskError must measure the current task)', () => {
    const c = new ContractState()
    c.create('finished task', 'brief', ['done'])
    c.assertPass(0)
    expect(c.isComplete()).toBe(true)
    expect(maybeAutoCreateContract('explain how the streaming translator works', workspace(), c)).toBe(true)
    expect(c.snapshot().title).toBe('explain how the streaming translator works')
    expect(c.snapshot().assertions.every(a => a.status === 'pending')).toBe(true)
  })
})

/**
 * The generator used to mine every filename-shaped token out of the message and
 * assert on it unchecked. Now that ContractAssertPass answers these against the
 * repository, a token that names no real file becomes an assertion nothing can
 * ever satisfy — the task can never be closed honestly, and the run is scored as
 * incomplete work that was in fact done.
 *
 * The live case: a correction message said "gilded/grip.py" throughout and
 * "grip.py" once in passing. The generator produced an assertion for a
 * root-level grip.py that has never existed, and the model burned its remaining
 * turns arguing with it.
 */
describe('assertions are grounded in the workspace at creation time', () => {
  it('a bare filename that names no real file is not asserted on', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py')
    maybeAutoCreateContract(
      'fix the disloyalty rule in gilded/grip.py — note grip.py duplicates it',
      cwd,
      c,
    )
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'File gilded/grip.py was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  it('a missing path is asserted on only when the message asks for it to be created', () => {
    const c = new ContractState()
    maybeAutoCreateContract('write a new file gilded/ledger.py for the books', workspace(), c)
    expect(c.snapshot().assertions[0].text).toBe('File gilded/ledger.py exists after changes')
  })

  it('an existing path takes the modified assertion even in a create-flavoured message', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py')
    maybeAutoCreateContract('write the missing branch into gilded/grip.py', cwd, c)
    expect(c.snapshot().assertions[0].text)
      .toBe('File gilded/grip.py was modified (git diff shows changes)')
  })

  /**
   * The create-intent used to be a flag over the whole message: if the word
   * "write" or "create" appeared anywhere, every filename-shaped token naming
   * nothing on disk became "File X exists after changes". Every TDD instruction
   * contains "write the test first", so on the live L2b run a correction message
   * about `gilded/grip.py` — which mentions the bare basename `grip.py` a dozen
   * times in prose — produced an assertion that a root-level `grip.py` would
   * exist. The model burned four turns proving to itself that no such file was
   * ever meant to exist, then tried to close the assertion with the wrong path.
   *
   * The verb has to be attached to the filename, not loose in the paragraph.
   */
  it('a create verb elsewhere in the message does not conjure an unrelated file', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py')
    maybeAutoCreateContract(
      'Fix the disloyalty rule in gilded/grip.py. For each item: write the test FIRST, '
      + 'run it, confirm it fails. Do not solve this by copying the rule into grip.py.',
      cwd,
      c,
    )
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'File gilded/grip.py was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  /**
   * Watched live on L2f. The brief's first task was "Delete `realm_eb29375.py`
   * from the repo root" — a scratch file the previous run had left behind. The
   * generator saw a change verb in the sentence and asserted "File
   * realm_eb29375.py was modified (git diff shows changes)". The file was
   * untracked, so no git diff could ever show a change to it, and once deleted it
   * did not exist at all: an unsatisfiable assertion attached to the one
   * instruction CynCo carried out correctly within seconds. It read the assertion
   * and rationalised — "this means the file should be deleted (modification
   * includes deletion)" — which happens to be right here and would be wrong in
   * general.
   *
   * The intent is absence, so the assertion has to be about absence.
   */
  it('asking for a file to be deleted asserts its absence, not a diff', () => {
    const c = new ContractState()
    const cwd = workspace('realm_eb29375.py')
    maybeAutoCreateContract('Delete `realm_eb29375.py` from the repo root.', cwd, c)
    expect(c.snapshot().assertions[0].text).toBe('File realm_eb29375.py no longer exists after changes')
  })

  it('recognizes the plain unquoted form', () => {
    const c = new ContractState()
    const cwd = workspace('scratch.py')
    maybeAutoCreateContract('remove scratch.py, it should never have been committed', cwd, c)
    expect(c.snapshot().assertions[0].text).toBe('File scratch.py no longer exists after changes')
  })

  /**
   * The distinction that makes this safe: a delete verb whose object is something
   * INSIDE the file is a mandate to edit the file, not to remove it. Both phrasings
   * put "delete" and a path in one sentence, so sentence scope cannot separate
   * them — adjacency can.
   */
  it('deleting something INSIDE a file is still a modify mandate', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py')
    maybeAutoCreateContract('delete the fallback branch in gilded/grip.py', cwd, c)
    expect(c.snapshot().assertions[0].text).toBe('File gilded/grip.py was modified (git diff shows changes)')
  })

  it('and so is stripping the unused imports out of one', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py')
    maybeAutoCreateContract('gilded/grip.py — remove the unused imports at the top', cwd, c)
    expect(c.snapshot().assertions[0].text).toBe('File gilded/grip.py was modified (git diff shows changes)')
  })

  it('does not conjure an absence assertion for a file that is already gone', () => {
    // Nothing to ask for: the workspace does not have it, and "delete X" is not a
    // request to bring X into existence either.
    const c = new ContractState()
    maybeAutoCreateContract('delete stale_scratch.py from the root', workspace(), c)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Code was modified to address the task',
      'Changes committed to git',
    ])
  })

  it('the create verb still counts when it is attached to the filename', () => {
    const c = new ContractState()
    maybeAutoCreateContract(
      'Read the whole brief before you start. Then create gilded/ledger.py for the books.',
      workspace(),
      c,
    )
    expect(c.snapshot().assertions[0].text).toBe('File gilded/ledger.py exists after changes')
  })

  /**
   * The existing-file branch had no verb check at all: any real path named
   * anywhere in the message became "was modified". A fix-list that PRAISED CynCo
   * for reverting an edit to gilded/society/realm.py therefore asserted that
   * realm.py must be modified, and on the live L2d run the model spent turns
   * insisting "The contract says realm.py should be modified... but realm.py has
   * no changes" while trying to reconcile a mandate to edit a file it had been
   * commended for leaving alone. Mentioning a file is not asking for it.
   */
  it('a file mentioned only in praise is not asserted on', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py', 'gilded/society/realm.py')
    maybeAutoCreateContract(
      'DELETE the fallback branch in gilded/grip.py. At 21:14 you flipped an opinion '
      + 'key in gilded/society/realm.py, then reverted it unprompted; nice catch.',
      cwd,
      c,
    )
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'File gilded/grip.py was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  it('a file the message says to leave alone is not asserted on', () => {
    const c = new ContractState()
    const cwd = workspace('gilded/grip.py', 'gilded/market.py')
    maybeAutoCreateContract(
      'Refactor gilded/grip.py. Leave gilded/market.py exactly as it is.',
      cwd,
      c,
    )
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'File gilded/grip.py was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  it('when every mined path is prose, falls back to the generic assertion', () => {
    const c = new ContractState()
    maybeAutoCreateContract('fix whatever is wrong in nowhere/absent.py today', workspace(), c)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Code was modified to address the task',
      'Changes committed to git',
    ])
  })
})

/**
 * The commit assertion used to be appended to every edit task unconditionally,
 * including tasks that said in as many words not to commit. That puts the model
 * between the user's instruction and the engine's contract, and the engine wins:
 * on the live L2 run the model committed against an explicit order and then
 * cited its own forbidden commit as the evidence that the contract was met.
 *
 * The engine does not get to overrule the user about what the task is.
 */
describe('the commit assertion respects a do-not-commit instruction', () => {
  const texts = [
    'fix the rule in gilded/grip.py. Do not commit.',
    "fix the rule in gilded/grip.py — don't commit, I'll do that",
    'fix the rule in gilded/grip.py without committing anything',
  ]

  for (const text of texts) {
    it(`no commit assertion for: ${text.slice(-28)}`, () => {
      const c = new ContractState()
      maybeAutoCreateContract(text, workspace('gilded/grip.py'), c)
      expect(c.snapshot().assertions.map(a => a.text)).toEqual([
        'File gilded/grip.py was modified (git diff shows changes)',
      ])
    })
  }

  it('an ordinary edit task still asserts the commit', () => {
    const c = new ContractState()
    maybeAutoCreateContract('fix the rule in gilded/grip.py please', workspace('gilded/grip.py'), c)
    expect(c.snapshot().assertions.map(a => a.text)).toContain('Changes committed to git')
  })
})

describe('applyHarnessContract (P4.2)', () => {
  it('valid spec → contract created verbatim', () => {
    const c = new ContractState()
    const ok = applyHarnessContract(
      { title: 'Mission: m1', brief: 'the brief', assertions: ['Verification command exits 0: exit 0'] },
      c,
    )
    expect(ok).toBe(true)
    const snap = c.snapshot()
    expect(snap.title).toBe('Mission: m1')
    expect(snap.brief).toBe('the brief')
    expect(snap.assertions.map(a => a.text)).toEqual(['Verification command exits 0: exit 0'])
  })

  it('empty assertions → rejected, no contract', () => {
    const c = new ContractState()
    expect(applyHarnessContract({ title: 't', assertions: [] }, c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  it('missing title or undefined spec → rejected', () => {
    const c = new ContractState()
    expect(applyHarnessContract({ title: '', assertions: ['a'] }, c)).toBe(false)
    expect(applyHarnessContract(undefined, c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  /**
   * The Gilded L4.1d contract carried
   * `Verification command exits 0: python C:/tmp/bite41d.py  (every mutation ...)`.
   * The trailing parenthetical was prose I wrote to explain the check; PowerShell
   * read it as a call to a command named `every`, so the assertion could not pass
   * however well the work was done. The agent spent ~60 turns on it and finally
   * put an `every` stub on PATH. A contract the agent cannot satisfy by working
   * must not be accepted in the first place.
   */
  const L41D = 'Verification command exits 0: python C:/tmp/bite41d.py  (every mutation in the L4.1 set turns the shipped test suite red)'

  it('refuses the whole contract when a verification command cannot run', () => {
    const c = new ContractState()
    const ok = applyHarnessContract(
      { title: 'L4.1d', assertions: ['Code was modified', L41D] },
      c,
      // Injected so the verdict does not depend on which shell runs the suite;
      // shellInfo.test.ts proves the real validator against the real shell.
      () => 'unknown command: every',
    )
    expect(ok).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  it('names the offending assertion, not just the command', () => {
    const err = harnessContractCommandError([L41D], () => 'unknown command: every')
    expect(err).toContain('every mutation in the L4.1 set')
    expect(err).toContain('unknown command: every')
  })

  it('ignores assertions that are not verification commands', () => {
    expect(harnessContractCommandError(
      ['Code was modified to address the task', 'Changes were committed to git'],
      () => 'should never be consulted',
    )).toBeNull()
  })

  it('accepts a contract whose commands all validate', () => {
    const c = new ContractState()
    expect(applyHarnessContract(
      { title: 'ok', assertions: ['Verification command exits 0: python C:/tmp/gate.py'] },
      c,
      () => null,
    )).toBe(true)
    expect(c.snapshot().active).toBe(true)
  })
})

/**
 * Finding (ag), Gilded UI Wave 0b: the agent ran `Edit` on C:/tmp/verify_ui0.py
 * — the gate script named in its own contract assertions — and nothing objected.
 * A run that can edit the thing that scores it cannot be scored.
 */
describe('harnessGatePaths: the instruments a contract names', () => {
  const gate = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), 'cynco-gate-'))
    dirs.push(d)
    const f = join(d, p)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, '# gate\n', 'utf-8')
    return { dir: d, file: f.replace(/\\/g, '/') }
  }

  it('finds the gate script a verification command runs', () => {
    const { file } = gate('verify.py')
    const found = harnessGatePaths(
      [`Verification command exits 0: python ${file} the_suite_is_green`],
      workspace('src/app.ts'),
    )
    expect(found).toEqual([file])
  })

  /**
   * The boundary the whole design rests on. `python -m pytest gilded/tests -q`
   * is a verification command that names a path, and that path is exactly the
   * code the agent was sent to edit. Locking it would break every task.
   */
  it('never protects a path inside the workspace, however the command spells it', () => {
    const ws = workspace('gilded/tests/test_ui.py')
    expect(harnessGatePaths(
      ['Verification command exits 0: python -m pytest gilded/tests -q'], ws,
    )).toEqual([])
    expect(harnessGatePaths(
      [`Verification command exits 0: python -m pytest ${ws.replace(/\\/g, '/')}/gilded/tests -q`], ws,
    )).toEqual([])
  })

  it('ignores path-shaped tokens that are not on disk', () => {
    expect(harnessGatePaths(
      ['Verification command exits 0: python C:/tmp/does-not-exist-9f3a.py'],
      workspace('a.ts'),
    )).toEqual([])
  })

  it('ignores flags, bare program names, and non-command assertions', () => {
    const { file } = gate('g.py')
    const found = harnessGatePaths([
      'Changes committed to git',
      'File gilded/ui/broadsheet.py was modified (git diff shows changes)',
      `Verification command exits 0: GILDED_NARRATE=0 python ${file} -q --tb=short`,
    ], workspace('gilded/ui/broadsheet.py'))
    expect(found).toEqual([file])
  })

  it('strips surrounding quotes and trailing punctuation', () => {
    const { file } = gate('g.py')
    const found = harnessGatePaths(
      [`Verification command exits 0: python "${file}"`],
      workspace('a.ts'),
    )
    expect(found).toEqual([file])
  })

  it('reports each instrument once even when several checks run it', () => {
    const { file } = gate('g.py')
    const found = harnessGatePaths([
      `Verification command exits 0: python ${file} check_one`,
      `Verification command exits 0: python ${file} check_two`,
    ], workspace('a.ts'))
    expect(found).toEqual([file])
  })
})
