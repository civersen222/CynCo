import { describe, expect, it } from 'bun:test'
import { DoomLoopDetector } from '../../tools/doomLoop.js'

describe('DoomLoopDetector', () => {
  it('does not trigger on first call', () => {
    const d = new DoomLoopDetector(3)
    expect(d.check('Bash', 'echo hello', true)).toBe(false)
  })

  it('triggers after 3 consecutive failures of same tool+input', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'bun test', true)
    d.check('Bash', 'bun test', true)
    expect(d.check('Bash', 'bun test', true)).toBe(true)
  })

  it('resets on success', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'bun test', true)
    d.check('Bash', 'bun test', true)
    d.check('Bash', 'bun test', false) // success resets
    expect(d.check('Bash', 'bun test', true)).toBe(false)
  })

  it('tracks different tool+input combos independently', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'cmd1', true)
    d.check('Bash', 'cmd1', true)
    d.check('Bash', 'cmd2', true) // different input
    expect(d.check('Bash', 'cmd1', true)).toBe(true) // 3rd failure of cmd1
  })

  it('returns suggestion when doom loop detected', () => {
    const d = new DoomLoopDetector(3)
    d.check('Edit', 'same args', true)
    d.check('Edit', 'same args', true)
    d.check('Edit', 'same args', true)
    expect(d.getSuggestion()).toContain('repeated')
  })
})

// ---------------------------------------------------------------------------
// Finding (t). The detector halted a run that was doing exactly what its brief
// ordered. Three faults compose:
//
//   (1) the key was a 100-char PREFIX, truncated twice (executor sliced to 100,
//       check() sliced again). Every gilded command opens with the mandated
//       `$env:GILDED_NARRATE="0"; $env:SDL_VIDEODRIVER="dummy"; python -m pytest
//       gilded/tests` — which is 100 characters. Every pytest call in that
//       repository was one key.
//
//   (2) a red test is a failure. TDD's inner loop is: run the failing test,
//       edit, run THE SAME COMMAND again. Identical input is the method, not
//       the symptom. Nothing separated it from thrashing except that the
//       workspace changed in between — which the detector never asked about.
//
//   (3) the refusal replaced the tool's real output, so the model never saw the
//       pytest report it needed to make the test pass. The engine withheld the
//       answer and then scolded it for not knowing.
//
// Cost: L4.1c halted at turn 64 on "5 consecutive failures", reward 0.019,
// mid-way through a red-green cycle it had been explicitly instructed to run.
// ---------------------------------------------------------------------------
describe('DoomLoopDetector — telling iteration from thrashing', () => {
  const GILDED = '$env:GILDED_NARRATE="0"; $env:SDL_VIDEODRIVER="dummy"; python -m pytest gilded/tests'

  it('does not collide two commands that share a long mandated prefix', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', `${GILDED}/test_ui_broadsheet.py::test_margin -q`, true)
    d.check('Bash', `${GILDED}/test_ui_broadsheet.py::test_predator -q`, true)
    expect(d.check('Bash', `${GILDED}/test_ui_broadsheet.py::test_ticker -v`, true)).toBe(false)
  })

  it('an edit between two failures clears the count — that is TDD, not a loop', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'pytest test_x.py', true)   // red
    d.noteWorkspaceChanged()                    // the fix
    d.check('Bash', 'pytest test_x.py', true)   // still red, but this is iteration
    d.noteWorkspaceChanged()
    expect(d.check('Bash', 'pytest test_x.py', true)).toBe(false)
  })

  it('still catches a genuine loop: the same failing call with nothing changed', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'pytest test_x.py', true)
    d.check('Bash', 'pytest test_x.py', true)
    expect(d.check('Bash', 'pytest test_x.py', true)).toBe(true)
  })

  it('a change clears every key, not just the one that failed last', () => {
    const d = new DoomLoopDetector(3)
    d.check('Bash', 'cmd-a', true)
    d.check('Bash', 'cmd-a', true)
    d.check('Bash', 'cmd-b', true)
    d.noteWorkspaceChanged()
    expect(d.check('Bash', 'cmd-a', true)).toBe(false)
    expect(d.check('Bash', 'cmd-b', true)).toBe(false)
  })
})
