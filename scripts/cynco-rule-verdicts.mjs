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
import { analyse as analyseFn, ruleVerdictOf, readLedger, holm, wilson } from './cynco-signal-validation.mjs'

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

/** id → verdict string, from a file (or {} for none). */
const verdictMap = (file) => Object.fromEntries(Object.entries(file?.rules ?? {}).map(([id, r]) => [id, r?.verdict ?? null]))

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
 * in what S5 is allowed to enforce, not verdicts. The numbers (p, lift,
 * counts) are refreshed on every write regardless. History keeps the last 20
 * changes. Written tmp + rename.
 *
 * Returns `{ version, predictive, total }` — what the wave record carries.
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
  const at = now()
  let version = Number.isInteger(prev?.version) ? prev.version : 0
  let history = Array.isArray(prev?.history) ? [...prev.history] : []
  if (!prev || changed.length > 0) {
    version += 1
    history.push({ version, at, campaign: campaign ?? null, predictive, changed })
    history = history.slice(-RULE_VERDICTS_HISTORY_CAP)
  }
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
  return { version, predictive, total: Object.keys(rules).length,
    ...(models.length ? { models: Object.fromEntries(models.map(r => [r.id, rules[r.id]])) } : {}) }
}

// CLI: rebuild the file by hand (the runner does it at every VERDICT).
//   bun scripts/cynco-rule-verdicts.mjs [--ledger-dir DIR] [--out PATH]
// `engine/paths.js` is TypeScript behind a `.js` specifier and loads only under
// bun, so it is imported lazily and only when --out is not given.
async function main(argv) {
  const dirIdx = argv.indexOf('--ledger-dir')
  const outIdx = argv.indexOf('--out')
  const rows = readLedger(dirIdx >= 0 ? argv[dirIdx + 1] : 'benchmark/cynco-ledger')
  const outPath = outIdx >= 0 ? resolve(argv[outIdx + 1]) : RULE_VERDICTS_PATH((await import('../engine/paths.js')).cyncoHome())
  const r = writeRuleVerdicts({ rows, campaign: null, outPath })
  console.log(`rule verdicts v${r.version}: ${r.predictive.length} predictive of ${r.total} (${r.predictive.join(', ') || 'none'}) → ${outPath}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e?.message ?? e); process.exit(1) })
