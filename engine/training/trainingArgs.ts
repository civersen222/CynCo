/**
 * Argument parsing for the training CLI, as a pure function.
 *
 * Split out of runTraining.ts because that module parses `process.argv` and
 * dispatches a stage at import time, so importing it to test the parsing runs
 * the training. Every defect this file exists to fix survived precisely there.
 */

export const DEFAULT_BASE = 'unsloth/Qwen2.5-Coder-14B-Instruct'
export const DEFAULT_VERSION = 'v1'
export const DEFAULT_STAGE = 'stats'

/** Flags that take a following value, so the value is not itself a token to read. */
const VALUE_FLAGS = new Set(['--stage', '--base', '--version'])

export type TrainingArgs = {
  stage: string
  base: string
  version: string
  dryRun: boolean
}

/**
 * The value of `flag`, or `fallback`.
 *
 * `args[args.indexOf(flag) + 1] ?? fallback` is the shape this replaces, and it
 * is wrong in a way that reads as correct: `indexOf` answers -1 when the flag is
 * absent, `-1 + 1` is 0, and `args[0]` is a string, so `??` never fires. The
 * default was reachable on an empty argv and nowhere else — `--stage sft` gave
 * a base model of `--stage`.
 *
 * The trailing and next-flag cases are refusals rather than passes: `--base`
 * with nothing after it, or with another flag after it, is a mistake, and
 * forwarding `undefined` or `--dry-run` to the trainer moves the error a long
 * way from its cause.
 */
function valueOf(args: string[], flag: string, fallback: string): string {
  const i = args.indexOf(flag)
  if (i === -1) return fallback
  const v = args[i + 1]
  if (v === undefined || v.startsWith('-')) return fallback
  return v
}

/**
 * The first bare token that is not some flag's value.
 *
 * `args.find(a => !a.startsWith('-'))` read the VALUE of a preceding flag, so
 * `--base ./model --stage stats` resolved the stage to `./model`.
 */
function positionalStage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) { i++; continue }
    if (!args[i].startsWith('-')) return args[i]
  }
  return undefined
}

export function parseTrainingArgs(args: string[]): TrainingArgs {
  return {
    // An explicit --stage always wins over a positional.
    stage: valueOf(args, '--stage', positionalStage(args) ?? DEFAULT_STAGE),
    base: valueOf(args, '--base', DEFAULT_BASE),
    version: valueOf(args, '--version', DEFAULT_VERSION),
    dryRun: args.includes('--dry-run'),
  }
}
