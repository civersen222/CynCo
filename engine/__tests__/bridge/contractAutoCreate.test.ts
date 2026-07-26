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
})
