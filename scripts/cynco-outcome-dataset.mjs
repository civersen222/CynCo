/**
 * The outcome dataset and the frozen holdout (Phase 5, ruling 5).
 *
 * One row per LABELED mission, built from a PREFIX of its `turns[]`: the first
 * K turns by index, at two fixed points — K = 16 (primary) and K = 32
 * (secondary). The question every later learner answers is "could we have seen
 * this coming by turn K?", and only what was observable by turn K may enter the
 * answer.
 *
 * Why a FIXED K and not a fraction (Task 4 review I1): a prefix of `floor(n/2)`
 * turns has a length set by the finished run, so every signal that grows with
 * elapsed turns encoded `n` — `consecutiveUnstable.max` correlated 1.000 with
 * the prefix length, and failures run longer than successes. With a fixed K the
 * prefix is the same length for every mission; a mission with fewer than K
 * turns is EXCLUDED (and counted), never truncated, because a short prefix
 * would carry the length back in.
 *
 * Whole-mission fields (`verified`, `outcome`, `mutationSweep`, `toolStats`,
 * `durationS`, …) are written after the run ends; a feature built from one of
 * them describes the outcome after the fact. So `featuresOf` reads `row.turns`
 * and nothing else except `missionId` and the label, and the feature key set is
 * a fixed, documented list per signals version (`FEATURE_KEYS_V1`/`_V2`, benchmark/cynco-ledger/README.md
 * "Outcome dataset and the frozen holdout") that the leak test pins exactly.
 *
 * The label is `labelOf` from scripts/cynco-signal-validation.mjs — the ledger's
 * one labeling rule, imported, never restated.
 *
 * Unmeasured is `null`, never 0 (F16). One-hots are all zeros when the K-th
 * turn carries no value for that field; a value outside the vocabulary is also
 * all zeros and is COUNTED in `unknownValues` so a new engine enum is visible.
 *
 * The frozen holdout `benchmark/cynco-ledger/frozen-eval.json` is 20 % of the
 * eligible missions, stratified by label, drawn by a seeded shuffle. It is
 * written ONCE (`--freeze`); a later version comes only from `--refreeze`,
 * which only ever ADDS ids.
 *
 * Usage:
 * Signals version (F165): every row carries `signalsVersion`, the minimum over
 * its prefix's turns (1 when a turn has none — pre-F165 ledgers). v1 and v2
 * rows have different documented key sets (`FEATURE_KEYS_V1`,
 * `FEATURE_KEYS_V2`); `--signals-version N` exports only version-N rows.
 *
 *   bun scripts/cynco-outcome-dataset.mjs --export [--turns 16] [--signals-version N] [--out PATH] [--ledger-dir DIR]
 *   bun scripts/cynco-outcome-dataset.mjs --freeze   --seed N [--signals-version N] [--manifest PATH] [--ledger-dir DIR]
 *   bun scripts/cynco-outcome-dataset.mjs --refreeze --seed N [--signals-version N] [--manifest PATH] [--ledger-dir DIR]
 *
 * The holdout is one set per signals version (F165 fix round 2; see
 * "The holdout per signals version" below). Without --signals-version on a
 * Phase 5 (schema-1) file, --freeze/--refreeze behave exactly as in Phase 5.
 *
 * Phase 7 ruling 1 ("reading-level outcomes"): one row per inter-tick
 * interval instead of one row per mission — see `intervalsOf`/`intervalRows`
 * below and benchmark/cynco-ledger/README.md, "Reading-level outcomes".
 *
 *   bun scripts/cynco-outcome-dataset.mjs --export-intervals [--campaigns-dir DIR] [--signals-version N] [--out PATH] [--ledger-dir DIR]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readLedger } from './cynco-ledger-shards.mjs'
import { labelOf } from './cynco-signal-validation.mjs'
import { runnerWaves, NO_PROGRESS_RULE } from './cynco-runner-rows.mjs'

const REPO_LEDGER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'cynco-ledger')
export const MANIFEST_PATH = join(REPO_LEDGER_DIR, 'frozen-eval.json')
export const DATASET_PATH = (home) => join(home, 'datasets', 'outcome-dataset.jsonl')
/** Phase 7: one labeled sample per inter-tick interval (reading-level outcomes). */
export const DATASET_INTERVALS_PATH = (home) => join(home, 'datasets', 'outcome-dataset-intervals.jsonl')
/** An interval with fewer prefix turns than this is SHORT, not a row of nulls. */
export const INTERVAL_MIN_TURNS = 4
/**
 * Phase 7 ruling 1: the two units a learner is trained on. A mission row's
 * label is `labelOf` (true = landed); a reading row's is `improved` /
 * `stalled`, and its success class is `improved`. The two maps stay apart.
 */
export const MISSION_UNIT = 'mission'
export const READING_UNIT = 'reading'
export const READING_LABELS = Object.freeze({ positive: 'improved', negative: 'stalled' })
/** The manifest set a unit's holdout lives in: "<v>" (missions), "reading:<v>". */
export const setKeyOf = (v, unit = MISSION_UNIT) => (unit === MISSION_UNIT ? String(v) : `${unit}:${v}`)
/** A reading's identity in a holdout: `missionId:interval`. */
export const readingIdOf = (r) => `${r.missionId}:${r.interval}`
const readingLabeled = (r) => r?.label === READING_LABELS.positive || r?.label === READING_LABELS.negative
export const MANIFEST_SCHEMA = 1
/** The two fixed prefix points: primary and secondary. */
export const PREFIX_TURNS = Object.freeze([16, 32])
export const DEFAULT_TURNS = PREFIX_TURNS[0]
export const HOLDOUT_SHARE = 0.2

// ── Features ─────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const mean = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null)
const lastOf = (vals) => (vals.length ? vals[vals.length - 1] : null)
const maxOf = (vals) => (vals.length ? Math.max(...vals) : null)

/**
 * Numeric per-turn signals: [name, how to read it off one turn, aggregates].
 *
 * Every aggregate is a level or a per-turn rate, never a sum or a count of
 * turns — on a row whose signals are constant, every feature is the same at
 * K = 16 and K = 32 (the leak test pins it). The three counters:
 * - `consecutiveUnstable` increments on every unstable turn, so its mean over
 *   the prefix tracks the turn index; only `.last`/`.max` (bounded by K) stay.
 * - `algedonicAlerts` is a running count of alerts fired so far IN THE ENGINE
 *   SESSION, so its level carries alerts from before the mission began (turn-0
 *   values 0–57, r −0.38 with total turns: an era confound). Only `.rate` —
 *   new alerts per turn across the prefix, (last − first) ÷ (turns between
 *   them) — is measured from the prefix's own first value; `.last`/`.max` were
 *   dropped (final review T4-N2: at fixed K they collapse onto `.rate` once the
 *   pre-mission count is subtracted, and without it they are the leak).
 * - `stuckTurns` is the current stuck streak (it resets); `.rate` is the share
 *   of prefix turns spent stuck (streak > 0).
 */
const NUMERIC = [
  ['toolSuccessRate', t => t.toolSuccessRate, ['mean', 'last', 'max']],
  ['stuckTurns', t => t.stuckTurns, ['rate', 'last', 'max']],
  ['varietyRatio', t => t.varietyRatio, ['mean', 'last', 'max']],
  ['varietyWindowed', t => t.varietyWindowed, ['mean', 'last', 'max']],
  ['taskError', t => t.taskError, ['mean', 'last', 'max']],
  ['infoGain', t => t.infoGain, ['mean', 'last', 'max']],
  ['progressRate', t => t.progressRate, ['mean', 'last', 'max']],
  // v1 rows: a cumulative count, so `.rate` is new alerts per turn. v2 rows
  // (F165): the count in the last 20 turns, so `.rate` is its change per turn;
  // the v1 quantity is `algedonicAlertsTotal.rate` (NUMERIC_V2 below).
  ['algedonicAlerts', t => t.algedonicAlerts, ['rate']],
  // v1 rows: the turn index (C9: 1…394) — dead at fixed K. v2: a streak that
  // resets on a stable turn, capped at 50.
  ['consecutiveUnstable', t => t.consecutiveUnstable, ['last', 'max']],
  ['axiomViolations', t => (Array.isArray(t.axiomHealth?.violations) ? t.axiomHealth.violations.length : null), ['mean', 'last', 'max']],
  ['toolEntropyMean', t => t.brain?.toolEntropy?.mean, ['mean', 'last', 'max']],
  ['toolEntropyMax', t => t.brain?.toolEntropy?.max, ['mean', 'last', 'max']],
]

/** `.rate` per counter: see the NUMERIC comment. `points` are [turnIndex, value]. */
const RATE = {
  algedonicAlerts: (points) => {
    if (points.length < 2) return null
    const [i0, v0] = points[0]
    const [i1, v1] = points[points.length - 1]
    return (v1 - v0) / (i1 - i0)
  },
  stuckTurns: (points) => (points.length ? points.filter(([, v]) => v > 0).length / points.length : null),
}
RATE.algedonicAlertsTotal = RATE.algedonicAlerts

/**
 * F165: signals only a v2 turn carries. `algedonicAlertsTotal` is the
 * engine-wide cumulative count (what v1 called algedonicAlerts), so only its
 * `.rate` is a prefix feature, for the same era-confound reason.
 */
const NUMERIC_V2 = [
  ['algedonicAlertsTotal', t => t.algedonicAlertsTotal, ['rate']],
]

/** A turn's signal-vector version: 1 when the ledger wrote none (pre-F165). */
const turnVersion = (t) => (typeof t?.signalsVersion === 'number' ? t.signalsVersion : 1)

/** The version of a prefix: the MINIMUM over its turns, so a prefix that
 *  mixes versions is read as the older one. */
export function signalsVersionOf(prefix) {
  return prefix.length ? Math.min(...prefix.map(turnVersion)) : 1
}

/** Categorical signals read off the K-th (last prefix) turn, one-hot over a
 *  fixed vocabulary (the engine's enums). */
const CATEGORICAL = [
  ['errorTrend', t => t.errorTrend, ['rising', 'flat', 'falling']],
  ['explorationState', t => t.explorationState, ['healthy_exploration', 'thrashing', 'floundering']],
  ['health', t => t.health, ['healthy', 'warning', 'critical']],
  ['s3s4Balance', t => t.s3s4Balance, ['balanced', 's3_dominant', 's4_dominant', 'critical']],
  ['varietyBalance', t => t.varietyBalance, ['balanced', 'underload', 'overload', 'critical']],
  ['commander', t => t.heterarchy?.commander, ['S1', 'S2', 'S3', 'S4', 'S5']],
]

/** The documented key set of a v1 row (pre-F165 turns). */
export const FEATURE_KEYS_V1 = Object.freeze([
  ...NUMERIC.flatMap(([n, , aggs]) => aggs.map(a => `${n}.${a}`)),
  'brainPresent',
  ...CATEGORICAL.flatMap(([n, , vocab]) => vocab.map(v => `${n}.${v}`)),
])
/** The documented key set of a v2 row: v1's plus the v2-only signals. */
export const FEATURE_KEYS_V2 = Object.freeze([
  ...FEATURE_KEYS_V1,
  ...NUMERIC_V2.flatMap(([n, , aggs]) => aggs.map(a => `${n}.${a}`)),
])
/** The key set per signals version. */
export const FEATURE_KEYS_BY_VERSION = Object.freeze({ 1: FEATURE_KEYS_V1, 2: FEATURE_KEYS_V2 })

function checkTurns(K) {
  if (!Number.isInteger(K) || K < 1) throw new Error(`turns must be a positive integer, got ${K}`)
}

export const turnsOf = (row) => (Array.isArray(row.turns) ? row.turns : [])

/**
 * The Phase 5/6 aggregates over an arbitrary turn slice: the same NUMERIC /
 * NUMERIC_V2 / CATEGORICAL computation `featuresOf` and `intervalsOf` share,
 * so a mission's K-turn prefix and a wave's inter-tick slice can never drift
 * apart (Task 1 review: the two were a copy-paste away from disagreeing).
 */
function aggregatesOf(slice) {
  const signalsVersion = signalsVersionOf(slice)
  const features = {}
  for (const [name, read, aggs] of signalsVersion >= 2 ? [...NUMERIC, ...NUMERIC_V2] : NUMERIC) {
    const points = []
    slice.forEach((t, i) => { const v = num(read(t ?? {})); if (v !== null) points.push([i, v]) })
    const vals = points.map(([, v]) => v)
    for (const a of aggs) {
      features[`${name}.${a}`] = a === 'mean' ? mean(vals) : a === 'last' ? lastOf(vals) : a === 'max' ? maxOf(vals) : RATE[name](points)
    }
  }
  features.brainPresent = slice.some(t => num(t?.brain?.toolEntropy?.mean) !== null || num(t?.brain?.toolEntropy?.max) !== null) ? 1 : 0
  const last = slice[slice.length - 1] ?? {}
  for (const [name, read, vocab] of CATEGORICAL) {
    const v = read(last)
    for (const option of vocab) features[`${name}.${option}`] = v === option ? 1 : 0
  }
  return { signalsVersion, features }
}

/**
 * The feature vector of one mission's first K turns. Reads `row.turns`,
 * `row.missionId` and the label — nothing else on the row. Throws on a mission
 * with fewer than K turns: a truncated prefix would leak the length.
 */
export function featuresOf(row, K = DEFAULT_TURNS) {
  checkTurns(K)
  const all = turnsOf(row)
  if (all.length < K) throw new Error(`${row.missionId}: ${all.length} turns, fewer than K = ${K}`)
  const prefix = all.slice(0, K)
  const { signalsVersion, features } = aggregatesOf(prefix)
  return { missionId: row.missionId, prefixTurns: K, signalsVersion, label: labelOf(row), features, leakGuard: true }
}

/** Categorical values on the K-th turn that fall outside the vocabulary, as
 *  `<field>.<value>` strings (a null/absent value is not unknown, it is absent). */
function unknownCategoricals(row, K) {
  const last = turnsOf(row)[K - 1] ?? {}
  const out = []
  for (const [name, read, vocab] of CATEGORICAL) {
    const v = read(last)
    if (v !== null && v !== undefined && !vocab.includes(v)) out.push(`${name}.${v}`)
  }
  return out
}

/** Why a ledger row is not eligible at K, or null when it is. */
function exclusionOf(row, K) {
  if (labelOf(row) === null) return 'unlabeled'
  if (turnsOf(row).length < K) return 'short'
  return null
}

/**
 * One `featuresOf` row per labeled mission with ≥ K turns; the rest counted
 * (`excluded.unlabeled`, `excluded.short` — short at THIS K). `unknownValues`
 * counts out-of-vocabulary categorical values, `{ '<field>.<value>': n }`.
 * With `signalsVersion: N` (F165) only rows whose prefix is version N are kept
 * and the rest counted in `excluded.otherVersion`.
 */
export function datasetRows(rows, K = DEFAULT_TURNS, { signalsVersion = null } = {}) {
  checkTurns(K)
  if (signalsVersion !== null && !Number.isInteger(signalsVersion)) throw new Error(`signalsVersion must be an integer, got ${signalsVersion}`)
  const out = []
  const excluded = { unlabeled: 0, short: 0, ...(signalsVersion !== null ? { otherVersion: 0 } : {}) }
  const unknownValues = {}
  for (const row of rows) {
    const why = exclusionOf(row, K)
    if (why) { excluded[why]++; continue }
    const r = featuresOf(row, K)
    if (signalsVersion !== null && r.signalsVersion !== signalsVersion) { excluded.otherVersion++; continue }
    out.push(r)
    for (const key of unknownCategoricals(row, K)) unknownValues[key] = (unknownValues[key] ?? 0) + 1
  }
  return { rows: out, excluded, unknownValues }
}

// ── Reading-level outcomes: one row per inter-tick interval (Phase 7) ──────
//
// A wave's shadow decisions (`rec.shadowDecisions[]`) tick the fail count on a
// cadence; the span between two consecutive ticks is one labeled sample —
// "did the fail count fall by the next tick?" — built from the ledger turns
// whose timestamp falls inside that span, (atStart, atEnd]. This is 7–9×
// the rows per campaign that the one-row-per-mission `featuresOf` gives, from
// the SAME mid-wave grading Phase 6 already runs.
//
// `aggregatesOf` is shared with `featuresOf` above: the interval features use
// the identical key set (`interval.*` keys are ADDED, never substituted for
// one), so the two can never drift.

const round3 = (x) => Math.round(x * 1000) / 1000

/**
 * The wave's measured ticks: shadow decisions with a numeric `fails`, one per
 * `at`, in time order.
 *
 * Two corrections over the raw `shadowDecisions` (Task 1 review, fix round 1):
 *
 * - **Dedup prefers `R1.no-progress` explicitly (M2).** More than one rule
 *   decides at the same `at` (`R2.stalled` as of Phase 7 ruling 2); R2 carries
 *   no `startFails`, so a first-seen-wins dedupe would silently fall back to
 *   reading `startFails` off the wrong rule's tick — and off the first tick
 *   specifically, which decides `startFails` for the WHOLE interval set. The
 *   R1 decision at an `at` always wins when one exists; otherwise the first
 *   decision at that `at` is kept, same as before.
 * - **A faulted tick is dropped, not measured (I1).** `shadowNoProgress`
 *   copies the LAST MEASURED reading's `fails` onto a tick whose probe
 *   faulted (`cynco-campaign-progress.mjs:242` — a stale count is not a
 *   reading of now), so a faulted tick's decision carries a `fails` that was
 *   already true at the PREVIOUS tick. Treating it as a fresh reading mints a
 *   fabricated "stalled" interval out of nothing having been measured. Ticks
 *   whose `at` matches a `rec.progress` reading with `.fault` are dropped
 *   entirely; dropping one merges the spans on either side of it into a
 *   single interval, same as a skipped tick already did.
 */
function ticksOf(rec) {
  const faultedAts = new Set((Array.isArray(rec?.progress) ? rec.progress : []).filter(r => r?.fault).map(r => r.at))
  const byAt = new Map()
  for (const d of Array.isArray(rec?.shadowDecisions) ? rec.shadowDecisions : []) {
    if (!d || typeof d.at !== 'string' || typeof d.fails !== 'number' || !Number.isFinite(d.fails)) continue
    if (faultedAts.has(d.at)) continue
    const existing = byAt.get(d.at)
    if (!existing || (d.rule === NO_PROGRESS_RULE && existing.rule !== NO_PROGRESS_RULE)) byAt.set(d.at, d)
  }
  return [...byAt.values()]
    .map(d => ({ at: d.at, ms: Date.parse(d.at), fails: d.fails, elapsedFraction: d.elapsedFraction ?? null, startFails: d.startFails ?? null }))
    .filter(t => Number.isFinite(t.ms))
    .sort((a, b) => a.ms - b.ms)
}

/**
 * One interval per pair of consecutive ticks on `rec`, built from `row`'s
 * turns inside (atStart, atEnd]. `excluded` counts why an interval did not
 * become a row: `short` (fewer than INTERVAL_MIN_TURNS turns in the slice),
 * `noTicks` (fewer than 2 usable ticks — at most one row-level 0/1, not a
 * per-interval count), `noTurnTimes` (NO turn on the row carries a numeric
 * `t` — a v1/pre-F165-timestamp ledger row, at most one row-level 0/1; a turn
 * WITHOUT `t` on an otherwise-timed row is simply skipped, per turn — M5),
 * `otherVersion` (the slice's signals version is not the requested one),
 * `afterZero` (the interval starts at 0 fails — I2: once the gate is passing,
 * every later tick reads the same way `b.fails < a.fails` would call
 * "stalled", but a solved wave that is still ticking is not a stall).
 */
export function intervalsOf(rec, row, { signalsVersion = 2 } = {}) {
  const excluded = { short: 0, noTicks: 0, noTurnTimes: 0, otherVersion: 0, afterZero: 0 }
  const ticks = ticksOf(rec)
  if (ticks.length < 2) { excluded.noTicks = 1; return { intervals: [], excluded } }
  const turns = turnsOf(row).filter(t => typeof t?.t === 'number' && Number.isFinite(t.t))
  if (!turns.length) { excluded.noTurnTimes = 1; return { intervals: [], excluded } }
  const startFails = ticks[0].startFails ?? ticks[0].fails
  const intervals = []
  for (let i = 0; i + 1 < ticks.length; i++) {
    const a = ticks[i], b = ticks[i + 1]
    if (a.fails === 0) { excluded.afterZero++; continue }
    const slice = turns.filter(t => t.t > a.ms && t.t <= b.ms).sort((x, y) => x.t - y.t)
    if (slice.length < INTERVAL_MIN_TURNS) { excluded.short++; continue }
    const { signalsVersion: v, features } = aggregatesOf(slice)
    if (v !== signalsVersion) { excluded.otherVersion++; continue }
    features['interval.turns'] = slice.length
    features['interval.minutes'] = round3((b.ms - a.ms) / 60_000)
    features['interval.elapsedFractionStart'] = a.elapsedFraction
    features['interval.failsStart'] = a.fails
    features['interval.failsStartShare'] = startFails > 0 ? round3(a.fails / startFails) : null
    intervals.push({
      missionId: row.missionId, campaign: rec.campaign ?? row.campaignId ?? null, wave: rec.wave ?? null, interval: i,
      at: [a.at, b.at], failsStart: a.fails, failsEnd: b.fails, label: b.fails < a.fails ? 'improved' : 'stalled',
      signalsVersion: v, turns: slice.length, features, leakGuard: true,
    })
  }
  return { intervals, excluded }
}

/**
 * `intervalsOf` over every wave, joined to its ledger row by `missionId`
 * (`rows` from `readLedger`, `waves` the wave records — `runnerWaves(...)`
 * mapped to its bare records for the CLI). A wave with no matching row is
 * counted in `excluded.noRow` and contributes nothing; `waves` is the number
 * of waves that DID join a row.
 */
export function intervalRows(rows, waves, { signalsVersion = 2 } = {}) {
  const byId = new Map((Array.isArray(rows) ? rows : []).map(r => [r.missionId, r]))
  const out = []
  const excluded = { short: 0, noTicks: 0, noTurnTimes: 0, otherVersion: 0, afterZero: 0, noRow: 0 }
  let n = 0
  for (const w of Array.isArray(waves) ? waves : []) {
    const row = w?.missionId ? byId.get(w.missionId) : null
    if (!row) { excluded.noRow++; continue }
    n++
    const r = intervalsOf(w, row, { signalsVersion })
    out.push(...r.intervals)
    for (const k of Object.keys(r.excluded)) excluded[k] += r.excluded[k]
  }
  return { rows: out, excluded, waves: n }
}

// ── The frozen holdout ───────────────────────────────────────────

/**
 * Split rows by the manifest. Manifest ids that match no row are reported in
 * `missing`, never dropped. With `turns: K` the rows are LEDGER rows: those not
 * eligible at K (unlabeled, or fewer than K turns) leave both splits, and held
 * ids among them are reported in `ineligible`.
 */
export function frozenSplit(rows, manifest, { turns = null, unit = MISSION_UNIT } = {}) {
  // Phase 7 ruling 1: a reading set's `missionIds` are whole missions — the
  // split below is by `missionId` for both units, so every reading of a held
  // mission is held. A reading has no K-turn prefix to be eligible at.
  if (unit !== MISSION_UNIT && turns !== null) throw new Error(`turns: K applies to the mission unit only, not '${unit}'`)
  const held = new Set(manifest?.missionIds ?? [])
  const seen = new Set(rows.map(r => r.missionId))
  const ineligible = []
  let usable = rows
  if (turns !== null) {
    checkTurns(turns)
    usable = rows.filter(r => {
      const ok = exclusionOf(r, turns) === null
      if (!ok && held.has(r.missionId)) ineligible.push(r.missionId)
      return ok
    })
  }
  return {
    train: usable.filter(r => !held.has(r.missionId)),
    holdout: usable.filter(r => held.has(r.missionId)),
    missing: [...held].filter(id => !seen.has(id)),
    ineligible,
  }
}

/** mulberry32: a 32-bit seeded PRNG, so a manifest is reproducible from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One stream per label (review M4), so a new failure mission does not move
 *  which successes a draw picks. v1 was drawn from a single shared stream. */
const LABEL_STREAM = { false: 0x1B873593, true: 0x5BD1E995 }

/** Sorted by id first, so the draw depends on the seed and not the input order. */
function seededShuffle(ids, rand) {
  const a = [...ids].sort()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * The holdout manifest: HOLDOUT_SHARE of the rows eligible at `turns` (labeled,
 * ≥ K turns; default the primary K) rounded to nearest, split across labels in
 * proportion, at least one of each label when both exist. With `previous`,
 * every previous id is kept (refreeze only adds) and each label's share is
 * topped up from the rows not yet held.
 */
export function freezeManifest(rows, { seed, version, previous = null, turns = DEFAULT_TURNS, now = () => new Date().toISOString(), unit = MISSION_UNIT } = {}) {
  if (!Number.isInteger(seed)) throw new Error(`seed must be an integer, got ${seed}`)
  if (unit === READING_UNIT) return freezeReadingManifest(rows, { seed, version, previous, now })
  if (unit !== MISSION_UNIT) throw new Error(`unknown unit '${unit}'`)
  checkTurns(turns)
  const eligible = rows.filter(r => exclusionOf(r, turns) === null)
  const byLabel = { false: [], true: [] }
  for (const r of eligible) byLabel[String(labelOf(r))].push(r.missionId)
  const bothLabels = byLabel.false.length > 0 && byLabel.true.length > 0
  const rounded = Math.round(eligible.length * HOLDOUT_SHARE)
  const total = bothLabels ? Math.max(2, rounded) : rounded
  const target = { false: 0, true: 0 }
  if (eligible.length) {
    target.false = Math.round(total * byLabel.false.length / eligible.length)
    target.true = total - target.false
    if (bothLabels) {
      if (target.false === 0) { target.false = 1; target.true = total - 1 }
      if (target.true === 0) { target.true = 1; target.false = total - 1 }
    }
  }
  const held = new Set(previous?.missionIds ?? [])
  for (const label of ['false', 'true']) {
    const rand = mulberry32((seed ^ LABEL_STREAM[label]) >>> 0)
    let have = byLabel[label].filter(id => held.has(id)).length
    for (const id of seededShuffle(byLabel[label].filter(id => !held.has(id)), rand)) {
      if (have >= target[label]) break
      held.add(id)
      have++
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    version: version ?? (previous ? (previous.version ?? 1) + 1 : 1),
    seed,
    frozenAt: now(),
    missionIds: [...held].sort(),
  }
}

/** The reading unit's own stream, apart from the two mission label streams. */
const READING_STREAM = 0x27D4EB2F

/**
 * The reading unit's holdout (Phase 7 ruling 1): Phase 5's rule — HOLDOUT_SHARE
 * of the labeled readings, split across the two labels in proportion, at least
 * one of each when both exist, a seeded shuffle — drawn by WHOLE MISSIONS, so
 * one mission's intervals never straddle train and holdout. Missions are taken
 * in seeded order while either label is short of its share (a mission is
 * skipped when it holds only readings of labels already met), so the held count
 * can run over the share by part of one mission. `missionIds` is the split key;
 * `ids` the readings (`missionId:interval`) held at freeze time. With
 * `previous`, every previous mission is kept (refreeze only adds).
 */
function freezeReadingManifest(rows, { seed, version, previous = null, now }) {
  const pool = rows.filter(readingLabeled)
  const byMission = new Map()
  const total = { improved: 0, stalled: 0 }
  for (const r of pool) {
    const c = byMission.get(r.missionId) ?? { improved: 0, stalled: 0 }
    c[r.label]++
    total[r.label]++
    byMission.set(r.missionId, c)
  }
  const both = total.improved > 0 && total.stalled > 0
  const rounded = Math.round(pool.length * HOLDOUT_SHARE)
  const want = both ? Math.max(2, rounded) : rounded
  const target = { improved: 0, stalled: 0 }
  if (pool.length) {
    target.stalled = Math.round(want * total.stalled / pool.length)
    target.improved = want - target.stalled
    if (both) {
      if (target.stalled === 0) { target.stalled = 1; target.improved = want - 1 }
      if (target.improved === 0) { target.improved = 1; target.stalled = want - 1 }
    }
  }
  const held = new Set(previous?.missionIds ?? [])
  const have = { improved: 0, stalled: 0 }
  for (const id of held) { const c = byMission.get(id); if (c) { have.improved += c.improved; have.stalled += c.stalled } }
  const rand = mulberry32((seed ^ READING_STREAM) >>> 0)
  for (const id of seededShuffle([...byMission.keys()].filter(id => !held.has(id)), rand)) {
    const short = (l) => have[l] < target[l]
    if (!short('improved') && !short('stalled')) break
    const c = byMission.get(id)
    if (!((c.improved && short('improved')) || (c.stalled && short('stalled')))) continue
    held.add(id)
    have.improved += c.improved
    have.stalled += c.stalled
  }
  return {
    schema: MANIFEST_SCHEMA,
    unit: READING_UNIT,
    version: version ?? (previous ? (previous.version ?? 1) + 1 : 1),
    seed,
    frozenAt: now(),
    missionIds: [...held].sort(),
    ids: pool.filter(r => held.has(r.missionId)).map(readingIdOf).sort(),
  }
}

// ── The holdout per signals version (F165, fix round 2) ──────────
//
// v1 and v2 rows never mix (F165), so one id set cannot serve both: every v1
// id is useless to a v2 learner, and a v2 learner with no held v2 id reads
// `holdout 0 < 8` for ever. The manifest file therefore holds ONE SET PER
// SIGNALS VERSION:
//
//   { schema: 2, sets: { "1": <the v1 manifest, verbatim>, "2": { … } },
//     history: [ { signalsVersion, frozenAt, count, eligible, seed, how } ] }
//
// where each set is exactly what `freezeManifest` returns (Phase 5's shape and
// selection rule). The schema-1 file (Phase 5; the committed one) is read as
// `sets["1"]`, byte-for-byte, and is migrated on the first write. A set, once
// written, is never replaced — frozen means frozen; `--refreeze` only adds.

export const MANIFEST_FILE_SCHEMA = 2
/** The model's own minimums (scripts/cynco-outcome-model.py `--min-train` 30,
 *  `--min-holdout` 8). */
export const MODEL_MIN_TRAIN = 30
export const MODEL_MIN_HOLDOUT = 8
/**
 * The smallest eligible pool of one signals version from which a
 * HOLDOUT_SHARE draw leaves the model trainable: a holdout of at least
 * MODEL_MIN_HOLDOUT and a training split of at least MODEL_MIN_TRAIN (38:
 * round(7.6) = 8 held, 30 left). Phase 5's `--refreeze` had no minimum of its
 * own — it was run by hand on a 107-mission pool — so the automatic freeze
 * takes the one the model enforces.
 */
export const FREEZE_MIN_ELIGIBLE = (() => {
  for (let n = 1; ; n++) {
    const held = Math.round(n * HOLDOUT_SHARE)
    if (held >= MODEL_MIN_HOLDOUT && n - held >= MODEL_MIN_TRAIN) return n
  }
})()
/** The seed an automatic freeze draws with (recorded on the set and the history). */
export const AUTO_FREEZE_SEED = 20260929

/**
 * Any manifest file as the per-version shape. A schema-1 file (Phase 5) is
 * version 1's set, kept verbatim; a schema-2 file is returned as is; null (no
 * file) is an empty file. Anything else throws — a manifest that cannot be
 * read is never silently an empty holdout.
 */
export function manifestSets(raw) {
  if (raw === null || raw === undefined) return { schema: MANIFEST_FILE_SCHEMA, sets: {}, history: [] }
  if (raw.schema === MANIFEST_FILE_SCHEMA && raw.sets && typeof raw.sets === 'object') {
    return { schema: MANIFEST_FILE_SCHEMA, sets: raw.sets, history: Array.isArray(raw.history) ? raw.history : [] }
  }
  if (raw.schema === MANIFEST_SCHEMA && Array.isArray(raw.missionIds)) {
    return { schema: MANIFEST_FILE_SCHEMA, sets: { 1: raw }, history: [] }
  }
  throw new Error(`not a frozen-eval manifest (schema ${raw?.schema ?? 'none'})`)
}

/** Read the manifest file at `path` in the per-version shape (no file → empty). */
export function readManifestFile(path) {
  return manifestSets(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
}

/** Signals version `v`'s frozen set of `unit` (Phase 7: "reading:<v>" for
 *  readings), or null when none has been frozen. */
export function heldSetFor(file, v, { unit = MISSION_UNIT } = {}) {
  return file?.sets?.[setKeyOf(v, unit)] ?? null
}

/** The rows whose K-turn prefix is signals version `v`. */
export function rowsOfVersion(rows, v, K = DEFAULT_TURNS) {
  return rows.filter(r => signalsVersionOf(turnsOf(r).slice(0, K)) === v)
}

/**
 * `file` with version `v`'s set written and a history entry appended. Refuses
 * to replace an existing set unless `add` is set (the `--refreeze` path, whose
 * `freezeManifest(…, { previous })` only ever adds ids).
 */
export function withVersionSet(file, v, set, entry, { add = false, unit = MISSION_UNIT } = {}) {
  const key = setKeyOf(v, unit)
  if (heldSetFor(file, v, { unit }) && !add) throw new Error(`the ${unit === MISSION_UNIT ? `signals v${v}` : key} holdout is already frozen — frozen means frozen`)
  // The history entry names a non-mission unit; a mission entry keeps Phase 5's shape.
  return { schema: MANIFEST_FILE_SCHEMA, sets: { ...file.sets, [key]: set },
    history: [...(file.history ?? []), { signalsVersion: v, ...(unit === MISSION_UNIT ? {} : { unit }), ...entry }] }
}

/**
 * The hindcast's holdout for signals version `v`: the frozen set when there
 * is one; otherwise, when `v`'s eligible pool (labeled, ≥ K turns, prefix
 * version `v`) has reached FREEZE_MIN_ELIGIBLE, the set is frozen NOW with
 * `freezeManifest` — Phase 5's selection rule, over that version's rows —
 * written to `path` once and never touched again; otherwise not frozen, with
 * the counts. Returns `{ set, holdout }`; `holdout` is
 * `{ frozen, frozenNow, frozenAt, ids }`, `{ frozen: false, eligible, needed }`
 * (the pool is too small), or `{ frozen: false, eligible, needed, pass, fail,
 * needEach }` (Task 2 review N4: large enough, but short of
 * MODEL_MIN_HOLDOUT of one label — a holdout frozen from a one-class pool can
 * never give an AUC, and a frozen set only grows by a hand `--refreeze`).
 */
export function ensureVersionHoldout({ rows, path, v, K = DEFAULT_TURNS, seed = AUTO_FREEZE_SEED, now = () => new Date().toISOString(), unit = MISSION_UNIT }) {
  if (unit === READING_UNIT) return ensureReadingHoldout({ rows, path, v, seed, now })
  if (unit !== MISSION_UNIT) throw new Error(`unknown unit '${unit}'`)
  const file = readManifestFile(path)
  const existing = heldSetFor(file, v)
  if (existing) return { set: existing, holdout: { frozen: true, frozenNow: false, frozenAt: existing.frozenAt ?? null, ids: existing.missionIds.length } }
  const pool = rowsOfVersion(rows, v, K).filter(r => exclusionOf(r, K) === null)
  if (pool.length < FREEZE_MIN_ELIGIBLE) return { set: null, holdout: { frozen: false, eligible: pool.length, needed: FREEZE_MIN_ELIGIBLE } }
  const pass = pool.filter(r => labelOf(r) === true).length, fail = pool.length - pass
  if (pass < MODEL_MIN_HOLDOUT || fail < MODEL_MIN_HOLDOUT) {
    return { set: null, holdout: { frozen: false, eligible: pool.length, needed: FREEZE_MIN_ELIGIBLE, pass, fail, needEach: MODEL_MIN_HOLDOUT } }
  }
  const set = freezeManifest(pool, { seed, turns: K, now })
  writeAtomic(path, JSON.stringify(withVersionSet(file, v, set,
    { frozenAt: set.frozenAt, count: set.missionIds.length, eligible: pool.length, seed, how: 'auto' }), null, 2) + '\n')
  return { set, holdout: { frozen: true, frozenNow: true, frozenAt: set.frozenAt, ids: set.missionIds.length } }
}

/**
 * `ensureVersionHoldout` for the reading unit (Phase 7 ruling 1): `rows` are
 * interval rows (`intervalRows`); the pool is version `v`'s labeled readings.
 * The rule is the mission unit's — frozen once, at FREEZE_MIN_ELIGIBLE
 * readings with at least MODEL_MIN_HOLDOUT of each label — into the set
 * `reading:<v>`, recorded on the history; every other set is written back
 * untouched. Not frozen ALWAYS carries both label counts:
 * `{ frozen: false, unit, eligible, needed, improved, stalled, needEach }`;
 * frozen: `{ frozen, frozenNow, frozenAt, ids, missions }` (`ids` readings).
 */
function ensureReadingHoldout({ rows, path, v, seed, now }) {
  const file = readManifestFile(path)
  const existing = heldSetFor(file, v, { unit: READING_UNIT })
  const frozenAs = (set, frozenNow) => ({ frozen: true, frozenNow, frozenAt: set.frozenAt ?? null,
    ids: Array.isArray(set.ids) ? set.ids.length : null, missions: set.missionIds.length })
  if (existing) return { set: existing, holdout: frozenAs(existing, false) }
  const pool = (Array.isArray(rows) ? rows : []).filter(r => r?.signalsVersion === v && readingLabeled(r))
  const improved = pool.filter(r => r.label === READING_LABELS.positive).length, stalled = pool.length - improved
  if (pool.length < FREEZE_MIN_ELIGIBLE || improved < MODEL_MIN_HOLDOUT || stalled < MODEL_MIN_HOLDOUT) {
    return { set: null, holdout: { frozen: false, unit: READING_UNIT, eligible: pool.length, needed: FREEZE_MIN_ELIGIBLE, improved, stalled, needEach: MODEL_MIN_HOLDOUT } }
  }
  const set = freezeManifest(pool, { unit: READING_UNIT, seed, now })
  writeAtomic(path, JSON.stringify(withVersionSet(file, v, set,
    { frozenAt: set.frozenAt, count: set.ids.length, missions: set.missionIds.length, eligible: pool.length, seed, how: 'auto' }, { unit: READING_UNIT }), null, 2) + '\n')
  return { set, holdout: frozenAs(set, true) }
}

// ── CLI ──────────────────────────────────────────────────────────

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

function argOf(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function counts(rows, manifest, K) {
  const eligible = rows.filter(r => exclusionOf(r, K) === null)
  const held = new Set(manifest.missionIds)
  const holdout = eligible.filter(r => held.has(r.missionId))
  return {
    eligible: eligible.length,
    eligibleFailures: eligible.filter(r => labelOf(r) === false).length,
    holdout: manifest.missionIds.length,
    holdoutFailures: holdout.filter(r => labelOf(r) === false).length,
    holdoutSuccesses: holdout.filter(r => labelOf(r) === true).length,
  }
}

// `engine/paths.js` is TypeScript behind a `.js` specifier and loads only under
// bun, so it is imported lazily and only when --out is not given.
export async function main(argv, io = console) {
  if (argv.includes('--fraction')) {
    io.error('refused: --fraction was removed (a fractional prefix leaks the mission length); use --turns K')
    return 2
  }
  const turnsArg = argOf(argv, '--turns')
  const K = turnsArg === undefined ? DEFAULT_TURNS : Number(turnsArg)
  if (!Number.isInteger(K) || K < 1) {
    io.error(`refused: --turns must be a positive integer, got ${turnsArg}`)
    return 2
  }
  const versionArg = argOf(argv, '--signals-version')
  const signalsVersion = versionArg === undefined ? null : Number(versionArg)
  if (signalsVersion !== null && !(Number.isInteger(signalsVersion) && signalsVersion >= 1)) {
    io.error(`refused: --signals-version must be a positive integer, got ${versionArg}`)
    return 2
  }
  const rows = readLedger(argOf(argv, '--ledger-dir') ?? REPO_LEDGER_DIR)
  if (argv.includes('--export')) {
    const out = argOf(argv, '--out') !== undefined
      ? resolve(argOf(argv, '--out'))
      : DATASET_PATH((await import('../engine/paths.js')).cyncoHome())
    const { rows: ds, excluded, unknownValues } = datasetRows(rows, K, { signalsVersion })
    writeAtomic(out, ds.map(r => JSON.stringify(r)).join('\n') + (ds.length ? '\n' : ''))
    const unknown = Object.entries(unknownValues).map(([k, n]) => `${k} ×${n}`)
    io.log(`outcome dataset: ${ds.length} rows at K = ${K} turns${signalsVersion !== null ? `, signals v${signalsVersion}` : ''} (excluded ${excluded.unlabeled} unlabeled, ${excluded.short} short` +
      `${signalsVersion !== null ? `, ${excluded.otherVersion} other signals version` : ''})` +
      `${unknown.length ? `; unknown categorical values: ${unknown.join(', ')}` : ''} → ${out}`)
    return 0
  }
  if (argv.includes('--export-intervals')) {
    const campaignsArg = argOf(argv, '--campaigns-dir')
    const outArg = argOf(argv, '--out')
    const home = (campaignsArg === undefined || outArg === undefined) ? (await import('../engine/paths.js')).cyncoHome() : null
    const campaignsDir = campaignsArg !== undefined ? resolve(campaignsArg) : join(home, 'campaigns')
    const out = outArg !== undefined ? resolve(outArg) : DATASET_INTERVALS_PATH(home)
    const waves = runnerWaves(campaignsDir).map(({ record }) => record)
    const { rows: intervals, excluded, waves: n } = intervalRows(rows, waves, { signalsVersion: signalsVersion ?? 2 })
    writeAtomic(out, intervals.map(r => JSON.stringify(r)).join('\n') + (intervals.length ? '\n' : ''))
    io.log(`reading-level outcomes: ${intervals.length} rows from ${n} waves (excluded ${excluded.short} short, ${excluded.noTicks} no ticks, ` +
      `${excluded.noTurnTimes} no turn times, ${excluded.otherVersion} other signals version, ${excluded.afterZero} after zero fails, ${excluded.noRow} no ledger row) → ${out}`)
    return 0
  }
  const freeze = argv.includes('--freeze')
  const refreeze = argv.includes('--refreeze')
  if (freeze || refreeze) {
    const seed = Number(argOf(argv, '--seed'))
    if (argOf(argv, '--seed') === undefined || !Number.isInteger(seed)) {
      io.error('refused: --seed N (an integer) is required')
      return 2
    }
    const path = resolve(argOf(argv, '--manifest') ?? MANIFEST_PATH)
    // F165 fix round 2: with --signals-version, or on a per-version file, the
    // freeze targets ONE version's set; the same two rules hold per set
    // (--freeze refuses an existing set, --refreeze only adds to one).
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    const file = raw ? manifestSets(raw) : null
    const onFile = raw?.schema === MANIFEST_FILE_SCHEMA
    if (signalsVersion !== null || onFile) {
      const v = signalsVersion ?? 1
      const had = file ? heldSetFor(file, v) : null
      if (freeze && had) {
        io.error(`refused: the signals v${v} holdout in ${path} is frozen — frozen once; use --refreeze --signals-version ${v} to add ids`)
        return 2
      }
      if (refreeze && !had) {
        io.error(`refused: no signals v${v} holdout in ${path} to refreeze — use --freeze --signals-version ${v} first`)
        return 2
      }
      const vRows = rowsOfVersion(rows, v, K)
      const set = freezeManifest(vRows, { seed, previous: had, turns: K })
      const eligibleN = vRows.filter(r => exclusionOf(r, K) === null).length
      writeAtomic(path, JSON.stringify(withVersionSet(file ?? manifestSets(null), v, set,
        { frozenAt: set.frozenAt, count: set.missionIds.length, eligible: eligibleN, seed, how: freeze ? 'freeze' : 'refreeze' }, { add: refreeze }), null, 2) + '\n')
      const c = counts(vRows, set, K)
      io.log(`frozen holdout signals v${v}, set v${set.version} (seed ${seed}, K = ${K}): ${c.holdout} of ${c.eligible} eligible v${v} missions ` +
        `(${c.holdoutFailures} failures, ${c.holdoutSuccesses} successes; eligible ${c.eligibleFailures} failures) → ${path}`)
      return 0
    }
    let previous = null
    if (freeze && existsSync(path)) {
      io.error(`refused: ${path} exists — the holdout is frozen once; use --refreeze to add ids`)
      return 2
    }
    if (refreeze) {
      if (!existsSync(path)) {
        io.error(`refused: no manifest at ${path} to refreeze — use --freeze first`)
        return 2
      }
      previous = JSON.parse(readFileSync(path, 'utf8'))
    }
    const manifest = freezeManifest(rows, { seed, previous, turns: K })
    writeAtomic(path, JSON.stringify(manifest, null, 2) + '\n')
    const c = counts(rows, manifest, K)
    const { missing, ineligible } = frozenSplit(rows, manifest, { turns: K })
    io.log(`frozen holdout v${manifest.version} (seed ${seed}, K = ${K}): ${c.holdout} of ${c.eligible} eligible missions ` +
      `(${c.holdoutFailures} failures, ${c.holdoutSuccesses} successes; eligible ${c.eligibleFailures} failures)` +
      `${missing.length ? `; ${missing.length} held ids not in the ledger: ${missing.join(', ')}` : ''}` +
      `${ineligible.length ? `; ${ineligible.length} held ids ineligible at K = ${K}: ${ineligible.join(', ')}` : ''} → ${path}`)
    return 0
  }
  io.error('usage: --export [--turns K] [--signals-version N] [--out PATH] | --export-intervals [--campaigns-dir DIR] [--signals-version N] [--out PATH] | --freeze --seed N [--signals-version N] | --refreeze --seed N [--signals-version N]  [--turns K] [--ledger-dir DIR] [--manifest PATH]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e?.message ?? e); process.exit(1) })
