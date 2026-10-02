// scripts/cynco-hindcast.mjs — the outcome hindcast the campaign runner retrains
// at every VERDICT (Phase 5, ruling 5).
//
// Three steps, each a seam of the runner's `io` so a unit test never spawns
// python or reads the live ledger:
//
//   1. `exportOutcomeDatasets({ rows, home })` — the prefix-only datasets from
//      scripts/cynco-outcome-dataset.mjs at K = 16 turns (primary: the rows the
//      ladder judges) and K = 32 (secondary: reported, never laddered), plus the
//      HINDSIGHT rows — the same K = 16-eligible missions built from ALL their
//      turns — for the leak check. Written under <home>/datasets/.
//   2. `runHindcast({ paths })` — `python scripts/cynco-outcome-model.py` through
//      `runSync` with a timeout (F155). Returns the raw spawn result.
//   3. `hindcastOf(result, modelPath)` — a measurement, never a gate: a fault, a
//      timeout, a non-zero exit (TOO FEW, python or sklearn missing, a crash)
//      becomes `{ fault }` with the reason; exit 0 becomes the summary the wave
//      record and the verdict entry carry.
//
// Nothing here runs in the engine. The model's held-out predictions reach the
// authority ladder only through `modelRowsFrom` in scripts/cynco-rule-verdicts.mjs.
//
// Phase 7 ruling 1: the reading unit (`exportReadingDataset` →
// `runReadingHindcast`, below) runs the same model on one sample per
// inter-tick interval, with its own `reading:<v>` holdout; its rows are M2.*.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { datasetRows, featuresOf, frozenSplit, signalsVersionOf, ensureVersionHoldout, intervalRows, DATASET_PATH, DATASET_INTERVALS_PATH, MANIFEST_PATH, READING_UNIT } from './cynco-outcome-dataset.mjs'
import { runSync, faultSummary } from './cynco-spawn.mjs'
import { OUTCOME_MODEL_PATH } from './cynco-rule-verdicts.mjs'

export const HINDCAST_TIMEOUT_MS = 300_000
/** The primary prefix (the ladder's rows) and the secondary, later one. */
export const PRIMARY_TURNS = 16
export const SECONDARY_TURNS = 32
export const OUTCOME_MODEL_SCRIPT = fileURLToPath(new URL('./cynco-outcome-model.py', import.meta.url))
/**
 * F165: the one signals version the hindcast trains on — the engine's current
 * one (`SIGNALS_VERSION` in engine/vsm/cyberneticsGovernance.ts). v1 and v2
 * rows describe different instruments (`consecutiveUnstable` was the turn
 * index in v1), so a learner fitted on both learns the era, not the outcome.
 *
 * The holdout is per version too (fix round 2): `benchmark/cynco-ledger/
 * frozen-eval.json` holds one frozen id set per signals version, v1's 21 ids
 * untouched. Until v2 has FREEZE_MIN_ELIGIBLE (38) labeled missions of ≥ 16
 * turns the reading is `v2 holdout not yet frozen (n of 38 labeled; …)` and
 * python is not spawned; the export that first sees 38 freezes v2's set once,
 * with Phase 5's `freezeManifest`, and records it on the file's history. After
 * that a refusal is the model's own TOO FEW with the per-version counts.
 */
export const HINDCAST_SIGNALS_VERSION = 2
/** How much of a failed run's output the fault keeps. */
const FAULT_TAIL_CHARS = 300

/** Where each file lives under a home. The primary dataset is the exporter's own default path. */
export const HINDCAST_PATHS = (home) => ({
  dataset: DATASET_PATH(home),
  dataset32: join(home, 'datasets', `outcome-dataset-k${SECONDARY_TURNS}.jsonl`),
  hindsight: join(home, 'datasets', 'outcome-dataset-hindsight.jsonl'),
  out: OUTCOME_MODEL_PATH(home),
})

/** The same four files directly inside `dir` — `HINDCAST_PATHS(home)` is
 *  `hindcastPathsIn(<home>/datasets)`. The verdicts CLI's `--datasets-dir`. */
export const hindcastPathsIn = (dir) => ({
  dataset: join(dir, 'outcome-dataset.jsonl'),
  dataset32: join(dir, `outcome-dataset-k${SECONDARY_TURNS}.jsonl`),
  hindsight: join(dir, 'outcome-dataset-hindsight.jsonl'),
  out: join(dir, 'outcome-model.json'),
})

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  renameSync(tmp, path)
}

/**
 * Write the three datasets. Hindsight is built only for the missions eligible
 * at the primary K, each from its FULL turn list, so the leak check compares
 * the same missions with more of the story told. Returns the paths and the row
 * counts (`n` is the primary's — the one a train/holdout split is made from).
 * `datasetsDir`, when given, replaces `<home>/datasets` as the directory.
 *
 * F165: only rows of ONE signals version are written (`signalsVersion`,
 * default HINDCAST_SIGNALS_VERSION) — at each K, and the hindsight rows from
 * the primary's. `rowsByVersion` counts the eligible (labeled, ≥ K = 16 turns)
 * missions of every version, so a refusal can say how many of each there were;
 * both ride `paths` to the model, which writes them into its output.
 */
export function exportOutcomeDatasets({ rows, home, datasetsDir = null, manifestPath = MANIFEST_PATH, signalsVersion = HINDCAST_SIGNALS_VERSION, now = () => new Date().toISOString() }) {
  const rowsByVersion = {}
  for (const r of datasetRows(rows, PRIMARY_TURNS).rows) rowsByVersion[r.signalsVersion] = (rowsByVersion[r.signalsVersion] ?? 0) + 1
  // F165 fix round 2: the holdout is this version's own frozen set. When it
  // has none and the version's eligible pool has reached FREEZE_MIN_ELIGIBLE,
  // it is frozen here, once (Phase 5's freezeManifest), into `manifestPath`.
  const { set, holdout } = ensureVersionHoldout({ rows, path: manifestPath, v: signalsVersion, K: PRIMARY_TURNS, now })
  const paths = { ...(datasetsDir ? hindcastPathsIn(datasetsDir) : HINDCAST_PATHS(home)), manifest: manifestPath, signalsVersion, rowsByVersion }
  const primary = datasetRows(rows, PRIMARY_TURNS, { signalsVersion })
  const secondary = datasetRows(rows, SECONDARY_TURNS, { signalsVersion })
  const eligible = new Set(primary.rows.map(r => r.missionId))
  const hindsight = rows.filter(r => eligible.has(r?.missionId)).map(r => featuresOf(r, r.turns.length))
  writeJsonl(paths.dataset, primary.rows)
  writeJsonl(paths.dataset32, secondary.rows)
  writeJsonl(paths.hindsight, hindsight)
  // The holdout as the manifest sees it at each K — always with `turns`, so a
  // held-out mission too short (or unlabeled) at K is NAMED rather than
  // silently missing from the python split. A held-out mission of another
  // signals version is named too (`otherVersion`), never counted as missing.
  const manifest = { missionIds: set?.missionIds ?? [] }
  const versionAt = (r, K) => signalsVersionOf((Array.isArray(r?.turns) ? r.turns : []).slice(0, K))
  const splitAt = (K) => {
    const s = frozenSplit(rows.filter(r => versionAt(r, K) === signalsVersion), manifest, { turns: K })
    const other = new Set(rows.filter(r => versionAt(r, K) !== signalsVersion).map(r => r.missionId))
    return { train: s.train.length, holdout: s.holdout.length, ineligible: s.ineligible,
      missing: s.missing.filter(id => !other.has(id)), otherVersion: s.missing.filter(id => other.has(id)) }
  }
  return { paths, n: primary.rows.length, n32: secondary.rows.length, nHindsight: hindsight.length, excluded: primary.excluded,
    signalsVersion, rowsByVersion, holdout,
    split:{ [PRIMARY_TURNS]: splitAt(PRIMARY_TURNS), [SECONDARY_TURNS]: splitAt(SECONDARY_TURNS) } }
}

/**
 * The hindcast's reading when the export has nothing to train on — python is
 * never spawned. F165: with a signals version it names the version and every
 * version's eligible count, so "nothing to train on" reads as "no v2 mission
 * labeled yet (v1: 104)", never as an empty ledger.
 */
export function noEligibleFault(exported, K = PRIMARY_TURNS) {
  const v = exported?.signalsVersion
  if (typeof v !== 'number') return `no eligible labeled mission at K = ${K} turns — nothing to train on`
  const counts = Object.entries(exported?.rowsByVersion ?? {}).sort(([a], [b]) => Number(a) - Number(b)).map(([k, n]) => `v${k}: ${n}`)
  if (!exported?.n) return `no eligible labeled mission at K = ${K} turns with signals v${v} (eligible by version: ${counts.join(', ') || 'none'}) — nothing to train on`
  // F165 fix round 2: missions exist, but this version has no frozen holdout
  // yet — python is not spawned, and the reading says how far off the freeze is.
  const h = exported.holdout
  // Task 2 review N4: the pool is big enough, but one label is short of the
  // holdout minimum — say which, not "n of 38".
  if (typeof h.needEach === 'number') return `v${v} holdout not yet frozen (pass ${h.pass} / fail ${h.fail}; need ${h.needEach} of each; eligible by version: ${counts.join(', ')})`
  return `v${v} holdout not yet frozen (${h.eligible} of ${h.needed} labeled; eligible by version: ${counts.join(', ')})`
}

/** Whether the export can be trained on: missions of the version AND a frozen
 *  holdout for it. When false the runner records `noEligibleFault`. */
export const hindcastReady = (exported) => Boolean(exported?.n) && exported?.holdout?.frozen !== false

// ── The reading unit (Phase 7 ruling 1) ──────────────────────────
//
// One labeled sample per inter-tick interval of a wave (`intervalRows`), put
// through the same model with `--unit reading`: its own frozen holdout — the
// manifest set `reading:<v>`, whole missions, frozen once by the mission
// unit's rule (FREEZE_MIN_ELIGIBLE readings, MODEL_MIN_HOLDOUT of each label)
// — and its predictions on the ladder as `M2.lr` / `M2.gbt`. The mission unit
// stays primary; the reading is reported beside it. Below the minimum the
// reading is UNMEASURED with the counts and python is not spawned.

/** Where the reading unit's dataset lives: `<home>/datasets/` or `dir`. */
export const readingDatasetPath = ({ home = null, datasetsDir = null }) =>
  (datasetsDir ? join(datasetsDir, 'outcome-dataset-intervals.jsonl') : DATASET_INTERVALS_PATH(home))

/**
 * Export the reading dataset: `intervalRows(rows, waves)` of one signals
 * version, written as JSONL, and the version's `reading:<v>` holdout ensured
 * (frozen here, once, when the pool first reaches the minimum). `waves` are
 * the bare wave records (the runner's `runnerWaves(...)` records). The
 * interval rows ride back as `intervals` for the ladder (`modelRowsFrom`'s
 * reading scope and labels). The model writes into the mission model's file
 * (`outcome-model.json`), under `reading`.
 */
export function exportReadingDataset({ rows, waves, home, datasetsDir = null, manifestPath = MANIFEST_PATH, signalsVersion = HINDCAST_SIGNALS_VERSION, now = () => new Date().toISOString() }) {
  const built = intervalRows(rows, waves, { signalsVersion })
  const { holdout } = ensureVersionHoldout({ rows: built.rows, path: manifestPath, v: signalsVersion, unit: READING_UNIT, now })
  const rowsByVersion = { [signalsVersion]: built.rows.length }
  const out = (datasetsDir ? hindcastPathsIn(datasetsDir) : HINDCAST_PATHS(home)).out
  const paths = { dataset: readingDatasetPath({ home, datasetsDir }), out, manifest: manifestPath, signalsVersion, rowsByVersion, unit: READING_UNIT }
  writeJsonl(paths.dataset, built.rows)
  return { paths, n: built.rows.length, waves: built.waves, excluded: built.excluded, signalsVersion, rowsByVersion, holdout, intervals: built.rows }
}

/** Whether the reading export can be trained on: its holdout is frozen. */
export const readingReady = (exported) => exported?.holdout?.frozen === true

/** The reading's UNMEASURED reason while its holdout is not frozen (F16: the counts, never a 0). */
export function readingNotFrozenFault(exported) {
  const h = exported?.holdout ?? {}
  return `reading holdout not yet frozen (${h.eligible ?? 0} of ${h.needed ?? '?'} labeled; improved ${h.improved ?? 0} / stalled ${h.stalled ?? 0}; need ${h.needEach ?? '?'} of each)`
}

/**
 * The reading hindcast from an export: `{ reading, model }`. `reading` is what
 * `rec.hindcast.reading` carries — `{ fault, signalsVersion, rowsByVersion,
 * holdout, waves, excluded }` (not frozen: python NOT spawned; or the model's
 * own fault), or the model's summary with the same context. `model` is the
 * written `reading` block (its predictions are the M2 rows), null on a fault.
 */
export function runReadingHindcast({ exported, runHindcast: run = runHindcast }) {
  const ctx = { signalsVersion: exported?.signalsVersion ?? null, rowsByVersion: exported?.rowsByVersion ?? {}, holdout: exported?.holdout ?? null,
    waves: exported?.waves ?? 0, excluded: exported?.excluded ?? null }
  if (!readingReady(exported)) return { reading: { fault: readingNotFrozenFault(exported), ...ctx }, model: null }
  const h = hindcastOf(run({ paths: exported.paths }), exported.paths.out, undefined, { unit: READING_UNIT })
  if (h.fault) return { reading: { fault: h.fault, ...ctx }, model: null }
  return { reading: { ...h.summary, ...ctx }, model: h.model }
}

/** The python retrain, capped. The raw `runSync` result comes back. The
 *  signals version and the per-version counts go with it (F165). A reading
 *  export's paths (`unit: 'reading'`) run `--unit reading` on the interval
 *  dataset — no hindsight, no second prefix (Phase 7 ruling 1). */
export function runHindcast({ paths, run = runSync }) {
  if (paths.unit === READING_UNIT) {
    return run('python', [OUTCOME_MODEL_SCRIPT, '--unit', READING_UNIT, '--dataset', paths.dataset,
      '--manifest', paths.manifest ?? MANIFEST_PATH, '--out', paths.out,
      '--signals-version', String(paths.signalsVersion ?? HINDCAST_SIGNALS_VERSION),
      '--rows-by-version', JSON.stringify(paths.rowsByVersion ?? {})], { timeoutMs: HINDCAST_TIMEOUT_MS })
  }
  return run('python', [OUTCOME_MODEL_SCRIPT, '--dataset', paths.dataset, '--dataset32', paths.dataset32, '--hindsight', paths.hindsight,
    '--manifest', paths.manifest ?? MANIFEST_PATH, '--out', paths.out,
    '--signals-version', String(paths.signalsVersion ?? HINDCAST_SIGNALS_VERSION),
    '--rows-by-version', JSON.stringify(paths.rowsByVersion ?? {})], { timeoutMs: HINDCAST_TIMEOUT_MS })
}

const tail = (s) => {
  const t = String(s ?? '').trim().split(/\r?\n/).filter(Boolean)
  const last = t.slice(-3).join(' | ')
  return last.length > FAULT_TAIL_CHARS ? `…${last.slice(-FAULT_TAIL_CHARS)}` : last
}

const metrics = (m) => ({ precision: m?.precision ?? null, recall: m?.recall ?? null, brier: m?.brier ?? null, auc: m?.auc ?? null })

/** What the wave record keeps of a written model (the predictions stay in the file). */
export function hindcastSummary(model) {
  const models = Object.fromEntries(Object.keys(model?.models ?? {}).sort().map(k => [k, metrics(model.models[k])]))
  const s = model?.secondary
  return {
    version: model?.version ?? null, trainedAt: model?.trainedAt ?? null, prefixTurns: model?.prefixTurns ?? null,
    // F165: which instrument the model was fitted on, and how many eligible
    // missions each version had (null on a model written before F165).
    signalsVersion: model?.signalsVersion ?? null, rowsByVersion: model?.rowsByVersion ?? null,
    nTrain: model?.nTrain ?? null, nHoldout: model?.nHoldout ?? null, baseRate: model?.baseRate ?? null,
    features: Array.isArray(model?.features) ? model.features.length : null, droppedFeatures: model?.droppedFeatures ?? [], droppedReasons: model?.droppedReasons ?? {},
    lengthFeature: model?.lengthFeature ?? null, models, leakCheck: model?.leakCheck ?? null,
    secondary: !s ? null : s.refusal ? { refusal: s.refusal }
      : { prefixTurns: s.prefixTurns ?? null, nTrain: s.nTrain ?? null, nHoldout: s.nHoldout ?? null, baseRate: s.baseRate ?? null,
        models: Object.fromEntries(Object.keys(s.models ?? {}).sort().map(k => [k, metrics(s.models[k])])) },
  }
}

/**
 * The spawn result as a reading: `{ fault }` for anything but a clean exit 0,
 * else `{ model, summary }` with the model file read back from `path`.
 */
export function hindcastOf(result, path, read = (p) => JSON.parse(readFileSync(p, 'utf8')), { unit = 'mission' } = {}) {
  if (result?.fault) return { fault: `the hindcast did not run (${faultSummary(result.fault)})` }
  if (result?.timedOut) return { fault: `the hindcast timed out after ${result.elapsedMs} ms` }
  if (result?.status !== 0) return { fault: `exit ${result?.status ?? 'null'}: ${tail(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`) || 'no output'}` }
  if (!existsSync(path)) return { fault: `exit 0 but no model at ${path}` }
  const file = read(path)
  if (unit !== READING_UNIT) return { model: file, summary: hindcastSummary(file) }
  // Phase 7 ruling 1: the reading run writes its block under `reading`; a
  // file without one is a fault, never the previous wave's block read as new.
  const model = file?.reading
  if (!model || typeof model !== 'object') return { fault: `exit 0 but no reading block in ${path}` }
  return { model, summary: { unit: READING_UNIT, ...hindcastSummary(model) } }
}
