import type { TurnCost } from '../types.js'

/**
 * Session-lifetime token totals, from the server's own timings — measured
 * counts for the supervision-economics ledger, never chars/4 estimates.
 *
 * A turn whose cost the server did not report increments `unmeasuredTurns`
 * and touches nothing else: unmeasured is not free, and folding a guess into
 * a measured total would poison the one column whose point is replacing the
 * estimate. Consumers that need "all turns covered" must check the counter.
 */
export type TokenTotals = {
  prefillTokens: number
  cachedTokens: number
  decodeTokens: number
  measuredTurns: number
  unmeasuredTurns: number
}

export function emptyTokenTotals(): TokenTotals {
  return { prefillTokens: 0, cachedTokens: 0, decodeTokens: 0, measuredTurns: 0, unmeasuredTurns: 0 }
}

/**
 * Fold one turn's reported cost into the running totals, in place.
 *
 * Null fields are skipped, not zeroed — 'usage-only' turns know their decode
 * but not the prefill/cache split, and adding 0 for "unknown" would make the
 * prefill column read as measured-low instead of incomplete.
 */
export function addTurnCost(totals: TokenTotals, cost: TurnCost | null): void {
  if (cost && cost.source !== 'none') {
    totals.prefillTokens += cost.prefillTokens ?? 0
    totals.cachedTokens += cost.cachedTokens ?? 0
    totals.decodeTokens += cost.decodeTokens ?? 0
    totals.measuredTurns += 1
  } else {
    totals.unmeasuredTurns += 1
  }
}
