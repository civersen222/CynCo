import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scorePytest } from './scorer.js'

describe('scorePytest', () => {
  it('passes when the injected test passes against the workdir code', () => {
    const work = mkdtempSync(join(tmpdir(), 'truebench-work-'))
    writeFileSync(join(work, 'mod.py'), 'def add(a, b):\n    return a + b\n')
    const hidden = mkdtempSync(join(tmpdir(), 'truebench-hidden-'))
    const hiddenTest = join(hidden, 'hidden_test.py')
    writeFileSync(hiddenTest, 'from mod import add\n\ndef test_add():\n    assert add(2, 3) == 5\n')

    const r = scorePytest(work, hiddenTest, 'hidden_test.py')
    expect(r.passed).toBe(true)
    rmSync(work, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  })

  it('fails when the code does not satisfy the injected test', () => {
    const work = mkdtempSync(join(tmpdir(), 'truebench-work-'))
    writeFileSync(join(work, 'mod.py'), 'def add(a, b):\n    return a - b\n')
    const hidden = mkdtempSync(join(tmpdir(), 'truebench-hidden-'))
    const hiddenTest = join(hidden, 'hidden_test.py')
    writeFileSync(hiddenTest, 'from mod import add\n\ndef test_add():\n    assert add(2, 3) == 5\n')

    const r = scorePytest(work, hiddenTest, 'hidden_test.py')
    expect(r.passed).toBe(false)
    rmSync(work, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  })

  it('cleans up the injected test file from the workdir after scoring', () => {
    const work = mkdtempSync(join(tmpdir(), 'truebench-work-'))
    writeFileSync(join(work, 'mod.py'), 'def add(a, b):\n    return a + b\n')
    const hidden = mkdtempSync(join(tmpdir(), 'truebench-hidden-'))
    const hiddenTest = join(hidden, 'hidden_test.py')
    writeFileSync(hiddenTest, 'from mod import add\n\ndef test_add():\n    assert add(2, 3) == 5\n')

    scorePytest(work, hiddenTest, 'hidden_test.py')
    expect(existsSync(join(work, 'hidden_test.py'))).toBe(false)
    rmSync(work, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  })
})
