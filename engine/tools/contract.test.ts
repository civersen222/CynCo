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

/**
 * F35 end to end: the refusal the model reads must not blame its work.
 *
 * The in-session cap is 300s; Wave 8b's gate needs about thirty minutes. Before
 * this, one ContractAssertPass on the gate told a model with correct work
 * "the repository contradicts it" and sent it back to rewrite code that had
 * never been measured. A wrong reason is worse than no reason: it is actionable.
 */
describe('a check that was killed does not tell the model its work is wrong (F35)', () => {
  let dir: string
  let priorCap: string | undefined
  // Outlives the cap without depending on `sleep` existing on Windows. The
  // `chdir` is cleanup, not behaviour: a killed child goes on holding its cwd
  // on Windows long enough that removing the temp dir is EPERM, so the child
  // steps out of it before it hangs. It is still hung, still killed, still the
  // same code path.
  const slow = 'python -c "import os, tempfile, time; os.chdir(tempfile.gettempdir()); time.sleep(4000)"'

  beforeEach(() => {
    // The real cap is 300s, and waiting it out here would make one test twenty
    // times the whole suite. `commandTimeoutMs` is read per call for exactly
    // this: shorten the cap, not the thing being capped, so the code under test
    // is the same code that runs in a session.
    priorCap = process.env.CYNCO_CONTRACT_CHECK_TIMEOUT_MS
    process.env.CYNCO_CONTRACT_CHECK_TIMEOUT_MS = '2000'
    dir = mkdtempSync(join(tmpdir(), 'contract-f35-'))
    globalContract.create('wave', '', [{ text: 'The held-out gate exits 0.', command: slow }], 'harness')
    globalContract.setBaseline(null)
  })
  afterEach(() => {
    if (priorCap === undefined) delete process.env.CYNCO_CONTRACT_CHECK_TIMEOUT_MS
    else process.env.CYNCO_CONTRACT_CHECK_TIMEOUT_MS = priorCap
    // On Windows the killed python still holds its cwd for a moment after the
    // kill returns, so an immediate unlink is EPERM. Retry rather than skip the
    // cleanup and leave temp dirs behind.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  test('the pass is refused, and the refusal says it was not measured', async () => {
    const r = await contractAssertPassTool.execute({ index: 0, evidence: 'done' }, dir)
    expect(r.isError).toBe(true)
    // Refused, so the gate is never self-certified (finding (ah)).
    expect(globalContract.snapshot().assertions[0].status).toBe('pending')
    expect(r.output).toContain('could not be measured')
    // And it does not claim a verdict nobody took.
    expect(r.output, `blamed the work: ${r.output}`).not.toContain('the repository contradicts it')
    expect(r.output).toContain('says nothing about whether your work is correct')
    // Still withheld (F34).
    expect(r.output).not.toContain('time.sleep')
  }, 30_000)
})

/**
 * The cap travels with the check, wired end to end through the real tool.
 *
 * The env fallback alone cannot fix Wave 9d: the mission driver is a WebSocket
 * client to a separate engine daemon, so a cap it exports is invisible to the
 * process that runs the check. Here NEITHER variable is set, so the default is
 * 300s — and the gate is killed in about two seconds because the assertion
 * itself said two seconds. If the cap did not survive the tool path, this test
 * would sit for five minutes and then fail on its own timeout.
 */
describe('a slow gate declares its own cap, and the cap reaches the runner', () => {
  let dir: string
  const saved = {
    contract: process.env.CYNCO_CONTRACT_CHECK_TIMEOUT_MS,
    driver: process.env.CYNCO_CHECK_TIMEOUT_MS,
  }
  // Same shape as F35's: outlives any cap, and steps out of the temp dir first
  // so the kill does not leave Windows holding the cwd against cleanup.
  const slow = 'python -c "import os, tempfile, time; os.chdir(tempfile.gettempdir()); time.sleep(4000)"'

  beforeEach(() => {
    delete process.env.CYNCO_CONTRACT_CHECK_TIMEOUT_MS
    delete process.env.CYNCO_CHECK_TIMEOUT_MS
    dir = mkdtempSync(join(tmpdir(), 'contract-cap-'))
    globalContract.create(
      'wave', '', [{ text: 'The held-out gate exits 0.', command: slow, timeoutMs: 2000 }], 'harness')
    globalContract.setBaseline(null)
  })
  afterEach(() => {
    for (const [k, v] of [
      ['CYNCO_CONTRACT_CHECK_TIMEOUT_MS', saved.contract],
      ['CYNCO_CHECK_TIMEOUT_MS', saved.driver],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  test('the check is killed at the cap the assertion declared, not at the default', async () => {
    const started = Date.now()
    const r = await contractAssertPassTool.execute({ index: 0, evidence: 'done' }, dir)
    const elapsed = Date.now() - started
    expect(r.isError).toBe(true)
    expect(globalContract.snapshot().assertions[0].status).toBe('pending')
    expect(r.output).toContain('could not be measured')
    // The declared cap, reported honestly — not the 300s nobody applied.
    expect(r.output).toContain('2s')
    expect(elapsed, `waited ${elapsed}ms, so the declared cap did not govern`).toBeLessThan(60_000)
  }, 90_000)
})
