import { describe, it, expect } from 'vitest'
import { classifyCheckCommand, detectFramework, parseTestSummary } from '../../bridge/testSummary.js'

describe('detectFramework', () => {
  it('recognizes a pytest invocation', () => {
    expect(detectFramework('GILDED_NARRATE=0 python -m pytest gilded/ -q')).toBe('pytest')
  })

  it('recognizes vitest, jest, cargo and go', () => {
    expect(detectFramework('bunx vitest run')).toBe('vitest')
    expect(detectFramework('npx jest --ci')).toBe('jest')
    expect(detectFramework('cargo test --all')).toBe('cargo')
    expect(detectFramework('go test ./...')).toBe('go')
  })

  it('returns null for a non-test command', () => {
    expect(detectFramework('git status --porcelain')).toBeNull()
    expect(detectFramework('ls -la')).toBeNull()
  })
})

describe('parseTestSummary', () => {
  it('parses a red pytest run into real counts', () => {
    const out = '=== short test summary info ===\nFAILED gilded/tests/test_realm.py::test_x\n46 failed, 208 passed in 19.42s'
    expect(parseTestSummary('python -m pytest gilded/ -q', out)).toEqual({
      framework: 'pytest', passed: 208, total: 254,
    })
  })

  it('parses an all-green pytest run', () => {
    expect(parseTestSummary('python -m pytest gilded/ -q', '354 passed in 21.0s')).toEqual({
      framework: 'pytest', passed: 354, total: 354,
    })
  })

  it('parses a vitest summary', () => {
    const out = ' Test Files  2 failed | 293 passed (300)\n      Tests  8 failed | 2266 passed | 35 skipped (2309)'
    const r = parseTestSummary('bunx vitest run', out)!
    expect(r.passed).toBe(2266)
    expect(r.total).toBe(2274)
  })

  it('parses a cargo summary', () => {
    const out = 'test result: FAILED. 3 passed; 1 failed; 0 ignored'
    expect(parseTestSummary('cargo test', out)).toEqual({
      framework: 'cargo', passed: 3, total: 4,
    })
  })

  it('returns null on a collection error despite a stray count in the output', () => {
    const out = "ImportError: cannot import name 'opinion_matrix'\n" +
      '!!!!!!! Interrupted: 3 errors during collection !!!!!!!\n3 errors in 0.32s\n12 passed'
    expect(parseTestSummary('python -m pytest gilded/ -q', out)).toBeNull()
  })

  it('returns null when the command is not a test runner', () => {
    expect(parseTestSummary('git status', '5 passed')).toBeNull()
  })

  it('returns null when a runner ran but produced no summary', () => {
    expect(parseTestSummary('python -m pytest gilded/ -q', 'collecting ...')).toBeNull()
  })

  it('returns null rather than 0/0 when counts are absent', () => {
    expect(parseTestSummary('python -m pytest', 'no tests ran in 0.01s')).toBeNull()
  })

  it('accepts a bare framework name as well as a command', () => {
    expect(parseTestSummary('pytest', '10 passed')).toEqual({
      framework: 'pytest', passed: 10, total: 10,
    })
  })
})

describe('classifyCheckCommand', () => {
  it('recognizes direct typecheck and build invocations', () => {
    expect(classifyCheckCommand('npx tsc --noEmit')).toBe('typecheck')
    expect(classifyCheckCommand('mypy gilded/')).toBe('typecheck')
    expect(classifyCheckCommand('cargo build --release')).toBe('build')
    expect(classifyCheckCommand('make')).toBe('build')
  })

  it('reads the script name of a package-manager run', () => {
    expect(classifyCheckCommand('npm run typecheck')).toBe('typecheck')
    expect(classifyCheckCommand('bun run build')).toBe('build')
    expect(classifyCheckCommand('pnpm build:prod')).toBe('build')
  })

  it('reaches past env assignments and a cd', () => {
    expect(classifyCheckCommand('CI=1 npx tsc -p .')).toBe('typecheck')
    expect(classifyCheckCommand('cd engine && npm run build')).toBe('build')
  })

  it('does not read a command out of quoted text', () => {
    // This reported a passing build, inventing a measurement from a message.
    expect(classifyCheckCommand('git commit -m "make build work"')).toBeNull()
    expect(classifyCheckCommand("echo 'run tsc later'")).toBeNull()
  })

  it('does not match a tool named as an argument', () => {
    expect(classifyCheckCommand('rg tsc')).toBeNull()
    expect(classifyCheckCommand('cat Makefile')).toBeNull()
  })

  it('returns null for test runs and unrelated commands', () => {
    expect(classifyCheckCommand('npm test')).toBeNull()
    expect(classifyCheckCommand('git status')).toBeNull()
  })
})
