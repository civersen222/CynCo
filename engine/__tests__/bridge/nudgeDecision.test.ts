import { describe, it, expect } from 'vitest'
import { saysDone, shouldNudge, type NudgeSignals } from '../../bridge/nudgeDecision.js'

function signals(over: Partial<NudgeSignals> = {}): NudgeSignals {
  return {
    noToolsEndTurn: true,
    reasoningTokens: 0,
    textTokens: 0,
    toolsUsedInSession: false,
    modelSaysDone: false,
    contractComplete: false,
    producedStructuredOutcome: false,
    ...over,
  }
}

describe('shouldNudge', () => {
  it('nudges a model that deliberated and never acted', () => {
    expect(shouldNudge(signals({ reasoningTokens: 400 }))).toBe(true)
  })

  it('nudges a model that described the work instead of doing it', () => {
    expect(shouldNudge(signals({ reasoningTokens: 300, textTokens: 40 }))).toBe(true)
  })

  it('nudges a model that used tools and then stopped mid-plan', () => {
    expect(shouldNudge(signals({ textTokens: 300, toolsUsedInSession: true }))).toBe(true)
  })

  it('leaves a turn that called a tool alone', () => {
    expect(shouldNudge(signals({ noToolsEndTurn: false, reasoningTokens: 400 }))).toBe(false)
  })

  it('leaves a first turn of pure narration alone — nothing says it is stuck yet', () => {
    expect(shouldNudge(signals({ textTokens: 300 }))).toBe(false)
  })

  /**
   * The live regression. `modelSaysDone` guarded only the mid-plan trigger, so a
   * model that finished, said so in one short sentence, and had been thinking
   * hard about whether it was finished, matched "described instead of doing" and
   * got "You MUST call a tool RIGHT NOW". It complied with `echo "ready"`.
   */
  it('does not nudge a model that says it is done, on any trigger', () => {
    for (const over of [
      { reasoningTokens: 400 },
      { reasoningTokens: 300, textTokens: 40 },
      { textTokens: 300, toolsUsedInSession: true },
    ]) {
      expect(shouldNudge(signals({ ...over, modelSaysDone: true }))).toBe(false)
    }
  })

  it('does not nudge when the contract says the task is complete', () => {
    expect(shouldNudge(signals({ reasoningTokens: 400, contractComplete: true }))).toBe(false)
    expect(shouldNudge(signals({ textTokens: 300, toolsUsedInSession: true, contractComplete: true }))).toBe(false)
  })

  it('does not nudge a one-shot mission that emitted its structured outcome', () => {
    expect(shouldNudge(signals({ reasoningTokens: 400, producedStructuredOutcome: true }))).toBe(false)
  })
})

describe('saysDone', () => {
  it('recognizes the ways the model actually announced completion on the L2b run', () => {
    for (const text of [
      'Task is complete. All contract assertions passed.',
      'Task complete.',
      'The task is genuinely complete - all contract assertions passed.',
      'All done',
      "I'm done here.",
      'No changes needed.',
      'Ready for your next instruction.',
    ]) {
      expect(saysDone(text)).toBe(true)
    }
  })

  it('does not read completion into a plan to keep working', () => {
    expect(saysDone('Let me finish the last edit and then run the suite.')).toBe(false)
    expect(saysDone('Next I will wire the caller.')).toBe(false)
  })

  /**
   * A phrase match cannot tell an announcement from a mention, so "check whether
   * the task is complete" reads as done and the nudge is skipped. That costs one
   * missed nudge; the alternative — a false negative — costs the echo loop and
   * writes junk tool calls into the corpus. The cheap error is the right one.
   */
  it('errs toward believing the model over nudging it', () => {
    expect(saysDone('I need to check whether the task is complete before I stop.')).toBe(true)
  })
})
