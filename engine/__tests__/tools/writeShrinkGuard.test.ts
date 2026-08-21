import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { writeTool } from '../../tools/impl/write.js'

// On the L4.2b run a single Write replaced a 73-case test file with a 4-case
// one. The advisory in toolHints.ts fired and the model wrote anyway; nothing
// structural stopped it. Only the post-hoc census assertion would have caught a
// commit in that state. The file survived because the model happened to notice
// and `git checkout --` it.

const big = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `def test_case_${i}():\n    assert True\n`).join('')

describe('Write refuses to silently truncate an existing file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'writeguard-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('refuses a write that drops most of a substantial file, and leaves it intact', async () => {
    const path = join(dir, 'test_suite.py')
    const original = big(80)
    writeFileSync(path, original)

    const res = await writeTool.execute({ file_path: path, content: big(4) }, dir)

    expect(res.isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('names both byte counts so the size of the loss is visible in the transcript', async () => {
    const path = join(dir, 'test_suite.py')
    const original = big(80)
    writeFileSync(path, original)
    const shrunk = big(4)

    const res = await writeTool.execute({ file_path: path, content: shrunk }, dir)

    expect(res.output).toContain(String(original.length))
    expect(res.output).toContain(String(shrunk.length))
  })

  it('points at an edit tool rather than just saying no', async () => {
    const path = join(dir, 'test_suite.py')
    writeFileSync(path, big(80))

    const res = await writeTool.execute({ file_path: path, content: big(4) }, dir)

    expect(res.output).toContain('Edit')
  })

  it('allows a rewrite that keeps most of the file', async () => {
    const path = join(dir, 'test_suite.py')
    writeFileSync(path, big(80))
    const revised = big(70)

    const res = await writeTool.execute({ file_path: path, content: revised }, dir)

    expect(res.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(revised)
  })

  it('allows a shrinking write to a small file — churn on a stub is not a loss', async () => {
    const path = join(dir, 'stub.py')
    writeFileSync(path, big(3))

    const res = await writeTool.execute({ file_path: path, content: 'x = 1\n' }, dir)

    expect(res.isError).toBe(false)
  })

  it('allows creating a new file of any size', async () => {
    const res = await writeTool.execute({ file_path: join(dir, 'fresh.py'), content: 'x = 1\n' }, dir)
    expect(res.isError).toBe(false)
  })

  it('deleting the file first is the escape hatch — the refusal is not a wall', async () => {
    const path = join(dir, 'test_suite.py')
    writeFileSync(path, big(80))
    expect((await writeTool.execute({ file_path: path, content: big(4) }, dir)).isError).toBe(true)

    rmSync(path)
    const res = await writeTool.execute({ file_path: path, content: big(4) }, dir)
    expect(res.isError).toBe(false)
  })
})

/**
 * The guard protects HISTORY. A file git has never seen has none.
 *
 * Measured on the Stage 11I money-supply run: nine Write calls were refused,
 * every one of them `probe.py` — the single scratch file that brief, and every
 * brief before it, explicitly mandates ("write ONE probe.py, run it, delete it
 * in the same cut"), and the only name the hygiene gate whitelists. The model
 * was rewriting a 1898-byte probe as an 849-byte one because it wanted to
 * measure something else, which is the workflow working.
 *
 * The refusal's own escape hatch gives the argument away: "delete it first,
 * then write". For an untracked file that is a no-op — nothing is recovered by
 * doing it, no trace is left anywhere git can see. So the guard was charging a
 * Read plus a retry for a ceremony that bought nothing it could name.
 *
 * And the alternative it pushed toward is worse than the cost. Told to use Edit
 * on a probe, a model patches the new measurement in beside the old one; the
 * probe accumulates dead code and prints a number for something it is no longer
 * measuring. A stale probe reporting confidently is how a run reads the wrong
 * figure and commits on it.
 *
 * Unknown still means protect: outside a repository, or with git unavailable,
 * the guard stays on. The exemption requires a positive answer to "git is here
 * and does not know this file".
 */
describe('a file git has never seen has no history to lose', () => {
  let dir: string
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'writeguard-git-'))
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

  it('lets an untracked scratch file be rewritten smaller', async () => {
    const path = join(dir, 'probe.py')
    writeFileSync(path, big(80))
    const smaller = big(4)

    const res = await writeTool.execute({ file_path: path, content: smaller }, dir)

    expect(res.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(smaller)
  })

  it('still refuses to gut a TRACKED file in the same repository', async () => {
    // The measured incident the guard exists for — a 73-case suite replaced by
    // four — happened to a committed file, and must still be refused.
    const path = join(dir, 'test_suite.py')
    const original = big(80)
    writeFileSync(path, original)
    git('add', 'test_suite.py')
    git('commit', '-qm', 'suite')

    const res = await writeTool.execute({ file_path: path, content: big(4) }, dir)

    expect(res.isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('refuses once a scratch file has been staged — git knows it now', async () => {
    // `git add` is the model saying this is work. Tracking, not committing, is
    // the line: the file is recoverable from the index from that moment on.
    const path = join(dir, 'probe.py')
    const original = big(80)
    writeFileSync(path, original)
    git('add', 'probe.py')

    const res = await writeTool.execute({ file_path: path, content: big(4) }, dir)

    expect(res.isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('keeps the guard on outside a repository, where the answer is unknown', async () => {
    // Every other test in this file runs in a bare tmpdir. If "git does not
    // know it" were read from a failed git call rather than a successful one,
    // the guard would be off everywhere git is not, which is most places.
    const bare = mkdtempSync(join(tmpdir(), 'writeguard-norepo-'))
    try {
      const path = join(bare, 'test_suite.py')
      writeFileSync(path, big(80))
      const res = await writeTool.execute({ file_path: path, content: big(4) }, bare)
      expect(res.isError).toBe(true)
    } finally {
      rmSync(bare, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
