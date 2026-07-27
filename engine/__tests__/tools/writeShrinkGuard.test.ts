import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
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
