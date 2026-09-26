/**
 * The outcome dataset and the frozen holdout (Phase 5, ruling 5).
 *
 * One row per LABELED mission, built from a PREFIX of its `turns[]` — the first
 * 50 % by index by default, 25 % as a second, earlier point. The question every
 * later learner answers is "could we have seen this coming?", and only what was
 * observable at the time of the prefix may enter the answer. Whole-mission
 * fields (`verified`, `outcome`, `mutationSweep`, `toolStats`, `durationS`, …)
 * are written after the run ends; a feature built from one of them describes
 * the outcome after the fact and would make any learner look prescient. So
 * `featuresOf` reads `row.turns` and nothing else except `missionId` and the
 * label, and the feature key set is a fixed, documented list
 * (`FEATURE_KEYS`, benchmark/cynco-ledger/README.md "Outcome dataset and the
 * frozen holdout") that the leak test pins exactly.
 *
 * The label is `labelOf` from scripts/cynco-signal-validation.mjs — the ledger's
 * one labeling rule, imported, never restated.
 *
 * Unmeasured is `null`, never 0 (F16): a signal that is null on every turn of
 * the prefix yields null mean/last/max. One-hots are all zeros when the last
 * prefix turn carries no value for that field.
 *
 * The frozen holdout `benchmark/cynco-ledger/frozen-eval.json` is 20 % of the
 * dataset-eligible missions (labeled, ≥ MIN_TURNS turns), stratified by label,
 * drawn by a seeded shuffle. It is written ONCE (`--freeze`); a later version
 * comes only from `--refreeze`, which only ever ADDS ids.
 *
 * Usage:
 *   bun scripts/cynco-outcome-dataset.mjs --export [--fraction 0.5] [--out PATH] [--ledger-dir DIR]
 *   bun scripts/cynco-outcome-dataset.mjs --freeze   --seed N [--manifest PATH] [--ledger-dir DIR]
 *   bun scripts/cynco-outcome-dataset.mjs --refreeze --seed N [--manifest PATH] [--ledger-dir DIR]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readLedger } from './cynco-ledger-shards.mjs'
import { labelOf } from './cynco-signal-validation.mjs'

const REPO_LEDGER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'cynco-ledger')
export const MANIFEST_PATH = join(REPO_LEDGER_DIR, 'frozen-eval.json')
export const DATASET_PATH = (home) => join(home, 'datasets', 'outcome-dataset.jsonl')
export const MANIFEST_SCHEMA = 1
export const MIN_TURNS = 4
export const HOLDOUT_SHARE = 0.2

// ── Features ─────────────────────────────────────────────────────

/** Numeric per-turn signals: name → how to read it off one turn. */
const NUMERIC = [
  ['toolSuccessRate', t => t.toolSuccessRate],
  ['stuckTurns', t => t.stuckTurns],
  ['varietyRatio', t => t.varietyRatio],
  ['varietyWindowed', t => t.varietyWindowed],
  ['taskError', t => t.taskError],
  ['infoGain', t => t.infoGain],
  ['progressRate', t => t.progressRate],
  ['algedonicAlerts', t => t.algedonicAlerts],
  ['consecutiveUnstable', t => t.consecutiveUnstable],
  ['axiomViolations', t => (Array.isArray(t.axiomHealth?.violations) ? t.axiomHealth.violations.length : null)],
  ['toolEntropyMean', t => t.brain?.toolEntropy?.mean],
  ['toolEntropyMax', t => t.brain?.toolEntropy?.max],
]

/** Categorical signals read off the LAST prefix turn, one-hot over a fixed
 *  vocabulary (the engine's enums; a value outside it reads as all zeros). */
const CATEGORICAL = [
  ['errorTrend', t => t.errorTrend, ['rising', 'flat', 'falling']],
  ['explorationState', t => t.explorationState, ['healthy_exploration', 'thrashing', 'floundering']],
  ['health', t => t.health, ['healthy', 'warning', 'critical']],
  ['s3s4Balance', t => t.s3s4Balance, ['balanced', 's3_dominant', 's4_dominant', 'critical']],
  ['varietyBalance', t => t.varietyBalance, ['balanced', 'underload', 'overload', 'critical']],
  ['commander', t => t.heterarchy?.commander, ['S1', 'S2', 'S3', 'S4', 'S5']],
]

export const FEATURE_KEYS = Object.freeze([
  ...NUMERIC.flatMap(([n]) => [`${n}.mean`, `${n}.last`, `${n}.max`]),
  'brainPresent',
  ...CATEGORICAL.flatMap(([n, , vocab]) => vocab.map(v => `${n}.${v}`)),
])

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** How many turns a fraction keeps: floor, at least one. */
function prefixLength(n, fraction) {
  return Math.max(1, Math.floor(n * fraction))
}

/**
 * The feature vector of one mission's prefix. Reads `row.turns`, `row.missionId`
 * and the label — nothing else on the row.
 */
export function featuresOf(row, fraction = 0.5) {
  if (!(typeof fraction === 'number' && fraction > 0 && fraction <= 1)) {
    throw new Error(`fraction must be in (0, 1], got ${fraction}`)
  }
  const all = Array.isArray(row.turns) ? row.turns : []
  const prefix = all.length ? all.slice(0, prefixLength(all.length, fraction)) : []
  const features = {}
  for (const [name, read] of NUMERIC) {
    const vals = prefix.map(t => num(read(t ?? {}))).filter(v => v !== null)
    features[`${name}.mean`] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    features[`${name}.last`] = vals.length ? vals[vals.length - 1] : null
    features[`${name}.max`] = vals.length ? Math.max(...vals) : null
  }
  features.brainPresent = prefix.some(t => num(t?.brain?.toolEntropy?.mean) !== null || num(t?.brain?.toolEntropy?.max) !== null) ? 1 : 0
  const last = prefix.length ? (prefix[prefix.length - 1] ?? {}) : {}
  for (const [name, read, vocab] of CATEGORICAL) {
    const v = read(last)
    for (const option of vocab) features[`${name}.${option}`] = v === option ? 1 : 0
  }
  return { missionId: row.missionId, fraction, turnsInPrefix: prefix.length, label: labelOf(row), features, leakGuard: true }
}

/** Why a ledger row is not in the dataset, or null when it is. */
function exclusionOf(row) {
  if (labelOf(row) === null) return 'unlabeled'
  if ((Array.isArray(row.turns) ? row.turns.length : 0) < MIN_TURNS) return 'short'
  return null
}

/** One `featuresOf` row per labeled mission with ≥ MIN_TURNS turns; the rest counted. */
export function datasetRows(rows, fraction = 0.5) {
  const out = []
  const excluded = { unlabeled: 0, short: 0 }
  for (const row of rows) {
    const why = exclusionOf(row)
    if (why) excluded[why]++
    else out.push(featuresOf(row, fraction))
  }
  return { rows: out, excluded }
}

// ── The frozen holdout ───────────────────────────────────────────

/** Split rows (ledger or dataset rows — anything with `missionId`) by the
 *  manifest. Manifest ids that match no row are reported, never dropped. */
export function frozenSplit(rows, manifest) {
  const held = new Set(manifest?.missionIds ?? [])
  const seen = new Set(rows.map(r => r.missionId))
  return {
    train: rows.filter(r => !held.has(r.missionId)),
    holdout: rows.filter(r => held.has(r.missionId)),
    missing: [...held].filter(id => !seen.has(id)),
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
 * The holdout manifest: HOLDOUT_SHARE of the dataset-eligible rows (rounded to
 * nearest), split across labels in proportion, at least one of each label when
 * both exist. With `previous`, every previous id is kept (refreeze only adds)
 * and each label's share is topped up from the rows not yet held.
 */
export function freezeManifest(rows, { seed, version, previous = null, now = () => new Date().toISOString() } = {}) {
  if (!Number.isInteger(seed)) throw new Error(`seed must be an integer, got ${seed}`)
  const eligible = rows.filter(r => exclusionOf(r) === null)
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
  const kept = [...new Set(previous?.missionIds ?? [])]
  const held = new Set(kept)
  const rand = mulberry32(seed)
  for (const label of ['false', 'true']) {
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

function counts(rows, manifest) {
  const eligible = rows.filter(r => exclusionOf(r) === null)
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
  const rows = readLedger(argOf(argv, '--ledger-dir') ?? REPO_LEDGER_DIR)
  if (argv.includes('--export')) {
    const fraction = argOf(argv, '--fraction') === undefined ? 0.5 : Number(argOf(argv, '--fraction'))
    const out = argOf(argv, '--out') !== undefined
      ? resolve(argOf(argv, '--out'))
      : DATASET_PATH((await import('../engine/paths.js')).cyncoHome())
    const { rows: ds, excluded } = datasetRows(rows, fraction)
    writeAtomic(out, ds.map(r => JSON.stringify(r)).join('\n') + (ds.length ? '\n' : ''))
    io.log(`outcome dataset: ${ds.length} rows at fraction ${fraction} (excluded ${excluded.unlabeled} unlabeled, ${excluded.short} short) → ${out}`)
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
    const manifest = freezeManifest(rows, { seed, previous })
    writeAtomic(path, JSON.stringify(manifest, null, 2) + '\n')
    const c = counts(rows, manifest)
    const missing = frozenSplit(rows, manifest).missing
    io.log(`frozen holdout v${manifest.version} (seed ${seed}): ${c.holdout} of ${c.eligible} eligible missions ` +
      `(${c.holdoutFailures} failures, ${c.holdoutSuccesses} successes; eligible ${c.eligibleFailures} failures)` +
      `${missing.length ? `; ${missing.length} previous ids not in the ledger: ${missing.join(', ')}` : ''} → ${path}`)
    return 0
  }
  io.error('usage: --export [--fraction F] [--out PATH] | --freeze --seed N | --refreeze --seed N  [--ledger-dir DIR] [--manifest PATH]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e?.message ?? e); process.exit(1) })
