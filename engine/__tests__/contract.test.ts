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
})

describe('contractAssertPassTool.execute', () => {
  beforeEach(() => {
    globalContract.clear()
    globalContract.create('T', '', ['a', 'b'])
  })

  it('passes an assertion and increments enforcementRounds', async () => {
    const result = await contractAssertPassTool.execute({ index: 0, evidence: 'done' }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[PASS]')
    expect(globalContract.enforcementRounds).toBe(1)
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

  it('fails an assertion and increments enforcementRounds', async () => {
    const result = await contractAssertFailTool.execute({ index: 1, evidence: 'broken' }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[FAIL]')
    expect(globalContract.enforcementRounds).toBe(1)
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
