import { describe, it, expect } from 'vitest'
import { isBenignTestFailure, isDeclaredVerificationCheck } from '../../bridge/benignToolResult.js'

const bash = (command: string) => ({ command })

describe('isBenignTestFailure', () => {
  it('treats a red pytest run (tests ran, some failed) as benign', () => {
    const out = '[ERROR: runtime] Variable or function may be undefined\n\n' +
      '=== short test summary info ===\nFAILED gilded/tests/test_realm.py::test_x\n46 failed, 208 passed in 19.42s'
    expect(isBenignTestFailure('Bash', bash('GILDED_NARRATE=0 python -m pytest gilded/ -q'), out)).toBe(true)
  })

  it('treats an all-green pytest run as benign (defensive — success anyway)', () => {
    expect(isBenignTestFailure('Bash', bash('python -m pytest gilded/ -q'), '354 passed in 21.0s')).toBe(true)
  })

  it('does NOT treat a pytest collection error as benign (broken import must be fixed)', () => {
    const out = '[ERROR: dependency] Install the missing package first\n\n' +
      "ImportError: cannot import name 'opinion_matrix' from 'gilded.society.characters'\n" +
      '!!!!!!! Interrupted: 3 errors during collection !!!!!!!\n3 errors in 0.32s'
    expect(isBenignTestFailure('Bash', bash('python -m pytest gilded/ -q'), out)).toBe(false)
  })

  it('does NOT treat a pytest usage error as benign', () => {
    const out = 'usage: pytest [options]\npytest: error: unrecognized arguments: --nope'
    expect(isBenignTestFailure('Bash', bash('pytest --nope'), out)).toBe(false)
  })

  it('does NOT treat a non-test command failure as benign', () => {
    expect(isBenignTestFailure('Bash', bash('python build.py'), 'TypeError: bad\n1 failed')).toBe(false)
  })

  it('does NOT treat command-not-found as benign even if it names a runner', () => {
    expect(isBenignTestFailure('Bash', bash('pytest gilded/'), 'pytest: command not found')).toBe(false)
  })

  it('requires a pass/fail summary — a runner that crashed before running is not benign', () => {
    expect(isBenignTestFailure('Bash', bash('python -m pytest gilded/'), 'Traceback (most recent call last): ...')).toBe(false)
  })

  it('recognizes go test and cargo test red runs', () => {
    expect(isBenignTestFailure('Bash', bash('go test ./...'), '--- FAIL: TestFoo (0.00s)\nFAIL\texample/pkg\t0.1s')).toBe(true)
    expect(isBenignTestFailure('Bash', bash('cargo test'), 'test result: FAILED. 3 passed; 1 failed; 0 ignored')).toBe(true)
  })

  it('only applies to Bash', () => {
    expect(isBenignTestFailure('Read', bash('python -m pytest'), '1 failed')).toBe(false)
  })
})

describe('isDeclaredVerificationCheck', () => {
  const CMD = 'SDL_VIDEODRIVER=dummy python C:/tmp/verify_l46e.py the_tree_is_clean'
  const DECLARED = [
    `Verification command exits 0: ${CMD}`,
    'File gilded/tests/test_ai.py declares at least 18 test cases',
  ]
  // What a harness prints when it ran fine and the answer is no.
  const ANSWERED_NO = '=== the_tree_is_clean\n  M gilded/tests/test_ai.py\n  -> FAIL\n\n13/14 checks pass'

  it('treats a declared verification command answering no as a check, not a tool fault', () => {
    expect(isDeclaredVerificationCheck('Bash', bash(CMD), ANSWERED_NO, DECLARED)).toBe(true)
  })

  it('recognizes the declared command inside a wrapped invocation', () => {
    expect(isDeclaredVerificationCheck('Bash', bash(`${CMD} 2>&1 | tail -20`), ANSWERED_NO, DECLARED)).toBe(true)
  })

  it('does NOT apply to a command the contract never declared', () => {
    expect(isDeclaredVerificationCheck('Bash', bash('python build.py'), ANSWERED_NO, DECLARED)).toBe(false)
  })

  it('does NOT apply when the harness itself could not run', () => {
    const missing = "python: can't open file 'C:/tmp/verify_l46e.py': [Errno 2] No such file or directory"
    expect(isDeclaredVerificationCheck('Bash', bash(CMD), missing, DECLARED)).toBe(false)
  })

  it('does NOT apply when the harness crashed', () => {
    const crash = 'Traceback (most recent call last):\n  File "verify.py", line 8\n    AttributeError: no attribute'
    expect(isDeclaredVerificationCheck('Bash', bash(CMD), crash, DECLARED)).toBe(false)
  })

  it('ignores assertions that are not verification commands', () => {
    expect(isDeclaredVerificationCheck('Bash', bash('gilded/tests/test_ai.py'), ANSWERED_NO, DECLARED)).toBe(false)
  })

  it('only applies to Bash', () => {
    expect(isDeclaredVerificationCheck('Read', bash(CMD), ANSWERED_NO, DECLARED)).toBe(false)
  })

  it('is inert with no active contract', () => {
    expect(isDeclaredVerificationCheck('Bash', bash(CMD), ANSWERED_NO, [])).toBe(false)
  })
})
