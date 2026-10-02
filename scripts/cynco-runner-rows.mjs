// scripts/cynco-runner-rows.mjs — the runner rows for the rule ladder
// (Phase 6): `R1.no-progress` and (Phase 7) `R2.stalled`, the runner's shadow
// regulators, read off the wave records of every runner-driven campaign.
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
/**
 * Phase 7 ruling 2: `R2.stalled` — no decrease over the last `STALLED_WINDOW`
 * measured ticks, at ≥ `STALLED_AT` of the wall clock, with the latest count
 * > 0. Shadow, like R1; its row rides the same ladder.
 */
export const STALLED_AT = 0.25
export const STALLED_RULE = 'R2.stalled'
export const STALLED_WINDOW = 3

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The runner rows for the ladder (writeRuleVerdicts takes them beside the S5
 * rules and the `M1.*` model rows, `source: 'runner'`), from bare wave
 * records — `runnerRowsFromEntries` with no campaign named (a test's list; the
 * VERDICT and the CLI go through `runnerRowsFromCampaigns`).
 */
export function runnerRowsFrom(waves) {
  return runnerRowsFromEntries((Array.isArray(waves) ? waves : []).map((record, i) => ({ campaign: null, line: i + 1, record })))
}

/**
 * The runner rows from `{ campaign, line, record }` entries (runnerWaves). Two
 * rows, always, in this order: `R1.no-progress` (threshold `NO_PROGRESS_AT`)
 * and `R2.stalled` (Phase 7, `STALLED_AT`) — an empty scope is the honest
 * UNMEASURED, not an absent row. Each is `runnerRowFor` over the SAME entries
 * with its own rule id and threshold; below, "the rule" and "the threshold"
 * are that row's (the text was written for R1's 50 %).
 * - key: the wave's missionId, else `<campaign>#wave<n>` (final review M3: the
 *   wave the runner gives up on — `waited.timedOut` — has `missionId: null`,
 *   and "the wave burned its whole clock" is exactly the rule's target), else
 *   (a bare record with no campaign) `record #i`;
 * - scope: waves with a decision (a `stop` never ran and is not one) and ≥ 1
 *   `R1.no-progress` shadow DECISION at `elapsedFraction ≥ 0.5`, fired or not
 *   (Task 3 review I1). Scope reads the decisions, never the readings: a wave
 *   that stops committing before 50 % has its last reading below 50 % and only
 *   skipped ticks after it — exactly the rule's positives, which a
 *   readings-based scope dropped on every 8 h wave;
 * - unlabeled (final review I1): a wave that would be in scope but whose
 *   VERDICT is `kind: 'fault'` with `verified === null` — the grade itself did
 *   not run (the gate or suite harness-faulted). `labelOf` makes that mission
 *   UNLABELED for the S5 rules in the same Holm family, so it is unlabeled for
 *   R1 too: out of scope, named `{ missionId: <key>, why }`. A WAIT-timeout or
 *   post-run fault record (faultWave: no `verified` field at all) is NOT this —
 *   it stays in scope as a failure;
 * - fired: those scoped waves where any decision has `fired: true`;
 * - failed: those scoped waves whose decision is not `pass` /
 *   `pass-with-survivors` — the rule's OUTCOME (a firing on a wave that then
 *   passed was wrong; on any other decision, right);
 * - skipped: the wave records that are not a record at all, or whose
 *   `shadowDecisions` is neither absent nor an array — named (missionId, else
 *   `<campaign>/waves.jsonl line <n>`, else — a bare record with no campaign —
 *   `record #i`) and left out. One malformed line in any campaign's
 *   waves.jsonl costs that line, never the row (Task 4 review M1).
 * Recomputed from the records at every VERDICT, so nothing written is lost.
 */
export function runnerRowsFromEntries(entries) {
  return [
    runnerRowFor(entries, { id: NO_PROGRESS_RULE, at: NO_PROGRESS_AT }),
    runnerRowFor(entries, { id: STALLED_RULE, at: STALLED_AT }),
  ]
}

/**
 * One runner row: the scan `runnerRowsFromEntries` documents, for the rule
 * `id` over its decisions at `elapsedFraction ≥ at`. The row carries `at` so
 * an empty scope can name the rule's own threshold (cynco-rule-verdicts.mjs).
 */
export function runnerRowFor(entries, { id, at }) {
  const scope = new Set(), fired = new Set(), failed = new Set(), skipped = [], unlabeled = []
  ;(Array.isArray(entries) ? entries : []).forEach(({ campaign = null, line, record: w } = {}, i) => {
    const missionId = isRecord(w) && typeof w.missionId === 'string' && w.missionId ? w.missionId : null
    if (!isRecord(w) || (w.shadowDecisions != null && !Array.isArray(w.shadowDecisions))) {
      // Task 4 review N2: named by where it lives, not by its index in the
      // combined list of every campaign's records.
      skipped.push(missionId ?? (campaign ? `${campaign}/waves.jsonl line ${line}` : `record #${i + 1}`))
      return
    }
    const kind = isRecord(w.decision) ? w.decision.kind : undefined
    if (!kind || kind === 'stop') return
    const pastThreshold = (w.shadowDecisions ?? []).filter(d => isRecord(d) && d.rule === id
      && typeof d.elapsedFraction === 'number' && d.elapsedFraction >= at)
    if (!pastThreshold.length) return
    const key = missionId ?? (campaign ? `${campaign}#wave${w.wave ?? '?'}` : `record #${line ?? i + 1}`)
    if (kind === 'fault' && w.verified === null) {
      unlabeled.push({ missionId: key, why: `the grade did not run — ${w.decision.why ?? 'harness fault'}` })
      return
    }
    scope.add(key)
    if (pastThreshold.some(d => d.fired === true)) fired.add(key)
    if (kind !== 'pass' && kind !== 'pass-with-survivors') failed.add(key)
  })
  return { id, source: 'runner', at, fired, scope, failed, skipped, unlabeled }
}

/**
 * Every wave record the runner's shadow regulator is judged over, as
 * `{ campaign, line, record }` — the campaign being graded (`entries` from its
 * own state's `waveEntries()`, with `rec`, the wave just recorded, in place of
 * its stored copy) and every OTHER runner-driven campaign under `campaignsDir`
 * (a dir holding a `waves.jsonl`; a dir without one contributes nothing). A dir
 * named `current` is skipped: the state handed over is that campaign's record.
 * With no `current` (the CLI) every dir is read. Reads only; an unparseable
 * line is skipped by CampaignState.waveEntries().
 */
export function runnerWaves(campaignsDir, { current = null, entries = [], rec = null } = {}) {
  const mine = entries.map(({ line, record }) => ({ campaign: current, line, record }))
  const last = mine.at(-1)
  const own = !rec ? mine
    : last && isRecord(last.record) && last.record.wave === rec.wave ? [...mine.slice(0, -1), { ...last, record: rec }]
      : [...mine, { campaign: current, line: (last?.line ?? 0) + 1, record: rec }]
  const names = existsSync(campaignsDir)
    ? readdirSync(campaignsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== current).map(d => d.name).sort()
    : []
  const others = names.flatMap(name => new CampaignState(join(campaignsDir, name)).waveEntries().map(({ line, record }) => ({ campaign: name, line, record })))
  return [...others, ...own]
}

/** The runner rows over `runnerWaves(campaignsDir, opts)` — the one construction the VERDICT and the CLI share. */
export function runnerRowsFromCampaigns(campaignsDir, opts = {}) {
  return runnerRowsFromEntries(runnerWaves(campaignsDir, opts))
}
