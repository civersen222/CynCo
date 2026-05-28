import { describe, expect, it, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeReward, finalizeTask } from '../../training/rewardLabeler.js'
import type { RewardComponents, TaskReward } from '../../training/rewardLabeler.js'

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
    // 1.0 + 0.5 + 0.3 + 0.2 + 0.5 + 0.3 = 2.8 → clipped to 1.0
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
