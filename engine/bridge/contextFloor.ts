/**
 * How many prompt tokens is the next request going to be?
 *
 * The engine's own answer is `JSON.stringify(x).length / 4` — a guess. On the
 * L3-3.3b run that guess read 75% of a request the server then rejected at
 * 67733 of 65536 tokens (103%), so the 80% compaction trigger never fired and
 * the task died mid-way through recording its results. Finding (n).
 *
 * The server, meanwhile, reports `usage.prompt_tokens` on every stream: the
 * count it actually evaluated. That is a measurement, and it is used here as a
 * FLOOR rather than a correction factor — "the prompt was at least N tokens
 * last request, and the conversation has only grown since" is an argument from
 * a measurement, whereas scaling the guess by measured/guessed would just be a
 * second guess wearing the measurement's clothes.
 *
 * The premise — "has only grown" — is the whole load-bearing part, and it is
 * false after compaction, a read-loop prune, or a best-of-N rollback. So the
 * floor carries the message count it was measured at and is discarded, not
 * trusted, when the conversation has since shrunk.
 *
 * Finding (r), Gilded L4.1, is the other half of the same premise. "Has only
 * grown" was used to justify keeping the measurement and then to excuse never
 * asking BY HOW MUCH. The engine read 72% and the next request was 66019 of
 * 65536 — 101% — because between the measurement and that request it had
 * appended an assistant turn and a pytest tool result, and `max(guess, N)`
 * counted none of it. The guess that covered those messages under-reads the
 * whole conversation badly enough that the max never selects it, so the newest
 * and largest additions were exactly what the estimate was blindest to.
 *
 * So the growth is now stated, not waved at: the prompt was N tokens at message
 * count M, and the messages appended since M are worth at least D. Measured
 * part measured, guessed part covering only what has never been measured — the
 * error now scales with one tool result rather than with the whole session.
 */
export type PromptMeasurement = {
  /** Tokens the server reported for the last request, or null if never measured. */
  tokens: number | null
  /** How many messages the conversation held when that measurement was taken. */
  atMessageCount: number
}

/**
 * The best available lower bound on the current prompt size.
 *
 * Returns the guess when there is no usable measurement. Never returns less
 * than the guess: a measurement that has fallen behind a growing conversation
 * is still a floor, just a loose one.
 *
 * `guessedTailTokens` is the chars/4 estimate over the messages appended AFTER
 * `measurement.atMessageCount` — the part of the current prompt the server has
 * never seen. It is required rather than defaulted: a caller that forgot it
 * would silently get back the pre-finding-(r) behaviour, with every test in
 * engine/__tests__/engine/measuredPromptTokens.test.ts still green.
 */
export function promptTokensWithFloor(
  guessedTokens: number,
  measurement: PromptMeasurement,
  currentMessageCount: number,
  guessedTailTokens: number,
): number {
  if (measurement.tokens === null) return guessedTokens
  if (currentMessageCount < measurement.atMessageCount) return guessedTokens
  return Math.max(guessedTokens, measurement.tokens + guessedTailTokens)
}
