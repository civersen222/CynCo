import { describe, expect, it, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeReward, finalizeTask, hasOutcomeEvidence, LABELER_VERSION } from '../../training/rewardLabeler.js'
import type { RewardComponents, TaskReward } from '../../training/rewardLabeler.js'
import type { TaskOutcomeInput } from '../../training/taskOutcome.js'

// ─── Helpers ──────────────────────────────────────────────────────

/** A "perfect" task: all checks pass, no stuck turns, done quickly. */
function perfectComponents(): RewardComponents {
  return {
    testsPass: 1.0,
    typecheckPass: 1,
    buildPass: 1,
    diffClean: 1,
    taskCompleted: 1,
    stuckTurns: 0,
    iterFraction: 0.0,
    userSatisfaction: 1,
    testsUnmodified: 1,
  }
}

// ─── computeReward ────────────────────────────────────────────────

describe('computeReward', () => {
  it('perfect task gets high reward (> 0.8)', () => {
    // base 1.0 (all components perfect) + 0.3 satisfaction → clipped to 1.0
    const r = computeReward(perfectComponents())
    expect(r).toBeGreaterThan(0.8)
    expect(r).toBe(1.0)
  })

  it('failed tests reduce reward below 0.8', () => {
    const c = perfectComponents()
    c.testsPass = 0.0           // no tests passing
    c.taskCompleted = 0         // didn't complete
    c.typecheckPass = 0
    c.buildPass = 0
    c.diffClean = 0
    c.userSatisfaction = 0
    const r = computeReward(c)
    // 0 + 0 + 0 + 0 + 0 = 0
    expect(r).toBeLessThan(0.8)
  })

  it('partial test pass (0.5) reduces reward compared to full pass', () => {
    // Use a lower base that is NOT clipped so the difference is visible
    const base: RewardComponents = {
      testsPass: 1.0,
      typecheckPass: 0,
      buildPass: 0,
      diffClean: 0,
      taskCompleted: 0,
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    }
    const full = computeReward(base)              // 1.0 * 1.0 = 1.0
    const partial = computeReward({ ...base, testsPass: 0.5 }) // 1.0 * 0.5 = 0.5
    expect(partial).toBeLessThan(full)
  })

  it('modified tests give -1.0 (anti-reward-hacking gate)', () => {
    const c = perfectComponents()
    c.testsUnmodified = 0
    expect(computeReward(c)).toBe(-1.0)
  })

  it('anti-reward-hacking overrides all other perfect components', () => {
    // Even with everything else perfect, test modification = -1
    const c = perfectComponents()
    c.testsUnmodified = 0
    expect(computeReward(c)).toBe(-1.0)
  })

  it('stuck turns reduce reward', () => {
    // Use a base that is NOT at the ceiling so the penalty is visible
    const base: RewardComponents = {
      testsPass: 0.5,
      typecheckPass: 0,
      buildPass: 0,
      diffClean: 0,
      taskCompleted: 0,
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    }
    const baseline = computeReward(base)
    const stuck = computeReward({ ...base, stuckTurns: 5 })
    expect(stuck).toBeLessThan(baseline)
  })

  it('stuckTurns is capped at 10 for penalty calculation', () => {
    const at10 = computeReward({ ...perfectComponents(), stuckTurns: 10 })
    const at20 = computeReward({ ...perfectComponents(), stuckTurns: 20 })
    // Both cap at 10 * 0.05 = 0.5 penalty — should be equal
    expect(at10).toBe(at20)
  })

  it('high iterFraction reduces reward', () => {
    // Use a base that is NOT at the ceiling so the penalty is visible
    const base: RewardComponents = {
      testsPass: 0.5,
      typecheckPass: 0,
      buildPass: 0,
      diffClean: 0,
      taskCompleted: 0,
      stuckTurns: 0,
      iterFraction: 0.0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    }
    const fast = computeReward(base)
    const slow = computeReward({ ...base, iterFraction: 1.0 })
    expect(slow).toBeLessThan(fast)
  })

  it('negative userSatisfaction does not add penalty (clamped at 0)', () => {
    // max(0, -1) = 0 → same as userSatisfaction = 0
    const negative = computeReward({ ...perfectComponents(), userSatisfaction: -1 })
    const neutral = computeReward({ ...perfectComponents(), userSatisfaction: 0 })
    expect(negative).toBe(neutral)
  })

  it('positive userSatisfaction adds reward', () => {
    const neutral = computeReward({ ...perfectComponents(), userSatisfaction: 0 })
    const happy = computeReward({ ...perfectComponents(), userSatisfaction: 1 })
    // Clipped but can still compare at lower base
    const baseC: RewardComponents = {
      testsPass: 0.5,
      typecheckPass: 0,
      buildPass: 0,
      diffClean: 0,
      taskCompleted: 0,
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    }
    const neutralLow = computeReward(baseC)
    const happyLow = computeReward({ ...baseC, userSatisfaction: 1 })
    expect(happyLow).toBeGreaterThan(neutralLow)
    // Suppress unused-var warnings for the clipped comparison
    void neutral
    void happy
  })

  it('reward is clipped to [-1, 1] — never exceeds 1.0', () => {
    const r = computeReward(perfectComponents())
    expect(r).toBeLessThanOrEqual(1.0)
    expect(r).toBeGreaterThanOrEqual(-1.0)
  })

  it('worst-case legitimate task stays above -1.0 (no test hacking)', () => {
    const worst: RewardComponents = {
      testsPass: 0.0,
      typecheckPass: 0,
      buildPass: 0,
      diffClean: 0,
      taskCompleted: 0,
      stuckTurns: 20,     // capped at 10 → -0.5
      iterFraction: 1.0,  // -0.1
      userSatisfaction: -1,
      testsUnmodified: 1, // did NOT hack tests
    }
    const r = computeReward(worst)
    // 0 - 0.5 - 0.1 + 0 = -0.6 — above hard floor
    expect(r).toBeGreaterThan(-1.0)
    expect(r).toBeGreaterThanOrEqual(-1.0)
  })
})

// ─── finalizeTask ─────────────────────────────────────────────────

describe('finalizeTask', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reward-test-'))
  })

  it('writes a .reward.json file and returns the TaskReward', () => {
    const c = perfectComponents()
    const result = finalizeTask('task-abc', 12, c, tmpDir)

    expect(result.taskId).toBe('task-abc')
    expect(result.turns).toBe(12)
    expect(result.reward).toBe(1.0)
    expect(result.components).toEqual(c)

    const filePath = join(tmpDir, 'task-abc.reward.json')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed: TaskReward = JSON.parse(raw)

    expect(parsed.taskId).toBe('task-abc')
    expect(parsed.turns).toBe(12)
    expect(parsed.reward).toBe(1.0)
    expect(parsed.components).toEqual(c)
  })

  it('persists anti-hacking penalty to file', () => {
    const c = { ...perfectComponents(), testsUnmodified: 0 as const }
    const result = finalizeTask('task-hack', 5, c, tmpDir)

    expect(result.reward).toBe(-1.0)

    const filePath = join(tmpDir, 'task-hack.reward.json')
    const parsed: TaskReward = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(parsed.reward).toBe(-1.0)
  })

  it('creates the output directory if it does not exist', () => {
    const nested = join(tmpDir, 'deep', 'nested', 'dir')
    expect(() => finalizeTask('task-deep', 3, perfectComponents(), nested)).not.toThrow()

    const filePath = join(nested, 'task-deep.reward.json')
    const parsed: TaskReward = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(parsed.taskId).toBe('task-deep')
  })
})

// ─── Normalization (2026-07-25) ───────────────────────────────────

describe('computeReward — normalization', () => {
  const withTests = (testsPass: number): RewardComponents => ({
    testsPass,
    typecheckPass: 1,
    buildPass: 1,
    diffClean: 1,
    taskCompleted: 1,
    stuckTurns: 0,
    iterFraction: 0,
    userSatisfaction: 0,
    testsUnmodified: 1,
  })

  it('is strictly monotonic in testsPass even with every other component perfect', () => {
    // THE bug: weights summed to 2.8 and clipped to 1.0, so 0.43 and 1.0 tied.
    const low = computeReward(withTests(0.4286))
    const high = computeReward(withTests(1.0))
    expect(low).toBeLessThan(high)
    expect(high - low).toBeGreaterThan(0.15)
  })

  it('does not reach the ceiling on non-test components alone', () => {
    const noTests = computeReward({ ...withTests(0), testsPass: 0 })
    expect(noTests).toBeLessThan(1.0)
  })

  it('scores a total test failure as a failure, not partial credit for compiling', () => {
    // Hygiene is table stakes. Under an even weighting this shape scored 0.4 —
    // above the 0.3 negative threshold — so a wholly failed task produced no
    // DPO negative and the corpus stayed all-positive.
    const allRed = computeReward({
      testsPass: 0,
      typecheckPass: 1,
      buildPass: 1,
      diffClean: 1,
      taskCompleted: 0,
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(allRed).toBeLessThan(0.3)
  })

  it('ranks a half-passing task above a wholly failing one', () => {
    const shape = (testsPass: number, taskCompleted: number) => computeReward({
      testsPass, taskCompleted, typecheckPass: 1, buildPass: 1, diffClean: 1,
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    })
    expect(shape(0.5, 0)).toBeGreaterThan(shape(0, 0))
    expect(shape(1, 1)).toBeGreaterThan(shape(0.5, 0))
  })

  it('excludes unknown components from the denominator', () => {
    // Only testsPass is known, so the base is exactly testsPass.
    const r = computeReward({
      testsPass: 0.5,
      typecheckPass: 'unknown',
      buildPass: 'unknown',
      diffClean: 'unknown',
      taskCompleted: 'unknown',
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(r).toBeCloseTo(0.5, 6)
  })

  it('an unknown component neither helps nor hurts relative to being absent', () => {
    const known = computeReward({ ...withTests(0.5), typecheckPass: 1, buildPass: 1, diffClean: 1, taskCompleted: 1 })
    const unknown = computeReward({
      ...withTests(0.5), typecheckPass: 'unknown', buildPass: 'unknown', diffClean: 'unknown', taskCompleted: 'unknown',
    })
    expect(known).toBeGreaterThan(unknown) // real passes raise the score
    expect(unknown).toBeCloseTo(0.5, 6)    // unknowns leave it at testsPass alone
  })

  it('scores 0 when nothing at all could be measured', () => {
    const r = computeReward({
      testsPass: 'unknown',
      typecheckPass: 'unknown',
      buildPass: 'unknown',
      diffClean: 'unknown',
      taskCompleted: 'unknown',
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(r).toBe(0)
  })

  it('still returns -1.0 when the safety gate trips', () => {
    expect(computeReward({ ...withTests(1.0), testsUnmodified: 0 })).toBe(-1.0)
  })
})

describe('finalizeTask — labelerVersion', () => {
  it('stamps the current labeler version on every record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-ver-'))
    const r = finalizeTask('task-ver', 5, {
      testsPass: 1, typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.labelerVersion).toBe(LABELER_VERSION)
    const parsed = JSON.parse(readFileSync(join(dir, 'task-ver.reward.json'), 'utf-8'))
    expect(parsed.labelerVersion).toBe(LABELER_VERSION)
  })

  it('flags a record with no measurable positive component as degenerate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-degen-'))
    const r = finalizeTask('task-degen', 2, {
      testsPass: 'unknown', typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.degenerate).toBe(true)
  })
})

// ─── Outcome evidence (hygiene is not outcome) ────────────────────

describe('hasOutcomeEvidence', () => {
  const blank = (): RewardComponents => ({
    testsPass: 'unknown', typecheckPass: 'unknown', buildPass: 'unknown',
    diffClean: 'unknown', taskCompleted: 'unknown',
    stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
  })

  it('is false when nothing at all was measured', () => {
    expect(hasOutcomeEvidence(blank())).toBe(false)
  })

  it('is true when a test run was observed', () => {
    expect(hasOutcomeEvidence({ ...blank(), testsPass: 0 })).toBe(true)
  })

  it('is true when task completion was observed', () => {
    expect(hasOutcomeEvidence({ ...blank(), taskCompleted: 0 })).toBe(true)
  })

  it('is false for hygiene components alone — they are not outcome', () => {
    expect(hasOutcomeEvidence({ ...blank(), diffClean: 1 })).toBe(false)
    expect(hasOutcomeEvidence({ ...blank(), typecheckPass: 1 })).toBe(false)
    expect(hasOutcomeEvidence({ ...blank(), buildPass: 1 })).toBe(false)
    expect(hasOutcomeEvidence({ ...blank(), typecheckPass: 1, buildPass: 1, diffClean: 1 })).toBe(false)
  })
})

describe('finalizeTask — hygiene alone cannot qualify a row', () => {
  it('marks the do-nothing task degenerate instead of rewarding it ~1.0', () => {
    // The saturation bug relocated to the denominator: diffClean is measured on
    // any git repo and a clean tree scores 1, so an agent that did nothing at
    // all scored base 1.0 on a denominator of 0.1.
    const dir = mkdtempSync(join(tmpdir(), 'reward-nothing-'))
    const r = finalizeTask('task-nothing', 1, {
      testsPass: 'unknown', typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 1, taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.reward).toBe(1.0)      // the raw score is still a weighted mean
    expect(r.degenerate).toBe(true) // but the row carries no outcome evidence
    const parsed: TaskReward = JSON.parse(readFileSync(join(dir, 'task-nothing.reward.json'), 'utf-8'))
    expect(parsed.degenerate).toBe(true)
  })

  it('marks a row degenerate when only typecheck and build were measured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-hygiene-'))
    const r = finalizeTask('task-hygiene', 4, {
      testsPass: 'unknown', typecheckPass: 1, buildPass: 1,
      diffClean: 1, taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.degenerate).toBe(true)
  })

  it('keeps a row with a real test run, however hygiene went', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-outcome-'))
    const r = finalizeTask('task-outcome', 9, {
      testsPass: 0.5, typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.degenerate).toBeUndefined()
  })

  it('keeps a row whose only outcome measurement is a failed task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-failed-'))
    const r = finalizeTask('task-failed', 30, {
      testsPass: 'unknown', typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 0, taskCompleted: 0,
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.degenerate).toBeUndefined()
  })

  it('does not make a row degenerate merely because the safety gate could not run', () => {
    // testsUnmodified: 'unknown' is disclosure, not disqualification — the row
    // still carries a measured test outcome.
    const dir = mkdtempSync(join(tmpdir(), 'reward-nogate-'))
    const r = finalizeTask('task-nogate', 6, {
      testsPass: 1, typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 'unknown',
    }, dir)
    expect(r.degenerate).toBeUndefined()
    const parsed: TaskReward = JSON.parse(readFileSync(join(dir, 'task-nogate.reward.json'), 'utf-8'))
    expect(parsed.components.testsUnmodified).toBe('unknown')
  })
})

// ─── A run the engine killed is not a measurement of the model ────

describe('finalizeTask — the engine died, so nothing here is a verdict', () => {
  const crashedComponents = (): RewardComponents => ({
    // task-25d8015a exactly: llama-server died at turn 59, the loop stopped
    // mid-sentence, and the only outcome component that survived was a test run
    // from before the crash. It scored 0.9882 — the best row in the corpus,
    // awarded for a run that never reached an ending.
    testsPass: 1, typecheckPass: 'unknown', buildPass: 'unknown',
    diffClean: 1, taskCompleted: 'unknown',
    stuckTurns: 0, iterFraction: 0.118, userSatisfaction: 0, testsUnmodified: 1,
  })

  const outcomeWith = (endedInEngineError: boolean): TaskOutcomeInput => ({
    contract: null,
    commandObservations: [],
    testObservations: [],
    git: null,
    trackedModifiedFiles: [],
    baselineDirty: [],
    stuckTurns: 0,
    turns: 59,
    hitIterationLimit: false,
    endedInEngineError,
  })

  it('marks the row degenerate when the harness died mid-run', () => {
    // taskCompleted is already withheld for this case, and correctly so. What
    // was missing is that withholding it is not enough: testsPass alone then
    // carries the row on a denominator of one component, and the row enters the
    // corpus as a near-perfect example. A truncated run has no ending to grade.
    const dir = mkdtempSync(join(tmpdir(), 'reward-crash-'))
    const r = finalizeTask('task-crash', 59, crashedComponents(), dir, outcomeWith(true))
    expect(r.degenerate).toBe(true)
    const parsed: TaskReward = JSON.parse(readFileSync(join(dir, 'task-crash.reward.json'), 'utf-8'))
    expect(parsed.degenerate).toBe(true)
  })

  it('keeps the identical row when the run ended on its own', () => {
    // The control. If this were also degenerate the rule would be measuring
    // something other than the crash.
    const dir = mkdtempSync(join(tmpdir(), 'reward-nocrash-'))
    const r = finalizeTask('task-nocrash', 59, crashedComponents(), dir, outcomeWith(false))
    expect(r.degenerate).toBeUndefined()
  })

  it('leaves the raw reward alone — degenerate is an exclusion, not a penalty', () => {
    // Scoring the crash down would teach the model that being cut off is bad
    // behaviour. It is not behaviour at all. The number stays honest and the
    // row simply does not count.
    const dir = mkdtempSync(join(tmpdir(), 'reward-crash-score-'))
    const crashed = finalizeTask('task-cs', 59, crashedComponents(), dir, outcomeWith(true))
    const healthy = finalizeTask('task-hs', 59, crashedComponents(), dir, outcomeWith(false))
    expect(crashed.reward).toBe(healthy.reward)
  })

  it('does not claim a healthy run when no outcome evidence was supplied at all', () => {
    // An absent outcome is not a report of "no crash". The degenerate verdict
    // here comes from the components alone, and a row that does carry outcome
    // evidence is left qualified rather than being failed on a guess.
    const dir = mkdtempSync(join(tmpdir(), 'reward-nooutcome-'))
    const r = finalizeTask('task-no', 59, crashedComponents(), dir)
    expect(r.degenerate).toBeUndefined()
  })
})

// ─── The safety gate when it could not look (2026-07-25) ──────────

describe('computeReward — testsUnmodified unknown', () => {
  it('does not veto when the gate could not run', () => {
    const r = computeReward({
      testsPass: 1, typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 'unknown',
    })
    expect(r).toBe(1.0)
  })

  it('still vetoes on a measured 0', () => {
    const r = computeReward({
      testsPass: 1, typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 0,
    })
    expect(r).toBe(-1.0)
  })
})
