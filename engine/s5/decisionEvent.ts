import type { S5Decision } from './types.js'
import type { S5DecisionEvent } from '../bridge/protocol.js'

/**
 * The `s5.decision` frame, built once for both emit sites in the loop (the
 * per-message decision and the stuck-loop re-evaluation).
 *
 * The frame's readers — the 9161 dashboard S5 panel and the ledger collector
 * (scripts/cynco-ledger.mjs s5Decisions) — read `toolRestriction` and
 * `modelSwitch`. Both sites used to fill those from `decision.toolRestriction`
 * and `decision.modelSwitch`, fields `S5Decision` has never had; its names are
 * `tools` and `model`. So every frame said "tools: none" and the ledger's
 * column was always null, however often C7 restricted. The frame keeps the
 * names its readers use and takes the values from where they are.
 */
export function s5DecisionEvent(
  decision: S5Decision,
  opts: { enforced: boolean; authority: S5DecisionEvent['authority']; source?: 'stuck-reeval' },
): S5DecisionEvent {
  return {
    type: 's5.decision',
    reasoning: decision.reasoning,
    contextAction: decision.contextAction,
    toolRestriction: decision.tools ?? null,
    modelSwitch: decision.model ?? null,
    ruleIds: decision.ruleIds ?? [],
    enforced: opts.enforced,
    authority: opts.authority,
    ...(opts.source ? { source: opts.source } : {}),
    timestamp: Date.now(),
  }
}
