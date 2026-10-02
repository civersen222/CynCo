// scripts/cynco-rule-verdicts.mjs — the per-rule S5 verdicts, written where the
// engine can read them.
//
// Phase 4 ("autopoiesis for real"). `LOCALCODE_S5_ENFORCE` is all-or-nothing:
// either every S5 rule may act, or none may. Step 2 of the falsification
// program (`scripts/cynco-signal-validation.mjs`) already asks each rule the
// one question that should decide that — does it fire more often on missions
// that failed? — but its answer was a table a human read. This module turns the
// answer into a file:
//
//   ~/.cynco/datasets/rule-verdicts.json
//
// rewritten by the campaign runner at every wave VERDICT from the whole ledger.
// `engine/s5/ruleAuthority.ts` reads it at session start and grants enforcement
// per decision: a decision is enforceable only when EVERY rule behind it reads
// exactly `'PREDICTIVE'`. `engine/s5/exportTrainingData.ts` reads it to keep the
// S5 training corpus to decisions those same rules produced. No file = legacy
// (today's behaviour, unchanged).
//
// The verdict strings are `ruleVerdictOf` from signal-validation, verbatim — a
// second copy of the thresholds would be a second opinion that drifts.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyse as analyseFn, ruleVerdictOf, holm, wilson, rulesFired } from './cynco-signal-validation.mjs'
import { signalsVersionOf, READING_UNIT, READING_LABELS, readingIdOf } from './cynco-outcome-dataset.mjs'

/**
 * F165 (review I2): the S5 rules whose condition reads a signal that changed
 * meaning in signals v2 — `homeostatStable` / `homeostatConsecutiveUnstable`
 * (engine/s5/ruleBasedS5.ts: W5 at `>= 3`, I2 at `1..2`). In v1 the homeostat
 * never read stable, so W5 fired on every turn from 3 on and I2 on turns 1–2
 * of EVERY mission: a v1 firing is not the v2 rule's evidence. These rules are
 * scored on v2 missions only; their v1 table rides on the row as `v1`, never
 * pooled into `n`/`precision`. No rule reads `algedonicAlerts`.
 */
export const V2_CHANGED_RULES = Object.freeze(['I2', 'W5'])
const V2_CHANGED = new Set(V2_CHANGED_RULES)
/** A ledger row's signals version: the minimum over its turns (1 when none carries one). */
const missionVersion = (row) => signalsVersionOf(Array.isArray(row?.turns) ? row.turns : [])

export const RULE_VERDICTS_PATH = (home) => join(home, 'datasets', 'rule-verdicts.json')
/** Where `scripts/cynco-outcome-model.py` writes the hindcast the runner reads. */
export const OUTCOME_MODEL_PATH = (home) => join(home, 'datasets', 'outcome-model.json')
/** The pFail at or above which a model "fires" on a held-out mission. */
export const MODEL_FIRE_THRESHOLD = 0.5

/**
 * Phase 5 ruling 5: the outcome model's held-out predictions as synthetic
 * rules, one per model (`M1.lr`, `M1.gbt`). `fired` = the held-out missions
 * with `pFail ≥ 0.5`; `scope` = the held-out missions the ledger `rows` still
 * carry — the model is judged on the frozen holdout and nowhere else, so its
 * 2×2 table is built over `scope` alone (never the training missions it has
 * seen). No model file, or no models in it, is no rows.
 */
export function modelRowsFrom(outcomeModel, rows, { unit = 'mission' } = {}) {
  const models = outcomeModel?.models
  if (!models || typeof models !== 'object') return []
  if (unit === READING_UNIT) return readingRowsFrom(models, rows)
  const inLedger = new Set((rows ?? []).map(r => r?.missionId))
  return Object.keys(models).sort().map(k => {
    const preds = (models[k]?.predictions ?? []).filter(p => inLedger.has(p?.missionId))
    return {
      id: `M1.${k}`, source: 'model', unit: 'mission',
      fired: new Set(preds.filter(p => typeof p.pFail === 'number' && p.pFail >= MODEL_FIRE_THRESHOLD).map(p => p.missionId)),
      scope: new Set(preds.map(p => p.missionId)),
    }
  })
}

/**
 * Phase 7 ruling 1: the reading learner's rows, `M2.<k>` (`unit: 'reading'`).
 * `rows` are the interval rows the export wrote (`intervalRows`); a held-out
 * prediction is in scope when its reading (`missionId:interval`) is still
 * among them and labelled, and the label is read from the ROW, never from the
 * model's file — `improved` is the success, so "fired" (P(stalled) ≥ 0.5) on
 * a stalled reading is the hit, as fired on a failed mission is for M1.
 */
function readingRowsFrom(models, rows) {
  const labelOfId = new Map()
  for (const r of rows ?? []) {
    if (r?.label === READING_LABELS.positive || r?.label === READING_LABELS.negative) labelOfId.set(readingIdOf(r), r.label === READING_LABELS.positive)
  }
  return Object.keys(models).sort().map(k => {
    const preds = (models[k]?.predictions ?? []).filter(p => typeof p?.id === 'string' && labelOfId.has(p.id))
    return {
      id: `M2.${k}`, source: 'model', unit: READING_UNIT,
      fired: new Set(preds.filter(p => typeof p.pFail === 'number' && p.pFail >= MODEL_FIRE_THRESHOLD).map(p => p.id)),
      scope: new Set(preds.map(p => p.id)),
      labels: new Map(preds.map(p => [p.id, labelOfId.get(p.id)])),
    }
  })
}

/**
 * One model row through the SAME arithmetic as an S5 rule: `analyse` over the
 * rows in the row's scope, with "fired" read off the model's fired set. A
 * model that fired on no held-out mission has no table at all — its numbers
 * are null (F16), exactly as `analyse` writes a rule that never fired on a
 * labeled mission. `pAdjusted` is set by the caller's Holm pass.
 */
function modelRuleOf(m, rows, analyse) {
  // Phase 7 ruling 1: a reading row's table is over its held-out READINGS,
  // each labelled from the interval rows (`m.labels`, improved = success).
  const res = m.unit === READING_UNIT
    ? analyse([...m.scope].sort().map(id => ({ missionId: id })), {
      firedOf: (r) => (m.fired.has(r.missionId) ? new Set([m.id]) : new Set()),
      labelOf: (r) => m.labels?.get(r.missionId) ?? null,
    })
    : analyse(rows.filter(r => m.scope.has(r?.missionId)), { firedOf: (r) => (m.fired.has(r?.missionId) ? new Set([m.id]) : new Set()) })
  const r = res.rules.find(x => x.id === m.id)
    ?? { id: m.id, firedTotal: 0, labeled: 0, failures: 0, precision: null, ci: wilson(0, 0), lift: null, p: null, coverage: 0 }
  return { ...r, base: res.labeled ? res.base : null, scopeN: res.labeled, unit: m.unit ?? 'mission' }
}

/** A runner row's verdict when there is no table to read one from (F16:
 *  unmeasured is null with its reason, never a rate of 0). */
export const runnerUnmeasuredNoScope = (at) => `UNMEASURED — no wave in scope (no shadow decision at ${Math.round(at * 100)} % of its clock or later)`
/** R1's (50 %); Phase 7: each runner row names its OWN threshold (`row.at`, R2.stalled's is 25 %). */
export const RUNNER_UNMEASURED_NO_SCOPE = runnerUnmeasuredNoScope(0.5)
export const RUNNER_UNMEASURED_NEVER_FIRED = 'UNMEASURED — fired on no in-scope wave'

/**
 * Phase 6: one runner row (`R1.no-progress`, `source: 'runner'`, from
 * `runnerRowsFrom` in scripts/cynco-campaign-progress.mjs) through the SAME
 * arithmetic as an S5 rule and a model row: `analyse` over the row's scope —
 * the in-scope WAVES, one per mission — with "fired" read off `fired` and the
 * outcome off `failed` (the wave's own decision, the record the firing was
 * read from; not a ledger label, which a wave that never graded lacks).
 * A row that fired on no in-scope wave has no table: n 0, every number null,
 * and an UNMEASURED verdict naming why. `pAdjusted` is set by the caller's
 * Holm pass.
 */
function runnerRuleOf(u, analyse) {
  const scoped = [...u.scope].sort().map(missionId => ({ missionId }))
  const res = analyse(scoped, {
    firedOf: (r) => (u.fired.has(r.missionId) ? new Set([u.id]) : new Set()),
    labelOf: (r) => !u.failed.has(r.missionId),
  })
  const r = res.rules.find(x => x.id === u.id)
    ?? { id: u.id, firedTotal: 0, labeled: 0, failures: 0, precision: null, ci: wilson(0, 0), lift: null, p: null, coverage: 0 }
  const noScope = typeof u.at === 'number' && Number.isFinite(u.at) ? runnerUnmeasuredNoScope(u.at) : RUNNER_UNMEASURED_NO_SCOPE
  const unmeasured = res.labeled === 0 ? noScope : r.labeled === 0 ? RUNNER_UNMEASURED_NEVER_FIRED : null
  // Review M1: the wave records runnerRowsFrom could not read, named, so a
  // malformed line in some campaign's waves.jsonl is visible on the row.
  const skipped = Array.isArray(u.skipped) ? u.skipped : []
  const note = skipped.length ? `${skipped.length} malformed wave record(s) skipped: ${skipped.join(', ')}` : null
  // Final review I1: the waves whose VERDICT grade did not run — unlabeled, as
  // `labelOf` makes them for the S5 rules — named, never counted in n.
  const unlabeled = Array.isArray(u.unlabeled) ? u.unlabeled : []
  // Review M3: an unmeasured row has no interval either — null, not wilson(0, 0)'s [0, 1].
  return { ...r, ci: unmeasured ? null : r.ci, base: res.labeled ? res.base : null, scopeN: res.labeled, unmeasured, note, unlabeled }
}
/** An `analyse` row for a rule with no table in its scope (F16: null numbers). */
const emptyRuleRow = (id) => ({ id, firedTotal: 0, labeled: 0, failures: 0, precision: null, ci: wilson(0, 0), lift: null, p: null, coverage: 0 })

/**
 * `analyse` over the ledger with the V2_CHANGED_RULES taken apart (F165,
 * review I2). When no mission fired one of them the ledger is analysed exactly
 * as before (`v2Split: false`). Otherwise:
 * - every other rule is analysed over every row, as before;
 * - each changed rule that fired anywhere is analysed over the v2 missions
 *   only (a rule that fired on no v2 mission has an empty table: n 0, null
 *   numbers, `TOO FEW`), with its v1 table beside it as `v1` — `{ n,
 *   firedTotal, failures, precision, ci, p, lift, scopeN }`, `p` uncorrected
 *   (the v1 table is not a test in the family);
 * - Holm runs once over the whole rule set, so the family size is unchanged.
 */
function analyseByVersion(rows, analyse) {
  const changedFired = new Set()
  for (const r of rows) for (const id of rulesFired(r)) if (V2_CHANGED.has(id)) changedFired.add(id)
  if (changedFired.size === 0) return { res: analyse(rows), v2Split: false }
  const others = (r) => new Set([...rulesFired(r)].filter(id => !V2_CHANGED.has(id)))
  const changedOnly = (r) => new Set([...rulesFired(r)].filter(id => V2_CHANGED.has(id)))
  const res = analyse(rows, { firedOf: others })
  const v2 = analyse(rows.filter(r => missionVersion(r) >= 2), { firedOf: changedOnly })
  const v1 = analyse(rows.filter(r => missionVersion(r) < 2), { firedOf: changedOnly })
  for (const id of [...changedFired].sort()) {
    const r2 = v2.rules.find(x => x.id === id) ?? emptyRuleRow(id)
    const r1 = v1.rules.find(x => x.id === id) ?? emptyRuleRow(id)
    res.rules.push({ ...r2, scopeN: v2.labeled,
      v1: { n: r1.labeled, firedTotal: r1.firedTotal, failures: r1.failures, precision: r1.precision, ci: r1.ci, p: r1.p, lift: r1.lift, scopeN: v1.labeled } })
  }
  res.rulesTested = holm(res.rules)
  return { res, v2Split: true }
}

export const RULE_VERDICTS_SCHEMA = 1
export const RULE_VERDICTS_HISTORY_CAP = 20

/**
 * The verdict file, or null. A missing file is the legacy state and is read as
 * null without a word; a file that exists but will not parse, or is not this
 * schema, is null WITH a warning — every verdict it held is being ignored.
 */
export function readRuleVerdicts(path) {
  if (!existsSync(path)) return null
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) }
  catch (e) { console.warn(`[rule-verdicts] ${path} is not readable JSON — ignoring it: ${e?.message ?? e}`); return null }
  const ok = raw && raw.schema === RULE_VERDICTS_SCHEMA && raw.rules && typeof raw.rules === 'object' && !Array.isArray(raw.rules)
  if (!ok) { console.warn(`[rule-verdicts] ${path} is not a schema-${RULE_VERDICTS_SCHEMA} verdict file — ignoring it`); return null }
  return raw
}

/** id → verdict string for the entries whose `source` passes `keep`. */
const verdictsWhere = (file, keep) => Object.fromEntries(Object.entries(file?.rules ?? {}).filter(([, r]) => keep(r?.source)).map(([id, r]) => [id, r?.verdict ?? null]))
/** id → verdict string, from a file (or {} for none) — the S5 RULES only. The
 *  learner's `M1.*` rows (`source: 'model'`) and the runner's `R1.*` rows
 *  (`source: 'runner'`, Phase 6) are not in the version's meaning: nothing S5
 *  may enforce changes when one appears, vanishes or moves (final review M2,
 *  T5-M2); they are compared by `modelVerdictMap` / `runnerVerdictMap`. */
const verdictMap = (file) => verdictsWhere(file, (s) => s !== 'model' && s !== 'runner')
/** id → verdict string for the `M1.*` model rows only. */
const modelVerdictMap = (file) => verdictsWhere(file, (s) => s === 'model')
/** id → verdict string for the runner rows (`R1.no-progress`) only. */
const runnerVerdictMap = (file) => verdictsWhere(file, (s) => s === 'runner')

/** Every rule whose verdict differs between two id → verdict maps, sorted by id.
 *  A rule that appears or disappears is a change (`from`/`to` null). */
function verdictChanges(before, after) {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return ids.filter(id => (before[id] ?? null) !== (after[id] ?? null)).map(id => ({ id, from: before[id] ?? null, to: after[id] ?? null }))
}

/**
 * Recompute every rule's verdict from `rows` (ledger records) and write the
 * file. The version rises only when the verdict SET changed — a rule's verdict
 * moved, or a rule appeared or vanished — so the version counts real changes
 * in what S5 is allowed to enforce, not verdicts. The `M1.*` model rows are
 * outside that set: a model row that appears, vanishes or moves is written to
 * the history entry's `modelChanged` (a new entry at the SAME version when no
 * rule moved), never a version bump. The numbers (p, lift, counts) are
 * refreshed on every write regardless. History keeps the last 20 entries.
 * Written tmp + rename.
 *
 * Returns `{ version, predictive, total, rules, modelRows }` — what the wave
 * record carries (`total` = `rules` + `modelRows`).
 *
 * Phase 5: `modelRows` (from `modelRowsFrom`) are evaluated beside the rules
 * with the same Fisher/Wilson arithmetic over their held-out scope, and Holm
 * is re-run over the WHOLE family — rules and model rows together — because a
 * model row is one more chance to land under 0.05. Each is written as
 * `rules['M1.<k>'] = { verdict, precision, ci, p, n, …, source: 'model',
 * scope: 'holdout' }`. The engine never grants an `M1.*` id authority
 * (`engine/s5/ruleAuthority.ts` skips `source: 'model'`); an M1 that earns
 * PREDICTIVE is the next phase's advisory input, nothing more. Phase 7 ruling
 * 1: the reading learner's rows `M2.<k>` (`unit: 'reading'`, scoped to the
 * held-out READINGS, improved = success) go through the same arithmetic in
 * the same family and are refused authority the same way; every model entry
 * carries its `unit` ('mission' for M1). With no model
 * rows the file is exactly what it was before Phase 5.
 *
 * Phase 6: `runnerRows` (from `runnerRowsFrom`, the runner's shadow regulator
 * `R1.no-progress`) mirror the model rows exactly — the same Fisher/Wilson
 * over their scope (the in-scope waves across every runner-driven campaign),
 * the same one Holm family (rules, then models, then runner rows), written as
 * `rules['R1.no-progress'] = { …, source: 'runner', scope: 'waves', base,
 * scopeN }`, recorded in `runnerChanged` on the history entry and never a
 * version bump. The engine never grants a runner row authority
 * (`engine/s5/ruleAuthority.ts` skips `source: 'runner'`). A runner row with
 * no table reads UNMEASURED with its reason, n 0 and null numbers (F16).
 */
export function writeRuleVerdicts({ rows, campaign, outPath, analyse = analyseFn, now = () => new Date().toISOString(), modelRows = [], runnerRows = [] }) {
  const { res, v2Split } = analyseByVersion(rows, analyse)
  const models = (modelRows ?? []).map(m => modelRuleOf(m, rows, analyse))
  const runners = (runnerRows ?? []).map(u => runnerRuleOf(u, analyse))
  // Rules first, then models, then runner rows, as one Holm family. Only when
  // there are extra rows: without them the rules keep `analyse`'s own
  // correction untouched (or, with a v2 split, the one `analyseByVersion` ran
  // over the same rule set).
  const holmFamily = models.length || runners.length ? holm([...res.rules, ...models, ...runners]) : null
  const rules = {}
  for (const r of [...res.rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    rules[r.id] = {
      // Spec schema: { verdict, precision, ci, p, n } — `n` is the labeled
      // missions the rule fired on (analyse's `labeled`), `ci` its Wilson
      // interval. The rest ride along for the reader who wants the table.
      verdict: ruleVerdictOf(r),
      precision: r.precision ?? null, ci: r.ci ?? null, p: r.p ?? null, n: r.labeled ?? null,
      pAdjusted: r.pAdjusted ?? null, lift: r.lift ?? null, firedTotal: r.firedTotal ?? null, failures: r.failures ?? null,
      // F165 (review I2): a rule that reads a v2-changed signal is scored on
      // v2 missions only (`signals: 'v2'`, `scopeN` = the labeled v2
      // missions); its v1 table is kept apart, never pooled.
      ...(r.v1 !== undefined ? { signals: 'v2', scopeN: r.scopeN, v1: r.v1 } : {}),
    }
  }
  for (const r of [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    rules[r.id] = {
      verdict: ruleVerdictOf(r),
      precision: r.precision ?? null, ci: r.ci ?? null, p: r.p ?? null, n: r.labeled ?? null,
      pAdjusted: r.pAdjusted ?? null, lift: r.lift ?? null, firedTotal: r.firedTotal ?? null, failures: r.failures ?? null,
      // `base` is the HOLDOUT failure rate the lift is measured against;
      // `scopeN` the labeled held-out missions the table was built over.
      source: 'model', scope: 'holdout', base: r.base, scopeN: r.scopeN,
      // Phase 7 ruling 1: which learner — `mission` (M1.*) or `reading` (M2.*,
      // `scopeN` held-out readings). Authority ignores both by `source`.
      unit: r.unit ?? 'mission',
    }
  }
  for (const r of [...runners].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    rules[r.id] = {
      verdict: r.unmeasured ?? ruleVerdictOf(r),
      precision: r.precision ?? null, ci: r.ci ?? null, p: r.p ?? null, n: r.labeled ?? null,
      pAdjusted: r.pAdjusted ?? null, lift: r.lift ?? null, firedTotal: r.firedTotal ?? null, failures: r.failures ?? null,
      // `base` is the failure rate over the in-scope waves; `scopeN` how many.
      source: 'runner', scope: 'waves', base: r.base, scopeN: r.scopeN,
      // null, or the malformed wave records skipped (named).
      note: r.note,
      // `[{ missionId, why }]`: waves out of n because their grade did not run.
      unlabeled: r.unlabeled ?? [],
    }
  }
  // Review M4: the runner rows are counted in neither the rule count nor this
  // list — `predictive` and "N predictive of R rules" agree that R1 is not a
  // rule; a PREDICTIVE R1 is read in its own entry. (The `M1.*` rows keep their
  // Phase 5 place in the list.)
  const predictive = Object.keys(rules).filter(id => rules[id].verdict === 'PREDICTIVE' && rules[id].source !== 'runner')
  const prev = readRuleVerdicts(outPath)
  const changed = verdictChanges(verdictMap(prev), verdictMap({ rules }))
  // A model row that appeared, vanished or moved stays on the record — an M1
  // reaching PREDICTIVE must be findable — but it never bumps the version.
  const modelChanged = verdictChanges(modelVerdictMap(prev), modelVerdictMap({ rules }))
  // The runner rows, the same way (Phase 6).
  const runnerChanged = verdictChanges(runnerVerdictMap(prev), runnerVerdictMap({ rules }))
  const at = now()
  let version = Number.isInteger(prev?.version) ? prev.version : 0
  let history = Array.isArray(prev?.history) ? [...prev.history] : []
  const notes = { ...(modelChanged.length ? { modelChanged } : {}), ...(runnerChanged.length ? { runnerChanged } : {}) }
  if (!prev || changed.length > 0) {
    version += 1
    history.push({ version, at, campaign: campaign ?? null, predictive, changed, ...notes })
  } else if (modelChanged.length > 0 || runnerChanged.length > 0) {
    history.push({ version, at, campaign: campaign ?? null, predictive, changed: [], ...notes })
  }
  history = history.slice(-RULE_VERDICTS_HISTORY_CAP)
  const file = {
    schema: RULE_VERDICTS_SCHEMA, version, at, campaign: campaign ?? null,
    ledger: { total: res.total, labeled: res.labeled, failures: res.failures, base: res.base, rulesTested: res.rulesTested,
      ...(holmFamily === null ? {} : { holmFamily }),
      // F165: the rules scored on v2 missions only this write (absent when none fired).
      ...(v2Split ? { v2Rules: [...V2_CHANGED_RULES] } : {}) },
    rules, predictive, history,
  }
  mkdirSync(dirname(outPath), { recursive: true })
  const tmp = `${outPath}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  renameSync(tmp, outPath)
  // With model rows, their entries ride back too: the verdict entry prints
  // them (`Outcome hindcast:`) without reading the file a second time.
  // `total` counts every entry in the file; `rules` / `modelRows` split it, so
  // a reader can say "N of 8 rules (+2 model rows)" as the scoreboard does
  // (final review M7, T7-M5).
  // Phase 6: with runner rows, `runnerRows` counts them and `runners` carries
  // their entries, which the verdict entry names on its ladder line.
  return { version, predictive, total: Object.keys(rules).length, rules: res.rules.length, modelRows: models.length,
    ...(models.length ? { models: Object.fromEntries(models.map(r => [r.id, rules[r.id]])) } : {}),
    ...(runners.length ? { runnerRows: runners.length, runners: Object.fromEntries(runners.map(r => [r.id, rules[r.id]])) } : {}) }
}

/**
 * Phase 7 ruling 1: `writeRuleVerdicts(...).models` split by learner — the
 * mission ladder (`M1.*`, the hindcast's `ladder`) and the reading ladder
 * (`M2.*`, `hindcast.reading.ladder`). Each is null when it has no row.
 */
export function modelLaddersOf(models) {
  const pick = (unit) => {
    const e = Object.entries(models ?? {}).filter(([, v]) => (v?.unit ?? 'mission') === unit)
    return e.length ? Object.fromEntries(e) : null
  }
  return { mission: pick('mission'), reading: pick(READING_UNIT) }
}

/** The CLI's summary line: rules, model rows and runner rows counted apart, as the scoreboard reads them. */
export function verdictsLine(r, outPath) {
  const models = r.modelRows ? ` (+${r.modelRows} model row${r.modelRows === 1 ? '' : 's'})` : ''
  const runners = r.runnerRows ? ` (+${r.runnerRows} runner row${r.runnerRows === 1 ? '' : 's'})` : ''
  return `rule verdicts v${r.version}: ${r.predictive.length} predictive of ${r.rules} rules${models}${runners} (${r.predictive.join(', ') || 'none'}) → ${outPath}`
}

// CLI: rebuild the file by hand (the runner does it at every VERDICT).
//   bun scripts/cynco-rule-verdicts.mjs [--ledger-dir DIR] [--out PATH] [--with-hindcast] [--datasets-dir DIR] [--manifest PATH] [--campaigns-dir DIR]
//
// Every run builds the runner row `R1.no-progress` from the campaigns' wave
// records exactly as the VERDICT does (Task 4 review I1), so a hand rebuild
// corrects the rules over the same Holm family.
//
// Without `--with-hindcast` the rules alone are rewritten. With it, the
// runner's own VERDICT sequence runs (final review M7): exportOutcomeDatasets
// → runHindcast (python, capped) → hindcastOf → modelRowsFrom →
// writeRuleVerdicts, through scripts/cynco-hindcast.mjs's functions, and the
// hindcast line the verdict entry would carry is printed. A hindcast fault is
// printed as UNMEASURED and the rules are written without model rows — as the
// runner does. Phase 7 ruling 1: the reading learner runs beside it
// (exportReadingDataset over the campaigns' waves → runReadingHindcast →
// M2.* rows), its reading printed as the line's `; readings:` clause. `--datasets-dir DIR` puts the three datasets and
// outcome-model.json directly in DIR (default `<cyncoHome>/datasets`) and,
// unless `--out` is given, the verdict file too, and — unless `--manifest` is
// given — keeps the holdout manifest at `<DIR>/frozen-eval.json` (final review
// M8). Such a run WRITES nothing under the real home; it still READS
// `<cyncoHome>/campaigns` for the runner row unless `--campaigns-dir DIR` names
// another campaigns dir (Task 4 review N1).
//
// `engine/paths.js` is TypeScript behind a `.js` specifier and loads only under
// bun, so it is imported lazily, and only when something needs the real home:
// no --out and no --datasets-dir (the verdict file's place), no
// --campaigns-dir (the campaigns the runner row is read from), or
// --with-hindcast without --datasets-dir (the datasets' place). `deps` is the
// test seam (`readLedger`, `runHindcast`, `cyncoHome`, `log`).
export async function main(argv, deps = {}) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
  const log = deps.log ?? ((s) => console.log(s))
  const home = async () => (deps.cyncoHome ?? (await import('../engine/paths.js')).cyncoHome)()
  const withHindcast = argv.includes('--with-hindcast')
  const datasetsDir = arg('--datasets-dir') ? resolve(arg('--datasets-dir')) : null
  // The runner's own ledger reader (scripts/cynco-ledger-shards.mjs), so the
  // rows — and their order — are the ones a VERDICT hands the export.
  const readRows = deps.readLedger ?? (await import('./cynco-ledger-shards.mjs')).readLedger
  const rows = readRows(resolve(arg('--ledger-dir') ?? 'benchmark/cynco-ledger'))
  const outPath = arg('--out') ? resolve(arg('--out'))
    : datasetsDir ? join(datasetsDir, 'rule-verdicts.json')
      : RULE_VERDICTS_PATH(await home())
  // Review I1: the runner row the VERDICT builds, from the same construction
  // (scripts/cynco-runner-rows.mjs) over every runner-driven campaign's waves —
  // it is a member of the Holm family, so a rebuild without it would correct
  // the S5 rules over a smaller m than the VERDICT and could flip one.
  // `--campaigns-dir DIR` names the campaigns dir (default <cyncoHome>/campaigns).
  const campaignsDir = arg('--campaigns-dir') ? resolve(arg('--campaigns-dir')) : join(await home(), 'campaigns')
  const runnerMod = await import('./cynco-runner-rows.mjs')
  const runnerRows = runnerMod.runnerRowsFromCampaigns(campaignsDir)
  let modelRows = []
  if (withHindcast) {
    const hc = await import('./cynco-hindcast.mjs')
    const { hindcastLine } = await import('./cynco-campaign-verdict.mjs')
    let hindcast
    // `--manifest PATH` (F165 fix round 2): the per-version frozen holdout the
    // hindcast reads — and, when the current version's pool reaches the
    // minimum, freezes into. Default: `<DIR>/frozen-eval.json` when
    // `--datasets-dir DIR` is given (final review M8: a temp run never
    // performs the one-time freeze on the repo's committed manifest), else
    // the committed one, as the runner does.
    const manifestArg = arg('--manifest') ? resolve(arg('--manifest')) : datasetsDir ? join(datasetsDir, 'frozen-eval.json') : null
    const manifest = manifestArg ? { manifestPath: manifestArg } : {}
    try {
      const exported = hc.exportOutcomeDatasets({ rows, home: datasetsDir ? null : await home(), datasetsDir, ...manifest })
      if (!hc.hindcastReady(exported)) hindcast = { fault: hc.noEligibleFault(exported, hc.PRIMARY_TURNS) }
      else {
        const h = hc.hindcastOf((deps.runHindcast ?? hc.runHindcast)({ paths: exported.paths }), exported.paths.out)
        if (h.fault) hindcast = { fault: h.fault }
        // Task 2 review N3: a hand run that froze the holdout says so too.
        else { hindcast = { ...h.summary, ...(exported?.holdout ? { holdout: exported.holdout } : {}) }; modelRows = modelRowsFrom(h.model, rows) }
      }
    } catch (e) { hindcast = { fault: String(e?.message ?? e) } }
    // Phase 7 ruling 1: the reading learner, as the VERDICT runs it — the
    // interval dataset over the same campaigns' waves, its own `reading:2`
    // holdout, `--unit reading`, the M2.* rows. Its fault is its own reading.
    let reading
    try {
      const waves = runnerMod.runnerWaves(campaignsDir).map(({ record }) => record)
      const exportedR = hc.exportReadingDataset({ rows, waves, home: datasetsDir ? null : await home(), datasetsDir, ...manifest })
      const rh = hc.runReadingHindcast({ exported: exportedR, runHindcast: deps.runHindcast ?? hc.runHindcast })
      reading = rh.reading
      modelRows = [...modelRows, ...modelRowsFrom(rh.model, exportedR.intervals, { unit: READING_UNIT })]
    } catch (e) { reading = { fault: String(e?.message ?? e) } }
    hindcast.reading = reading
    const r = writeRuleVerdicts({ rows, campaign: null, outPath, modelRows, runnerRows })
    const ladders = modelLaddersOf(r.models)
    if (!hindcast.fault) hindcast.ladder = ladders.mission
    if (!reading.fault) reading.ladder = ladders.reading
    log(hindcastLine(hindcast, { runners: r.runners ?? null }))
    log(verdictsLine(r, outPath))
    return 0
  }
  log(verdictsLine(writeRuleVerdicts({ rows, campaign: null, outPath, runnerRows }), outPath))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e?.message ?? e); process.exit(1) })
