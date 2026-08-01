/**
 * The training CLI's flag defaults were unreachable whenever any flag was passed.
 *
 * Measured 2026-07-31 running `--stage sft --dry-run`, which invoked
 * `train_sft.py --base --stage --dry-run` and wrote to an adapter directory
 * named `sft---stage`. The cause:
 *
 *     const base = args[args.indexOf('--base') + 1] ?? DEFAULT
 *
 * `indexOf` answers -1 when the flag is absent, so `args[-1 + 1]` is `args[0]`.
 * The `??` never fires, because `args[0]` is a perfectly good string. The
 * default is reachable on an EMPTY argv and nowhere else.
 *
 * This file already carried a comment describing this exact bug and its fix —
 * for `--stage`. The repair was applied to one of the three readers and the
 * other two kept the shape. That is what these tests are really guarding:
 * `--stage`, `--base` and `--version` now go through one function, so there is
 * no second copy left to forget.
 *
 * Why it matters past the crash: `promote` passes `base` into the adapter's
 * provenance record. A promotion run this way would record the model it was
 * trained from as `--stage`.
 */
import { describe, expect, it } from 'vitest'
import { parseTrainingArgs, DEFAULT_BASE } from '../../training/trainingArgs.js'

describe('flag values', () => {
  it('reads a flag that is present', () => {
    const a = parseTrainingArgs(['--stage', 'sft', '--base', './model', '--version', 'v3'])
    expect(a.stage).toBe('sft')
    expect(a.base).toBe('./model')
    expect(a.version).toBe('v3')
  })

  it('falls back to the default when the flag is absent but other flags are not', () => {
    // The regression. Every one of these returned args[0] before the fix.
    const a = parseTrainingArgs(['--stage', 'sft', '--dry-run'])
    expect(a.base).toBe(DEFAULT_BASE)
    expect(a.version).toBe('v1')
  })

  it('falls back when the first token is a bare word rather than a flag', () => {
    const a = parseTrainingArgs(['sft'])
    expect(a.stage).toBe('sft')
    expect(a.base).toBe(DEFAULT_BASE)
    expect(a.version).toBe('v1')
  })

  it('falls back on an empty argv — the one case that always worked', () => {
    const a = parseTrainingArgs([])
    expect(a.base).toBe(DEFAULT_BASE)
    expect(a.version).toBe('v1')
    expect(a.stage).toBe('stats')
  })

  it('falls back when the flag is last and has no value after it', () => {
    // `--base` with nothing following must not silently become undefined and
    // reach execFile as an empty argument.
    expect(parseTrainingArgs(['--stage', 'sft', '--base']).base).toBe(DEFAULT_BASE)
    expect(parseTrainingArgs(['--version']).version).toBe('v1')
  })

  it('refuses to read the next flag as a value', () => {
    // `--base --dry-run` is a user error; taking '--dry-run' as a model path
    // would send it to train_sft.py and fail somewhere far away from the cause.
    expect(parseTrainingArgs(['--base', '--dry-run']).base).toBe(DEFAULT_BASE)
  })
})

describe('stage resolution', () => {
  it('an explicit --stage beats a positional', () => {
    expect(parseTrainingArgs(['dataset', '--stage', 'sft']).stage).toBe('sft')
  })

  it('a positional is read when there is no --stage', () => {
    expect(parseTrainingArgs(['dataset']).stage).toBe('dataset')
  })

  it("does not mistake another flag's value for the positional stage", () => {
    // The original bug in this file, kept as a regression: `--base ./model`
    // used to resolve the stage to './model'.
    expect(parseTrainingArgs(['--base', './model']).stage).toBe('stats')
    expect(parseTrainingArgs(['--version', 'v9']).stage).toBe('stats')
  })
})

describe('dryRun', () => {
  it('is a presence flag, not a value flag', () => {
    expect(parseTrainingArgs(['--dry-run']).dryRun).toBe(true)
    expect(parseTrainingArgs(['--stage', 'sft']).dryRun).toBe(false)
  })

  it('is not consumed as the stage', () => {
    expect(parseTrainingArgs(['--dry-run']).stage).toBe('stats')
  })
})
