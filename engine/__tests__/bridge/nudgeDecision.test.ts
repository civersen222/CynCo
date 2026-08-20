import { describe, it, expect } from 'vitest'
import { saysDone, shouldNudge, UNPRODUCTIVE_NUDGE_LIMIT, type NudgeSignals } from '../../bridge/nudgeDecision.js'

function signals(over: Partial<NudgeSignals> = {}): NudgeSignals {
  return {
    noToolsEndTurn: true,
    reasoningTokens: 0,
    textTokens: 0,
    toolsUsedInSession: false,
    modelSaysDone: false,
    contractComplete: false,
    producedStructuredOutcome: false,
    unproductiveNudges: 0,
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

  /**
   * The 11R regression, and the reason this signal is behavioural rather than
   * lexical. Both prose escape hatches were shut: the contract carried an
   * assertion that could never pass (a bare `pytest` over a suite with 16
   * known failures the mission forbade fixing), and the model announced
   * completion in wording `saysDone` did not match. It then spent the rest of
   * the run re-running `git status` because the loop demanded a tool call.
   *
   * Phrasing can always drift out from under a regex. Mutation cannot: a model
   * that has been told to act three times and has changed no file and made no
   * commit is telling the truth about being finished. Believe the behaviour.
   */
  it('stops nudging once repeated nudges have produced no change', () => {
    const stuck = { reasoningTokens: 400, textTokens: 40, toolsUsedInSession: true }
    expect(shouldNudge(signals({ ...stuck, unproductiveNudges: 0 }))).toBe(true)
    expect(shouldNudge(signals({ ...stuck, unproductiveNudges: 2 }))).toBe(true)
    expect(shouldNudge(signals({ ...stuck, unproductiveNudges: UNPRODUCTIVE_NUDGE_LIMIT }))).toBe(false)
    expect(shouldNudge(signals({ ...stuck, unproductiveNudges: 99 }))).toBe(false)
  })

  it('keeps nudging a model that is still changing things', () => {
    // Progress resets the counter, so a productive model is never cut off.
    expect(shouldNudge(signals({ reasoningTokens: 400, unproductiveNudges: 0 }))).toBe(true)
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

  /**
   * Every one of these is a verbatim completion announcement from the 11R run.
   * The regex matched none of them: it wanted the noun "task" where the model
   * wrote "mission", and "ready for your" where the model wrote "ready for the
   * gate result". Six clear statements of done, zero matches, and the loop
   * nudged through all of them.
   */
  it('recognizes the ways the model announced completion on the 11R run', () => {
    for (const text of [
      'The 11R mission is fully complete on my side — every actionable contract item is done and verified.',
      'There is no remaining work in this workspace, and I will stop re-running identical verifications.',
      'There is nothing further that can be done here.',
      'There is no remaining executable action in this workspace.',
      'No further executable work exists in this workspace; I am idle and ready to act on new input.',
      "I'm idle, ready for the gate result or a new task.",
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
