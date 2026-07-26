import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalContract, contractCreateTool, contractAssertPassTool } from './contract.js'
import { COMMITTED_ASSERTION, fileModifiedAssertion } from './contractVerify.js'

describe('contract enforcer budget', () => {
  beforeEach(async () => {
    await contractCreateTool.execute({
      title: 'budget test',
      assertions: ['a one', 'a two', 'a three', 'a four', 'a five'],
    })
  })

  test('marking assertions does not consume enforcementRounds', async () => {
    expect(globalContract.enforcementRounds).toBe(0)
    for (let i = 0; i < 5; i++) {
      await contractAssertPassTool.execute({ index: i })
    }
    expect(globalContract.enforcementRounds).toBe(0)
  })
})

// The live failure this guards: a run that made zero edits marked all four of
// its assertions PASSED on evidence that was merely plausible prose, and the
// task reported complete. The repository could have answered every one of them.
describe('ContractAssertPass is checked against the repository', () => {
  let dir: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'contract-'))
    git('init', '-q')
    git('config', 'user.email', 't@t.t')
    git('config', 'user.name', 'T')
    writeFileSync(join(dir, 'grip.py'), 'print(1)\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    await contractCreateTool.execute({
      title: 'fix grip.py',
      assertions: [fileModifiedAssertion('grip.py'), COMMITTED_ASSERTION],
    })
    globalContract.setBaseline(git('rev-parse', 'HEAD').trim())
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('an untouched file cannot be asserted modified, whatever the evidence says', async () => {
    const r = await contractAssertPassTool.execute(
      { index: 0, evidence: 'grip.py refers to gilded/grip.py' },
      dir,
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('contradicts')
    expect(globalContract.snapshot().assertions[0].status).toBe('pending')
  })

  test('a pre-existing commit cannot be asserted as this task committing', async () => {
    const r = await contractAssertPassTool.execute({ index: 1, evidence: 'committed as 1166a60' }, dir)
    expect(r.isError).toBe(true)
    expect(globalContract.isComplete()).toBe(false)
  })

  test('real work is accepted', async () => {
    writeFileSync(join(dir, 'grip.py'), 'print(99)\n')
    git('add', '.')
    git('commit', '-qm', 'fix')
    expect((await contractAssertPassTool.execute({ index: 0 }, dir)).isError).toBe(false)
    expect((await contractAssertPassTool.execute({ index: 1 }, dir)).isError).toBe(false)
    expect(globalContract.isComplete()).toBe(true)
  })

  test('outside a repo the pass is recorded but flagged unverified, not silently counted', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'contract-nogit-'))
    try {
      const r = await contractAssertPassTool.execute({ index: 1, evidence: 'done' }, plain)
      expect(r.isError).toBe(false)
      expect(globalContract.snapshot().assertions[1].evidence).toContain('[unverified:')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
