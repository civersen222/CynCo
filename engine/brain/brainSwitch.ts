/**
 * engine/brain/brainSwitch.ts — the one read site of LOCALCODE_BRAIN.
 *
 * `off` (any case, trimmed) keeps the jlens sidecar and the Tier 3
 * activations consumer from starting in `engine/main.ts`; anything else, or
 * unset, is today's behaviour (auto-detect the tier). The headless phone
 * engine sets it off (`scripts/run-headless-engine.cmd`): nobody watches the
 * Brain tab from a phone, and a Python sidecar plus an activation tap are pure
 * cost there. Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 4).
 */
export function brainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LOCALCODE_BRAIN
  if (v === undefined) return true
  return v.trim().toLowerCase() !== 'off'
}

/**
 * The one read site of LOCALCODE_JLENS. The J-Space lens sidecar is a Python
 * process that holds gigabytes of RAM, so it is OFF unless the owner asks
 * (`LOCALCODE_JLENS=on`) — owner's decision 2026-11-08. The entropy tier and
 * the activation tap are unaffected; `sidecarDecision` names this switch in
 * its refusal so turning the lens on is one variable away.
 */
export function lensEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LOCALCODE_JLENS ?? '').trim().toLowerCase() === 'on'
}
