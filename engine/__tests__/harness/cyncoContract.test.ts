/**
 * Finding (ai): a mission can never authorize a legitimate test deletion.
 *
 * `assessTestsUnmodified` (engine/training/taskOutcome.ts:294-334) vetoes the
 * whole reward — `computeReward` returns -1.0 outright — when a test file loses
 * measured cases or disappears from the tree. It is clearable, and the way it
 * clears is exact: every losing path must be named by a PASSED assertion whose
 * text parses into `test_census` for a shrink or `file_absent` for a removal.
 * Silence vetoes, deliberately (finding (w): a contract making twenty-five
 * claims about the product is not evidence about test survival).
 *
 * The channel exists and nothing can reach it. `cynco-mission-driver.mjs` builds
 * its entire contract from `checkCmd` — one assertion, about the gate — so a
 * mission whose brief says "delete the four superseded cases in test_ui.py" is
 * scored -1.0 for doing as it was told, and that record enters the corpus
 * teaching that following the brief earns the maximum penalty. Every such row is
 * a fabricated negative.
 *
 * So the mission author needs a second input, and it has to be one that cannot
 * quietly do nothing:
 *
 *   - it lives beside the brief, so it is committed and reviewed with it;
 *   - the two authorizing kinds are written STRUCTURALLY and the canonical
 *     sentence is rendered here, because `assertionCheck` matches an anchored
 *     literal template. Hand-transcribing `Test file X declares at least N test
 *     cases` into a JSON file gives every author a chance to write a sentence
 *     that parses into nothing — and an assertion that parses into nothing is
 *     graded on the model's own word (contract.ts:425, `if (check)`), which is
 *     the exact opposite of authorizing;
 *   - a malformed sidecar refuses the dispatch rather than dispatching without
 *     it. A silently-ignored authorization file is finding (ag) again: the
 *     component that knows the answer has no way to say so, and never learns
 *     that it failed to.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertionCheck } from '../../tools/contractVerify.js'
// @ts-ignore — untyped harness module
import { sidecarPath, loadMissionAssertions } from '../../../scripts/cynco-contract.mjs'

const GATE = 'python C:/tmp/verify_w8.py'
const SIDECAR = 'C:/tmp/w8.contract.json'

/** A fake filesystem: only what a test names exists. */
function fs(files: Record<string, string>) {
  return {
    exists: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`)
      return files[p]
    },
  }
}

const sidecar = (body: unknown) =>
  fs({ [SIDECAR]: typeof body === 'string' ? body : JSON.stringify(body) })

// `...gate` rather than a default parameter: `load(body, undefined)` would
// otherwise take the default and silently test the gated case twice.
const load = (body: unknown, ...gate: Array<string | undefined>) =>
  loadMissionAssertions('C:/tmp/w8.md', gate.length ? gate[0] : GATE, sidecar(body))

describe('the sidecar lives beside the brief', () => {
  it('replaces the brief extension so the pair sorts together', () => {
    expect(sidecarPath('C:/tmp/wave8_brief.md')).toBe('C:/tmp/wave8_brief.contract.json')
  })

  it('normalizes backslashes, because the driver is called with Windows paths', () => {
    expect(sidecarPath('C:\\tmp\\wave8_brief.txt')).toBe('C:/tmp/wave8_brief.contract.json')
  })

  it('appends when the brief has no extension at all', () => {
    expect(sidecarPath('C:/tmp/wave8_brief')).toBe('C:/tmp/wave8_brief.contract.json')
  })

  it('does not mistake a dotted directory for the brief extension', () => {
    expect(sidecarPath('C:/tmp/wave.8/brief')).toBe('C:/tmp/wave.8/brief.contract.json')
  })
})

describe('with no sidecar, the contract is what it has always been', () => {
  it('is the withheld gate alone', () => {
    const a = loadMissionAssertions('C:/tmp/w8.md', GATE, fs({}))
    expect(a).toHaveLength(1)
    expect(a[0].command).toBe(GATE)
    expect(a[0].text).not.toContain('verify_w8')
  })

  it('is null when there is no gate either — nothing to certify, no contract', () => {
    expect(loadMissionAssertions('C:/tmp/w8.md', undefined, fs({}))).toBeNull()
  })
})

describe('the sidecar renders the sentences the veto looks for', () => {
  /**
   * The point of the whole file, and the reason the kinds are structural:
   * `assessTestsUnmodified` never sees this JSON. It reads the assertion TEXT
   * off the finished contract and runs `assertionCheck` on it. Rendering here
   * and parsing there must round-trip exactly, or the authorization is a
   * comment.
   */
  it('a census floor round-trips through assertionCheck', () => {
    const a = load({ assertions: [{ testCensus: 'gilded/tests/test_ui.py', min: 40 }] })
    expect(assertionCheck(a[1])).toEqual({
      kind: 'test_census', path: 'gilded/tests/test_ui.py', min: 40,
    })
  })

  it('an absence claim round-trips through assertionCheck', () => {
    const a = load({ assertions: [{ fileAbsent: 'gilded/tests/test_old.py' }] })
    expect(assertionCheck(a[1])).toEqual({
      kind: 'file_absent', path: 'gilded/tests/test_old.py',
    })
  })

  it('keeps the gate first and appends in the order written', () => {
    const a = load({
      assertions: [
        { fileAbsent: 'gilded/tests/test_old.py' },
        { testCensus: 'gilded/tests/test_ui.py', min: 40 },
      ],
    })
    expect(a).toHaveLength(3)
    expect(a[0].command).toBe(GATE)
    expect(assertionCheck(a[1])?.kind).toBe('file_absent')
    expect(assertionCheck(a[2])?.kind).toBe('test_census')
  })

  it('carries a second withheld command without showing it', () => {
    const a = load({ assertions: [{ text: 'the coverage floor holds', command: 'python C:/tmp/cov.py' }] })
    expect(a[1].command).toBe('python C:/tmp/cov.py')
    expect(a[1].text).not.toContain('cov.py')
  })

  it('accepts a raw sentence that already parses, for the kinds with no shorthand', () => {
    const a = load({ assertions: ['File gilded/ui/policy.py exists after changes'] })
    expect(assertionCheck(a[1])?.kind).toBe('file_exists')
  })

  it('works with no gate at all — a mission may be authorization and nothing else', () => {
    const a = load({ assertions: [{ fileAbsent: 'gilded/tests/test_old.py' }] }, undefined)
    expect(a).toHaveLength(1)
    expect(assertionCheck(a[0])?.kind).toBe('file_absent')
  })
})

describe('a sidecar that cannot do its job refuses the dispatch', () => {
  const bad: Array<[string, unknown]> = [
    ['not JSON at all', 'assertions: [a]'],
    ['a JSON array rather than an object', '["a"]'],
    ['an object with no assertions key', { note: 'todo' }],
    ['assertions that is not an array', { assertions: 'test_old.py is gone' }],
    ['an empty array — a file that authorizes nothing', { assertions: [] }],
    ['an entry that is a number', { assertions: [7] }],
    ['an entry that is null', { assertions: [null] }],
    ['an object entry naming no known kind', { assertions: [{ note: 'x' }] }],
    ['a census with no floor', { assertions: [{ testCensus: 'a/test_b.py' }] }],
    ['a census whose floor is a string', { assertions: [{ testCensus: 'a/test_b.py', min: '40' }] }],
    ['a census whose floor is negative', { assertions: [{ testCensus: 'a/test_b.py', min: -1 }] }],
    ['a census whose floor is fractional', { assertions: [{ testCensus: 'a/test_b.py', min: 2.5 }] }],
    ['an absence claim with an empty path', { assertions: [{ fileAbsent: '   ' }] }],
    ['an object entry missing its command', { assertions: [{ text: 'the floor holds' }] }],
    ['an object entry whose command is blank', { assertions: [{ text: 'x', command: '  ' }] }],
  ]

  it.each(bad)('%s', (_label, body) => {
    expect(() => load(body)).toThrow()
  })

  /**
   * The one that is not a syntax error. `Every test in test_ui.py still passes`
   * is a sentence a person would write and `assertionCheck` returns null for, so
   * the model would mark it passed on its own word and the veto would find
   * nothing named. Dispatch is the only place this is visible.
   */
  it('refuses prose that parses into no check, quoting the offending line', () => {
    expect(() => load({ assertions: ['Every test in test_ui.py still passes'] }))
      .toThrow(/Every test in test_ui\.py still passes/)
  })

  /**
   * A census path that reaches `assertionCheck` as something else is the failure
   * this shape exists to prevent, so it must be caught rather than rendered.
   */
  it('refuses a census path that would not survive the round trip', () => {
    expect(() => load({ assertions: [{ testCensus: 'a/test_b.py\nrm -rf /', min: 3 }] })).toThrow()
  })

  it('says which file it refused on, so the author can find it', () => {
    expect(() => load({ assertions: [] })).toThrow(/w8\.contract\.json/)
  })
})

describe('the driver actually uses it', () => {
  const driver = readFileSync('scripts/cynco-mission-driver.mjs', 'utf-8')

  it('builds its assertions through loadMissionAssertions', () => {
    // A channel the production dispatcher does not call is finding (ag) again:
    // enforcement built, wired to nothing, nobody the wiser for four months.
    expect(driver).toMatch(/loadMissionAssertions/)
    expect(driver).toMatch(/assertions:\s*missionAssertions/)
  })

  it('sends a contract whenever there are assertions, not only when there is a gate', () => {
    // The old condition was `const contract = checkCmd ? {...} : undefined`. A
    // sidecar-only mission would have built its assertions and dropped them.
    expect(driver).not.toMatch(/const contract = checkCmd\s*$/m)
    expect(driver).toMatch(/const contract = missionAssertions/)
  })
})
