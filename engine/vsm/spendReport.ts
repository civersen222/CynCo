/**
 * Rendering for `/spend` — "where did this session's 40 minutes go".
 *
 * Separate from GovernanceDB because the query and the prose have different
 * reasons to change, and because a pure string function can be tested without
 * a database.
 */

import type { SessionSpend } from './governanceDb.js'

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const pct = (part: number, whole: number) => whole > 0 ? `${Math.round(part / whole * 100)}%` : '—'

/**
 * Render a session's spend.
 *
 * Every line states its own coverage. A turn whose server reported no timings
 * is absent from these sums, so printing "42.0s" without "over 7 of 31 turns"
 * would present a floor as a total.
 */
export function formatSpend(s: SessionSpend): string {
  if (s.turnsTotal === 0) return '[Spend] No turns recorded for this session.\n'

  if (s.turnsMeasured === 0) {
    return `[Spend] ${s.turnsTotal} turn(s) recorded, none with cost data — ` +
      'the server reported no timings, so this session\'s spend is unknown.\n'
  }

  const promptTokens = s.prefillTokens + s.cachedTokens
  const lines = [
    `[Spend] ${s.turnsMeasured} of ${s.turnsTotal} turn(s) reported cost` +
      (s.sources.length ? ` (${s.sources.join(', ')})` : '') + '.',
    `  Prompt   ${promptTokens} tok — ${s.prefillTokens} evaluated, ` +
      `${s.cachedTokens} from cache (${pct(s.cachedTokens, promptTokens)} hit)`,
    `  Decode   ${s.decodeTokens} tok`,
    `  Prefill  ${secs(s.prefillMs)}`,
    `  Decode   ${secs(s.decodeMs)}`,
    // Wall is the engine's clock, so it covers queueing and transport the
    // server never sees. The remainder is not idle time — it is time the
    // server did not account for.
    `  Wall     ${secs(s.wallMs)} (${secs(Math.max(0, s.wallMs - s.prefillMs - s.decodeMs))} outside prefill+decode)`,
  ]

  if (s.turnsMeasured < s.turnsTotal) {
    lines.push(`  Excludes ${s.turnsTotal - s.turnsMeasured} unmeasured turn(s) — the real spend is higher.`)
  }

  return lines.join('\n') + '\n'
}
