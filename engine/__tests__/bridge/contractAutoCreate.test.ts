// P4.2: contract origination — intent-classified auto-create (with stale-
// complete rollover, STATE doc Phase 4(a)) and harness-supplied contracts.
// Pure unit tests against an injected ContractState (no loop spin-up).
import { describe, expect, it } from 'vitest'
import { ContractState } from '../../tools/contract.js'
import {
  applyHarnessContract,
  maybeAutoCreateContract,
} from '../../bridge/contractAutoCreate.js'

describe('maybeAutoCreateContract (P4.2)', () => {
  it('edit message → file-modified assertion + commit assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('fix the parser in engine/parser.ts', c)).toBe(true)
    const snap = c.snapshot()
    expect(snap.active).toBe(true)
    expect(snap.assertions.map(a => a.text)).toEqual([
      'File engine/parser.ts was modified (git diff shows changes)',
      'Changes committed to git',
    ])
  })

  it('create-file message → file-exists assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('create a new file utils/helper.ts with helpers', c)).toBe(true)
    expect(c.snapshot().assertions[0].text).toBe('File utils/helper.ts exists after changes')
  })

  it('analysis message → answer assertions', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('explain how the streaming translator works', c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Analysis or answer was provided to the user',
      'Response directly addresses what the user asked',
    ])
  })

  it('run message → execution assertions', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('run the full suite now please', c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Command was executed',
      'Output or result was reported to the user',
    ])
  })

  it('general message → single default assertion', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('hello there my good friend', c)).toBe(true)
    expect(c.snapshot().assertions.map(a => a.text)).toEqual([
      'Task was completed — user request fully addressed',
    ])
  })

  it('short message (≤15 chars) → no contract', () => {
    const c = new ContractState()
    expect(maybeAutoCreateContract('fix bug', c)).toBe(false)
    expect(c.snapshot().active).toBe(false)
  })

  it('INCOMPLETE active contract is kept (live task / follow-up)', () => {
    const c = new ContractState()
    c.create('original task', 'brief', ['still pending'])
    expect(maybeAutoCreateContract('also update the readme documentation', c)).toBe(false)
    expect(c.snapshot().title).toBe('original task')
  })

  it('COMPLETE active contract is replaced (P4.2 rollover — taskError must measure the current task)', () => {
    const c = new ContractState()
    c.create('finished task', 'brief', ['done'])
    c.assertPass(0)
    expect(c.isComplete()).toBe(true)
    expect(maybeAutoCreateContract('explain how the streaming translator works', c)).toBe(true)
    expect(c.snapshot().title).toBe('explain how the streaming translator works')
    expect(c.snapshot().assertions.every(a => a.status === 'pending')).toBe(true)
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
