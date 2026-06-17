import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scorePytest, parsePytestScore } from './scorer.js'

describe('parsePytestScore', () => {
  it('scores all-passing as 1.0', () => {
    expect(parsePytestScore('5 passed in 0.10s')).toEqual({ score: 1, passedCount: 5, total: 5 })
  })

  it('scores a mix of passed and failed as the passing fraction', () => {
    expect(parsePytestScore('3 passed, 2 failed in 0.10s')).toEqual({ score: 0.6, passedCount: 3, total: 5 })
  })

  it('scores all-failing as 0.0', () => {
    expect(parsePytestScore('4 failed in 0.10s')).toEqual({ score: 0, passedCount: 0, total: 4 })
  })

  it('counts errors toward the total', () => {
    expect(parsePytestScore('2 passed, 1 failed, 1 error in 0.10s')).toEqual({
      score: 0.5,
      passedCount: 2,
      total: 4,
    })
  })

  it('counts pluralized errors toward the total', () => {
    expect(parsePytestScore('2 passed, 2 errors in 0.10s')).toEqual({
      score: 0.5,
      passedCount: 2,
      total: 4,
    })
  })

  it('treats empty/malformed output as 0/0 -> score 0', () => {
    expect(parsePytestScore('')).toEqual({ score: 0, passedCount: 0, total: 0 })
    expect(parsePytestScore('no counts here at all')).toEqual({ score: 0, passedCount: 0, total: 0 })
  })
})

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
