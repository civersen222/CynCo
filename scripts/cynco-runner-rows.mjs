// scripts/cynco-runner-rows.mjs — the runner rows for the rule ladder
// (Phase 6): `R1.no-progress`, the runner's shadow regulator, read off the
// wave records of every runner-driven campaign.
//
// One module, two callers, one construction: the campaign runner's VERDICT and
// the rule-verdicts CLI (`bun scripts/cynco-rule-verdicts.mjs`) both build the
// runner row here (Task 4 review I1). The row joins the Holm family with the S5
// rules, so a rebuild that built it differently — or not at all — would correct
// the rules over a different m and could flip a rule's verdict on a hand run.
//
// Kept free of the grade/calibrate chain (engine/paths.js is bun-only) so the
// CLI can import it without dragging the gate runner in.
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CampaignState } from './cynco-campaign-state.mjs'

/** `R1.no-progress` speaks from this fraction of the wall clock on. */
export const NO_PROGRESS_AT = 0.5
export const NO_PROGRESS_RULE = 'R1.no-progress'

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The runner rows for the ladder (writeRuleVerdicts takes them beside the S5
 * rules and the `M1.*` model rows, `source: 'runner'`). One row,
 * `R1.no-progress`, always — an empty scope is the honest UNMEASURED, not an
 * absent row.
 * - scope: waves with a missionId, a decision (a `stop` never ran and is not
 *   one) and ≥ 1 `R1.no-progress` shadow DECISION at `elapsedFraction ≥ 0.5`,
 *   fired or not (Task 3 review I1). Scope reads the decisions, never the
 *   readings: a wave that stops committing before 50 % has its last reading
 *   below 50 % and only skipped ticks after it — exactly the rule's positives,
 *   which a readings-based scope dropped on every 8 h wave;
 * - fired: those scoped waves where any decision has `fired: true`;
 * - failed: those scoped waves whose decision is not `pass` /
 *   `pass-with-survivors` — the rule's OUTCOME (a firing on a wave that then
 *   passed was wrong; on any other decision, right);
 * - skipped: the wave records that are not a record at all, or whose
 *   `shadowDecisions` is neither absent nor an array — named (missionId, else
 *   `record #i`) and left out. One malformed line in any campaign's
 *   waves.jsonl costs that line, never the row (Task 4 review M1).
 */
export function runnerRowsFrom(waves) {
  const scope = new Set(), fired = new Set(), failed = new Set(), skipped = []
  ;(Array.isArray(waves) ? waves : []).forEach((w, i) => {
    if (!isRecord(w) || (w.shadowDecisions != null && !Array.isArray(w.shadowDecisions))) {
      skipped.push(isRecord(w) && typeof w.missionId === 'string' && w.missionId ? w.missionId : `record #${i + 1}`)
      return
    }
    const kind = isRecord(w.decision) ? w.decision.kind : undefined
    if (!w.missionId || !kind || kind === 'stop') return
    const pastHalf = (w.shadowDecisions ?? []).filter(d => isRecord(d) && d.rule === NO_PROGRESS_RULE
      && typeof d.elapsedFraction === 'number' && d.elapsedFraction >= NO_PROGRESS_AT)
    if (!pastHalf.length) return
    scope.add(w.missionId)
    if (pastHalf.some(d => d.fired === true)) fired.add(w.missionId)
    if (kind !== 'pass' && kind !== 'pass-with-survivors') failed.add(w.missionId)
  })
  return [{ id: NO_PROGRESS_RULE, source: 'runner', fired, scope, failed, skipped }]
}

/**
 * Every wave record the runner's shadow regulator is judged over — the
 * campaign being graded (`waves` from its own state, with `rec`, the wave just
 * recorded, in place of a stored copy of it) and every OTHER runner-driven
 * campaign under `campaignsDir` (a dir holding a `waves.jsonl`; a dir without
 * one contributes nothing). A dir named `current` is skipped: the state handed
 * over is that campaign's record. With no `current` (the CLI) every dir is
 * read. Reads only; an unparseable line is skipped by CampaignState.waves().
 */
export function runnerWaves(campaignsDir, { current = null, waves = [], rec = null } = {}) {
  const own = rec && waves.at(-1)?.wave === rec.wave ? [...waves.slice(0, -1), rec] : rec ? [...waves, rec] : [...waves]
  const names = existsSync(campaignsDir)
    ? readdirSync(campaignsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== current).map(d => d.name).sort()
    : []
  const others = names.flatMap(name => new CampaignState(join(campaignsDir, name)).waves())
  return [...others, ...own]
}

/** The runner rows over `runnerWaves(campaignsDir, opts)` — the one construction the VERDICT and the CLI share. */
export function runnerRowsFromCampaigns(campaignsDir, opts = {}) {
  return runnerRowsFrom(runnerWaves(campaignsDir, opts))
}
