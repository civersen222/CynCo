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

  it('does not read a runner out of quoted text', () => {
    // All three were run against the live engine and all three reported a
    // framework. `testsPass` carries 2.0 of a 3.6 denominator, so a command
    // that merely SAYS "pytest" near a number was worth more than the work.
    expect(detectFramework('echo "pytest suite: 452 passed"')).toBeNull()
    expect(detectFramework('git commit -m "vitest: 3066 passed"')).toBeNull()
  })

  it('does not match a runner named as an argument', () => {
    // Searching a brief for the word is the accidental form: no intent to
    // fake anything, and the brief itself supplies the number.
    expect(detectFramework('rg -n pytest docs/brief.md')).toBeNull()
    expect(detectFramework('cat pytest.ini')).toBeNull()
    expect(detectFramework('grep -r vitest package.json')).toBeNull()
  })

  it('still reaches a runner past a cd and env assignments', () => {
    expect(detectFramework('cd gilded && PYTHONDONTWRITEBYTECODE=1 python -m pytest -q')).toBe('pytest')
    expect(detectFramework('cd engine && npx vitest run')).toBe('vitest')
  })

  it('reaches pytest past interpreter flags between python and -m', () => {
    // The exact command every Gilded wave runs. Undetected, an ordinary red
    // suite counts as a Bash fault and the circuit breaker locks the agent out
    // of its own tests.
    expect(detectFramework('cd C:\\Users\\civer\\civkings; python -X utf8=0 -m pytest gilded/ -v -n 16')).toBe('pytest')
    expect(detectFramework('python3.14 -X utf8=0 -m pytest gilded/ -q')).toBe('pytest')
    expect(detectFramework('python -u -W ignore -m unittest discover')).toBe('pytest')
  })

  it('does not treat a script argument as an interpreter flag', () => {
    expect(detectFramework('python manage.py -m pytest')).toBeNull()
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

  it('returns null when the line can exit 0 while the check failed', () => {
    // The caller has one thing to record the result with: the line's exit
    // status. Each of these lines exits 0 with a broken typecheck inside it,
    // so classifying them hands the labeler a pass that was never measured.
    expect(classifyCheckCommand('npx tsc --noEmit || true')).toBeNull()
    expect(classifyCheckCommand('npx tsc --noEmit ; echo done')).toBeNull()
    // `| tee` is the same fault with a friendlier face: the pipeline reports
    // tee's status, and tee always succeeds.
    expect(classifyCheckCommand('npx tsc --noEmit | tee /tmp/tsc.log')).toBeNull()
  })

  it('returns null when the check is not the command the status belongs to', () => {
    // `&&` short-circuits, so the line's status is the LAST segment's. Here
    // that is the test run, and the build's result is not in the exit code.
    expect(classifyCheckCommand('npm run build && npm test')).toBeNull()
  })

  it('still classifies a check that the exit status does belong to', () => {
    expect(classifyCheckCommand('cd engine && npx tsc --noEmit')).toBe('typecheck')
  })
})
