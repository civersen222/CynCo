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
  /**
   * How many nudges in a row have been answered without a single file mutation
   * or new commit. Reset to 0 by any real change. See UNPRODUCTIVE_NUDGE_LIMIT.
   */
  unproductiveNudges: number
}

/**
 * After this many nudges that changed nothing, stop and believe the model.
 *
 * This is the backstop for both prose hatches failing at once, which is exactly
 * what happened on 11R. A lexical check can always be out-phrased and a
 * contract can be authored so that it never completes; neither can fake a file
 * mutation. Three is enough to distinguish a model that stalled mid-plan (it
 * resumes on the first or second nudge) from one that is genuinely finished.
 */
export const UNPRODUCTIVE_NUDGE_LIMIT = 3

const COMPLETION_SIGNALS = new RegExp(
  [
    // "the task / this mission / the work is (genuinely, now, fully) complete"
    String.raw`\b(task|mission|stage|work|run)\b[^.!?\n]{0,40}?\bis\b[^.!?\n]{0,30}?\b(complete|finished|done)\b`,
    String.raw`\btask (is )?(genuinely |now |fully )?complete\b`,
    String.raw`\b(i am|i'm) (done|idle|finished)\b`,
    String.raw`\ball done\b`,
    // "no remaining work", "no further executable action", "nothing left to do"
    String.raw`\bno (remaining|further|more|additional) [a-z ]{0,24}?(work|action|steps?|changes?|tasks?)\b`,
    String.raw`\bnothing (further|left|more|else)\b`,
    String.raw`\bno (work|action|changes?) (remains?|is remaining|left)\b`,
    String.raw`\bwaiting for\b`,
    String.raw`\bready for\b`,
    String.raw`\bwhat would you like\b`,
    String.raw`\bno changes needed\b`,
  ].join('|'),
  'i',
)

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
  // Neither statement is trustworthy on its own — 11R shut both — so the last
  // word belongs to what the model actually did with the nudges it already got.
  if (s.unproductiveNudges >= UNPRODUCTIVE_NUDGE_LIMIT) return false

  // Deliberated but never acted.
  if (s.reasoningTokens > 0 && s.textTokens === 0) return true
  // Described instead of doing: a short answer on top of a long think.
  if (s.textTokens > 0 && s.textTokens < 100 && s.reasoningTokens > s.textTokens * 2) return true
  // Stopped mid-plan: it was using tools and then stopped, without saying why.
  return s.toolsUsedInSession
}
