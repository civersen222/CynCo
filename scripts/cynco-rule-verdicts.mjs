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
import { analyse as analyseFn, ruleVerdictOf, holm, wilson } from './cynco-signal-validation.mjs'

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
export function modelRowsFrom(outcomeModel, rows) {
  const models = outcomeModel?.models
  if (!models || typeof models !== 'object') return []
  const inLedger = new Set((rows ?? []).map(r => r?.missionId))
  return Object.keys(models).sort().map(k => {
    const preds = (models[k]?.predictions ?? []).filter(p => inLedger.has(p?.missionId))
    return {
      id: `M1.${k}`, source: 'model',
      fired: new Set(preds.filter(p => typeof p.pFail === 'number' && p.pFail >= MODEL_FIRE_THRESHOLD).map(p => p.missionId)),
      scope: new Set(preds.map(p => p.missionId)),
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
  const scoped = rows.filter(r => m.scope.has(r?.missionId))
  const res = analyse(scoped, { firedOf: (r) => (m.fired.has(r?.missionId) ? new Set([m.id]) : new Set()) })
  const r = res.rules.find(x => x.id === m.id)
    ?? { id: m.id, firedTotal: 0, labeled: 0, failures: 0, precision: null, ci: wilson(0, 0), lift: null, p: null, coverage: 0 }
  return { ...r, base: res.labeled ? res.base : null, scopeN: res.labeled }
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

/** id → verdict string, from a file (or {} for none) — the S5 RULES only. The
 *  learner's `M1.*` rows (`source: 'model'`) are not in the version's meaning:
 *  nothing S5 may enforce changes when one appears, vanishes or moves (final
 *  review M2, T5-M2); they are compared by `modelVerdictMap` instead. */
const verdictMap = (file) => Object.fromEntries(Object.entries(file?.rules ?? {}).filter(([, r]) => r?.source !== 'model').map(([id, r]) => [id, r?.verdict ?? null]))
/** id → verdict string for the `M1.*` model rows only. */
const modelVerdictMap = (file) => Object.fromEntries(Object.entries(file?.rules ?? {}).filter(([, r]) => r?.source === 'model').map(([id, r]) => [id, r?.verdict ?? null]))

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
 * PREDICTIVE is the next phase's advisory input, nothing more. With no model
 * rows the file is exactly what it was before Phase 5.
 */
export function writeRuleVerdicts({ rows, campaign, outPath, analyse = analyseFn, now = () => new Date().toISOString(), modelRows = [] }) {
  const res = analyse(rows)
  const models = (modelRows ?? []).map(m => modelRuleOf(m, rows, analyse))
  // Rules first, then models, as one Holm family. Only when there are model
  // rows: without them the rules keep `analyse`'s own correction untouched.
  const holmFamily = models.length ? holm([...res.rules, ...models]) : null
  const rules = {}
  for (const r of [...res.rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    rules[r.id] = {
      // Spec schema: { verdict, precision, ci, p, n } — `n` is the labeled
      // missions the rule fired on (analyse's `labeled`), `ci` its Wilson
      // interval. The rest ride along for the reader who wants the table.
      verdict: ruleVerdictOf(r),
      precision: r.precision ?? null, ci: r.ci ?? null, p: r.p ?? null, n: r.labeled ?? null,
      pAdjusted: r.pAdjusted ?? null, lift: r.lift ?? null, firedTotal: r.firedTotal ?? null, failures: r.failures ?? null,
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
    }
  }
  const predictive = Object.keys(rules).filter(id => rules[id].verdict === 'PREDICTIVE')
  const prev = readRuleVerdicts(outPath)
  const changed = verdictChanges(verdictMap(prev), verdictMap({ rules }))
  // A model row that appeared, vanished or moved stays on the record — an M1
  // reaching PREDICTIVE must be findable — but it never bumps the version.
  const modelChanged = verdictChanges(modelVerdictMap(prev), modelVerdictMap({ rules }))
  const at = now()
  let version = Number.isInteger(prev?.version) ? prev.version : 0
  let history = Array.isArray(prev?.history) ? [...prev.history] : []
  const modelNote = modelChanged.length ? { modelChanged } : {}
  if (!prev || changed.length > 0) {
    version += 1
    history.push({ version, at, campaign: campaign ?? null, predictive, changed, ...modelNote })
  } else if (modelChanged.length > 0) {
    history.push({ version, at, campaign: campaign ?? null, predictive, changed: [], modelChanged })
  }
  history = history.slice(-RULE_VERDICTS_HISTORY_CAP)
  const file = {
    schema: RULE_VERDICTS_SCHEMA, version, at, campaign: campaign ?? null,
    ledger: { total: res.total, labeled: res.labeled, failures: res.failures, base: res.base, rulesTested: res.rulesTested,
      ...(holmFamily === null ? {} : { holmFamily }) },
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
  return { version, predictive, total: Object.keys(rules).length, rules: res.rules.length, modelRows: models.length,
    ...(models.length ? { models: Object.fromEntries(models.map(r => [r.id, rules[r.id]])) } : {}) }
}

/** The CLI's summary line: rules and model rows counted apart, as the scoreboard reads them. */
export function verdictsLine(r, outPath) {
  const models = r.modelRows ? ` (+${r.modelRows} model row${r.modelRows === 1 ? '' : 's'})` : ''
  return `rule verdicts v${r.version}: ${r.predictive.length} predictive of ${r.rules} rules${models} (${r.predictive.join(', ') || 'none'}) → ${outPath}`
}

// CLI: rebuild the file by hand (the runner does it at every VERDICT).
//   bun scripts/cynco-rule-verdicts.mjs [--ledger-dir DIR] [--out PATH] [--with-hindcast] [--datasets-dir DIR]
//
// Without `--with-hindcast` the rules alone are rewritten. With it, the
// runner's own VERDICT sequence runs (final review M7): exportOutcomeDatasets
// → runHindcast (python, capped) → hindcastOf → modelRowsFrom →
// writeRuleVerdicts, through scripts/cynco-hindcast.mjs's functions, and the
// hindcast line the verdict entry would carry is printed. A hindcast fault is
// printed as UNMEASURED and the rules are written without model rows — as the
// runner does. `--datasets-dir DIR` puts the three datasets and
// outcome-model.json directly in DIR (default `<cyncoHome>/datasets`) and,
// unless `--out` is given, the verdict file too — so a test or a temp run never
// touches the real home.
//
// `engine/paths.js` is TypeScript behind a `.js` specifier and loads only under
// bun, so it is imported lazily and only when neither --out nor --datasets-dir
// names where to write. `deps` is the test seam (`readLedger`, `runHindcast`,
// `cyncoHome`, `log`).
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
  let modelRows = []
  if (withHindcast) {
    const hc = await import('./cynco-hindcast.mjs')
    const { hindcastLine } = await import('./cynco-campaign-verdict.mjs')
    let hindcast
    try {
      const exported = hc.exportOutcomeDatasets({ rows, home: datasetsDir ? null : await home(), datasetsDir })
      if (!exported?.n) hindcast = { fault: `no eligible labeled mission at K = ${hc.PRIMARY_TURNS} turns — nothing to train on` }
      else {
        const h = hc.hindcastOf((deps.runHindcast ?? hc.runHindcast)({ paths: exported.paths }), exported.paths.out)
        if (h.fault) hindcast = { fault: h.fault }
        else { hindcast = h.summary; modelRows = modelRowsFrom(h.model, rows) }
      }
    } catch (e) { hindcast = { fault: String(e?.message ?? e) } }
    const r = writeRuleVerdicts({ rows, campaign: null, outPath, modelRows })
    if (!hindcast.fault) hindcast.ladder = r.models ?? null
    log(hindcastLine(hindcast))
    log(verdictsLine(r, outPath))
    return 0
  }
  log(verdictsLine(writeRuleVerdicts({ rows, campaign: null, outPath }), outPath))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e?.message ?? e); process.exit(1) })
