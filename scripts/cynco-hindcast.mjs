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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { datasetRows, featuresOf, frozenSplit, DATASET_PATH, MANIFEST_PATH } from './cynco-outcome-dataset.mjs'
import { runSync, faultSummary } from './cynco-spawn.mjs'
import { OUTCOME_MODEL_PATH } from './cynco-rule-verdicts.mjs'

export const HINDCAST_TIMEOUT_MS = 300_000
/** The primary prefix (the ladder's rows) and the secondary, later one. */
export const PRIMARY_TURNS = 16
export const SECONDARY_TURNS = 32
export const OUTCOME_MODEL_SCRIPT = fileURLToPath(new URL('./cynco-outcome-model.py', import.meta.url))
/** How much of a failed run's output the fault keeps. */
const FAULT_TAIL_CHARS = 300

/** Where each file lives under a home. The primary dataset is the exporter's own default path. */
export const HINDCAST_PATHS = (home) => ({
  dataset: DATASET_PATH(home),
  dataset32: join(home, 'datasets', `outcome-dataset-k${SECONDARY_TURNS}.jsonl`),
  hindsight: join(home, 'datasets', 'outcome-dataset-hindsight.jsonl'),
  out: OUTCOME_MODEL_PATH(home),
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
 */
export function exportOutcomeDatasets({ rows, home, manifestPath = MANIFEST_PATH }) {
  const paths = { ...HINDCAST_PATHS(home), manifest: manifestPath }
  const primary = datasetRows(rows, PRIMARY_TURNS)
  const secondary = datasetRows(rows, SECONDARY_TURNS)
  const eligible = new Set(primary.rows.map(r => r.missionId))
  const hindsight = rows.filter(r => eligible.has(r?.missionId)).map(r => featuresOf(r, r.turns.length))
  writeJsonl(paths.dataset, primary.rows)
  writeJsonl(paths.dataset32, secondary.rows)
  writeJsonl(paths.hindsight, hindsight)
  // The holdout as the manifest sees it at each K — always with `turns`, so a
  // held-out mission too short (or unlabeled) at K is NAMED rather than
  // silently missing from the python split.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const splitAt = (K) => {
    const s = frozenSplit(rows, manifest, { turns: K })
    return { train: s.train.length, holdout: s.holdout.length, ineligible: s.ineligible, missing: s.missing }
  }
  return { paths, n: primary.rows.length, n32: secondary.rows.length, nHindsight: hindsight.length, excluded: primary.excluded,
    split: { [PRIMARY_TURNS]: splitAt(PRIMARY_TURNS), [SECONDARY_TURNS]: splitAt(SECONDARY_TURNS) } }
}

/** The python retrain, capped. The raw `runSync` result comes back. */
export function runHindcast({ paths, run = runSync }) {
  return run('python', [OUTCOME_MODEL_SCRIPT, '--dataset', paths.dataset, '--dataset32', paths.dataset32, '--hindsight', paths.hindsight,
    '--manifest', paths.manifest ?? MANIFEST_PATH, '--out', paths.out], { timeoutMs: HINDCAST_TIMEOUT_MS })
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
export function hindcastOf(result, path, read = (p) => JSON.parse(readFileSync(p, 'utf8'))) {
  if (result?.fault) return { fault: `the hindcast did not run (${faultSummary(result.fault)})` }
  if (result?.timedOut) return { fault: `the hindcast timed out after ${result.elapsedMs} ms` }
  if (result?.status !== 0) return { fault: `exit ${result?.status ?? 'null'}: ${tail(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`) || 'no output'}` }
  if (!existsSync(path)) return { fault: `exit 0 but no model at ${path}` }
  const model = read(path)
  return { model, summary: hindcastSummary(model) }
}
