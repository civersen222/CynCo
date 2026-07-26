/**
 * Should the loop nudge the model back into calling tools?
 *
 * The nudge exists for a model that deliberates instead of acting. It is not
 * supposed to fire at a model that has finished — but the "it says it's done"
 * escape hatch was wired into only one of the three triggers, so a model that
 * announced completion in a short sentence after a long think was still told to
 * "call a tool RIGHT NOW".
 *
 * Watched live at the end of the L2b run: every assertion passed, the suite was
 * green, the tree was clean, and CynCo spent five turns on `echo "Task
 * complete"` / `echo "ready"` / `echo "All done"` before writing "I am in a loop
 * of just calling tools to satisfy the 'call a tool' constraint" and stopping.
 * Those turns are recorded into the training corpus as tool calls, so the cost
 * is not just latency — it teaches the behavior.
 */

export type NudgeSignals = {
  /** The model ended its turn without calling any tool. */
  noToolsEndTurn: boolean
  reasoningTokens: number
  textTokens: number
  /** The model has used tools earlier in this session. */
  toolsUsedInSession: boolean
  /** The model said, in words, that the task is finished. */
  modelSaysDone: boolean
  /** Every contract assertion is satisfied — the engine's own measure of done. */
  contractComplete: boolean
  /** A one-shot mission's ```json outcome IS its completion. */
  producedStructuredOutcome: boolean
}

const COMPLETION_SIGNALS =
  /\b(task (is )?(genuinely |now )?complete|(i am|i'm) done|all done|waiting for|ready for your|what would you like|no changes needed)\b/i

/** Did the model announce completion in its narration? */
export function saysDone(text: string): boolean {
  return COMPLETION_SIGNALS.test(text)
}

export function shouldNudge(s: NudgeSignals): boolean {
  if (!s.noToolsEndTurn) return false
  // Two statements that the work is over, one from the model and one measured.
  // Overriding either one puts the loop in the position of demanding tool calls
  // from a model with nothing left to do, which is how the echo loop happened.
  if (s.modelSaysDone || s.contractComplete) return false
  if (s.producedStructuredOutcome) return false

  // Deliberated but never acted.
  if (s.reasoningTokens > 0 && s.textTokens === 0) return true
  // Described instead of doing: a short answer on top of a long think.
  if (s.textTokens > 0 && s.textTokens < 100 && s.reasoningTokens > s.textTokens * 2) return true
  // Stopped mid-plan: it was using tools and then stopped, without saying why.
  return s.toolsUsedInSession
}
