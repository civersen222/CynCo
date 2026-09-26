/**
 * Is this engine running an unattended mission?
 *
 * `scripts/dispatch-mission.sh` launches a mission engine with four
 * `LOCALCODE_MISSION_*` keys (the same four the dashboard's /api/mission
 * reads). Several decisions differ when nobody is at the keyboard: the engine
 * refuses to download a missing llama-server (F161, `bootstrapProvider.ts`),
 * and an S5 decision under legacy rule authority is advisory rather than
 * governed by `LOCALCODE_S5_ENFORCE` (Phase 5 Task 1, `s5/ruleAuthority.ts`).
 * One predicate, one module, so the two cannot disagree about what a mission is.
 */

/**
 * The keys, named rather than matched by prefix, so the README env inventory
 * lists each one (F161 fix wave, I4).
 */
export const MISSION_ENV_KEYS = ['LOCALCODE_MISSION_MARKER', 'LOCALCODE_MISSION_CWD', 'LOCALCODE_MISSION_BASE', 'LOCALCODE_MISSION_CHECK'] as const

/**
 * True when any of MISSION_ENV_KEYS is set. An empty value does not count —
 * the check command may legitimately be `''`, and `KEY=$UNSET_VAR` is an
 * ordinary accident.
 */
export function isUnattendedMission(env: Record<string, string | undefined> = process.env): boolean {
  return MISSION_ENV_KEYS.some(k => typeof env[k] === 'string' && env[k]!.length > 0)
}
