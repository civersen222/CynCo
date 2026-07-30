import { describe, it, expect, beforeEach } from 'bun:test'
import {
  ContractState,
  globalContract,
  contractCreateTool,
  contractAssertPassTool,
  contractAssertFailTool,
  contractStatusTool,
} from '../tools/contract.js'

describe('ContractState', () => {
  let c: ContractState

  beforeEach(() => {
    c = new ContractState()
  })

  it('creates a contract with all assertions pending', () => {
    c.create('My Task', 'Do the thing', ['assertion A', 'assertion B', 'assertion C'])
    expect(c.isActive()).toBe(true)
    expect(c.pendingCount()).toBe(3)
    expect(c.failedCount()).toBe(0)
  })

  it('marks an assertion as passed', () => {
    c.create('T', '', ['a', 'b'])
    c.assertPass(0, 'looks good')
    expect(c.pendingCount()).toBe(1)
    expect(c.failedCount()).toBe(0)
  })

  it('marks an assertion as failed with evidence', () => {
    c.create('T', '', ['a', 'b'])
    c.assertFail(1, 'broke it')
    expect(c.failedCount()).toBe(1)
    expect(c.pendingCount()).toBe(1)
  })

  it('marks an assertion as skipped', () => {
    c.create('T', '', ['a', 'b', 'c'])
    c.assertSkip(2, 'not applicable')
    expect(c.pendingCount()).toBe(2)
    expect(c.failedCount()).toBe(0)
  })

  it('isComplete returns false when assertions are still pending', () => {
    c.create('T', '', ['a', 'b'])
    c.assertPass(0)
    expect(c.isComplete()).toBe(false)
  })

  it('isComplete returns true when all assertions are passed', () => {
    c.create('T', '', ['a', 'b'])
    c.assertPass(0)
    c.assertPass(1)
    expect(c.isComplete()).toBe(true)
  })

  it('isComplete returns true when all assertions are passed or skipped', () => {
    c.create('T', '', ['a', 'b', 'c'])
    c.assertPass(0)
    c.assertSkip(1, 'n/a')
    c.assertPass(2)
    expect(c.isComplete()).toBe(true)
  })

  it('isComplete returns false when a failed assertion exists', () => {
    c.create('T', '', ['a', 'b'])
    c.assertPass(0)
    c.assertFail(1, 'broken')
    expect(c.isComplete()).toBe(false)
  })

  it('getStatus returns formatted output containing title and assertion state', () => {
    c.create('Wire Check', 'Verify wiring', ['imports added', 'tests pass'])
    c.assertPass(0, 'grep confirms import')
    const status = c.getStatus()
    expect(status).toContain('Wire Check')
    expect(status).toContain('[PASS]')
    expect(status).toContain('imports added')
    expect(status).toContain('[    ]')
    expect(status).toContain('tests pass')
  })

  it('getStatus returns "No active contract." when no contract exists', () => {
    expect(c.getStatus()).toBe('No active contract.')
  })

  it('clear resets all state', () => {
    c.create('T', '', ['a'])
    c.clear()
    expect(c.isActive()).toBe(false)
    expect(c.getStatus()).toBe('No active contract.')
  })

  it('enforcementRounds starts at 0', () => {
    c.create('T', '', ['a'])
    expect(c.enforcementRounds).toBe(0)
  })

  it('out-of-range index is silently ignored', () => {
    c.create('T', '', ['a'])
    c.assertPass(99)  // should not throw
    expect(c.pendingCount()).toBe(1)
  })

  it('snapshot reflects title, brief, completion and assertion states', () => {
    c.create('Title', 'Brief text', ['a', 'b'])
    c.assertPass(0, 'ev')
    const s = c.snapshot()
    expect(s.title).toBe('Title')
    expect(s.brief).toBe('Brief text')
    expect(s.active).toBe(true)
    expect(s.complete).toBe(false)
    expect(s.assertions.length).toBe(2)
    expect(s.assertions[0]).toEqual({ text: 'a', status: 'passed', evidence: 'ev' })
    expect(s.assertions[1].status).toBe('pending')
  })

  it('snapshot is a copy — mutating it does not affect the contract', () => {
    c.create('T', '', ['a'])
    const s = c.snapshot()
    s.assertions[0].status = 'passed'
    expect(c.pendingCount()).toBe(1)
  })

  it('snapshot of an inactive contract is inactive with no assertions', () => {
    const s = c.snapshot()
    expect(s.active).toBe(false)
    expect(s.assertions.length).toBe(0)
  })

  it('resolveUnverified fails every pending assertion and returns their texts', () => {
    c.create('T', '', ['a', 'b', 'c'])
    c.assertPass(0)
    const forced = c.resolveUnverified()
    expect(forced).toEqual(['b', 'c'])
    expect(c.failedCount()).toBe(2)
    expect(c.pendingCount()).toBe(0)
  })

  it('resolveUnverified leaves passed and skipped assertions untouched', () => {
    c.create('T', '', ['a', 'b', 'c'])
    c.assertPass(0, 'verified')
    c.assertSkip(1, 'n/a')
    c.resolveUnverified()
    expect(c.failedCount()).toBe(1)
    expect(c.isComplete()).toBe(false)
  })

  it('resolveUnverified records why the assertion was failed', () => {
    c.create('T', '', ['a'])
    c.resolveUnverified()
    expect(c.getStatus()).toMatch(/never verified/i)
  })

  it('resolveUnverified on a fully passed contract changes nothing', () => {
    c.create('T', '', ['a'])
    c.assertPass(0)
    expect(c.resolveUnverified()).toEqual([])
    expect(c.isComplete()).toBe(true)
  })

  it('resolveUnverified deactivates the contract so a new one can replace it', () => {
    c.create('T', '', ['a', 'b'])
    c.resolveUnverified()
    expect(c.isActive()).toBe(false)
  })

  it('resolveUnverified on an already-complete contract leaves it active', () => {
    c.create('T', '', ['a'])
    c.assertPass(0)
    c.resolveUnverified()
    expect(c.isActive()).toBe(true)
    expect(c.isComplete()).toBe(true)
  })

  it('create re-enables enforcement disabled by a previous contract', () => {
    c.setEnforcementEnabled(false)
    c.create('T', '', ['a'])
    expect(c.isEnforcementEnabled()).toBe(true)
  })

  it('clear re-enables enforcement', () => {
    c.setEnforcementEnabled(false)
    c.clear()
    expect(c.isEnforcementEnabled()).toBe(true)
  })
})

describe('contractCreateTool.execute', () => {
  beforeEach(() => {
    globalContract.clear()
  })

  it('creates a contract and returns status output', async () => {
    const result = await contractCreateTool.execute(
      { title: 'Test Contract', brief: 'brief text', assertions: ['assert 1', 'assert 2'] },
      process.cwd()
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Test Contract')
    expect(result.output).toContain('2 assertion(s)')
    expect(globalContract.isActive()).toBe(true)
  })

  it('returns error when title is missing', async () => {
    const result = await contractCreateTool.execute(
      { title: '', assertions: ['a'] },
      process.cwd()
    )
    expect(result.isError).toBe(true)
  })

  it('returns error when assertions array is empty', async () => {
    const result = await contractCreateTool.execute(
      { title: 'T', assertions: [] },
      process.cwd()
    )
    expect(result.isError).toBe(true)
  })

  /**
   * Gilded L4.1e: the agent decided the harness contract's assertions "appear
   * auto-generated and don't match the actual task", replaced all 35 of them
   * with 5 of its own, and marked every one passed. The work it had already
   * done was good and the labeler declined to credit a self-authored contract
   * — taskCompleted came back 'unknown' — so the cost that run was the
   * measurement, which is the one thing the corpus is starving for.
   *
   * The capability is worse than the cost. A harness contract is the task
   * author's specification; an agent that can replace it can delete any gate
   * it cannot pass, and would score itself against the replacement.
   */
  it('refuses to replace a harness contract', async () => {
    globalContract.create('Harness spec', 'brief', ['Verification command exits 0: exit 0'], 'harness')
    const result = await contractCreateTool.execute(
      { title: 'My own criteria', assertions: ['I decided this instead'] },
      process.cwd()
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/ContractAssertFail/)
    const snap = globalContract.snapshot()
    expect(snap.title).toBe('Harness spec')
    expect(snap.origin).toBe('harness')
    expect(snap.assertions.map(a => a.text)).toEqual(['Verification command exits 0: exit 0'])
  })

  it('says where the assertions came from', () => {
    globalContract.create('H', '', ['a'], 'harness')
    expect(globalContract.getStatus()).toContain('supplied with the task')
    globalContract.clear()
    globalContract.create('A', '', ['a'])
    expect(globalContract.getStatus()).toContain('inferred by the engine')
  })

  it('still replaces an auto contract', async () => {
    globalContract.create('Auto', '', ['guessed from the message'])
    const result = await contractCreateTool.execute(
      { title: 'Sharper', assertions: ['a'] },
      process.cwd()
    )
    expect(result.isError).toBe(false)
    expect(globalContract.snapshot().title).toBe('Sharper')
  })
})

describe('contractAssertPassTool.execute', () => {
  beforeEach(() => {
    globalContract.clear()
    globalContract.create('T', '', ['a', 'b'])
  })

  it('passes an assertion without consuming enforcementRounds', async () => {
    const result = await contractAssertPassTool.execute({ index: 0, evidence: 'done' }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[PASS]')
    // Marking an assertion must NOT burn the enforcer's re-prompt budget;
    // that counter advances only at the genuine enforcer site (conversationLoop).
    expect(globalContract.enforcementRounds).toBe(0)
  })

  it('returns error when no active contract', async () => {
    globalContract.clear()
    const result = await contractAssertPassTool.execute({ index: 0 }, process.cwd())
    expect(result.isError).toBe(true)
  })
})

describe('contractAssertFailTool.execute', () => {
  beforeEach(() => {
    globalContract.clear()
    globalContract.create('T', '', ['a', 'b'])
  })

  it('fails an assertion without consuming enforcementRounds', async () => {
    const result = await contractAssertFailTool.execute({ index: 1, evidence: 'broken' }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[FAIL]')
    // Marking an assertion must NOT burn the enforcer's re-prompt budget;
    // that counter advances only at the genuine enforcer site (conversationLoop).
    expect(globalContract.enforcementRounds).toBe(0)
  })
})

describe('contractStatusTool.execute', () => {
  beforeEach(() => {
    globalContract.clear()
  })

  it('returns "No active contract." when none exists', async () => {
    const result = await contractStatusTool.execute({}, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toBe('No active contract.')
  })

  it('returns formatted status when contract is active', async () => {
    globalContract.create('Status Test', 'check things', ['item 1'])
    const result = await contractStatusTool.execute({}, process.cwd())
    expect(result.output).toContain('Status Test')
    expect(result.output).toContain('item 1')
  })
})

/**
 * `Verification command exits 0: <cmd>` is the harness form, and it is now really
 * executed — which is the only reason a harness contract's `taskCompleted` is a
 * measurement rather than the agent's own account of itself.
 *
 * But assertion text is model-writable through ContractCreate. If the check ran
 * for any contract, the model could author its own assertion and have the engine
 * execute an arbitrary shell string with no approval card — an unapproved Bash
 * call wearing a verification's clothes. So the command only runs when a person
 * wrote it.
 */
describe('a command assertion only runs when a person authored it', () => {
  beforeEach(() => {
    globalContract.clear()
  })

  it('refuses a harness command assertion the workspace contradicts', async () => {
    globalContract.create('Mission', 'brief', ['Verification command exits 0: exit 1'], 'harness')
    const result = await contractAssertPassTool.execute({ index: 0 }, process.cwd())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('did not exit 0')
    expect(globalContract.snapshot().assertions[0].status).toBe('pending')
  })

  it('confirms a harness command assertion that really passes', async () => {
    globalContract.create('Mission', 'brief', ['Verification command exits 0: exit 0'], 'harness')
    const result = await contractAssertPassTool.execute({ index: 0 }, process.cwd())
    expect(result.isError).toBe(false)
    expect(globalContract.snapshot().assertions[0].status).toBe('passed')
  })

  it('does not execute a command the model wrote into its own contract', async () => {
    await contractCreateTool.execute(
      { title: 'self-authored', brief: '', assertions: ['Verification command exits 0: exit 1'] },
      process.cwd(),
    )
    expect(globalContract.getOrigin()).toBe('auto')
    const result = await contractAssertPassTool.execute({ index: 0 }, process.cwd())
    expect(result.isError).toBe(false)
    expect(globalContract.snapshot().assertions[0].status).toBe('passed')
  })
})
