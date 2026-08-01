import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalContract, contractCreateTool, contractAssertPassTool } from './contract.js'
import { COMMITTED_ASSERTION, fileModifiedAssertion, commandAssertion } from './contractVerify.js'

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

/**
 * F34, wired end to end.
 *
 * `verifyAssertion` honouring a `withheld` flag is worth nothing if the flag is
 * never set in production — finding (ag) was exactly that shape, a guard
 * connected to no caller. This drives the real tool with a real harness
 * contract carrying a withheld command that fails, and reads the string the
 * model would actually be shown.
 */
describe('a withheld command is not leaked by the refusal the model reads (F34)', () => {
  let dir: string
  // Exits non-zero on every platform's shell without depending on a binary.
  const gate = 'python -c "import sys; sys.exit(3)"'

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'contract-f34-'))
    globalContract.create('wave', '', [{ text: 'The held-out gate exits 0.', command: gate }], 'harness')
    globalContract.setBaseline(null)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('the refusal says the gate answered no, and does not say what the gate is', async () => {
    const r = await contractAssertPassTool.execute({ index: 0, evidence: 'done' }, dir)
    expect(r.isError).toBe(true)
    expect(r.output, `leaked: ${r.output}`).not.toContain('sys.exit')
    expect(r.output).not.toContain(gate)
    expect(r.output).toContain('did not exit 0')
    expect(globalContract.snapshot().assertions[0].status).toBe('pending')
  })

  test('a VISIBLE command assertion still names its command — its own text already does', async () => {
    globalContract.create('wave', '', [commandAssertion(gate)], 'harness')
    globalContract.setBaseline(null)
    const r = await contractAssertPassTool.execute({ index: 0, evidence: 'done' }, dir)
    expect(r.isError).toBe(true)
    expect(r.output).toContain('sys.exit')
  })
})
