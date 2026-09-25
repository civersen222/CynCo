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
import { analyse as analyseFn, ruleVerdictOf, readLedger } from './cynco-signal-validation.mjs'

export const RULE_VERDICTS_PATH = (home) => join(home, 'datasets', 'rule-verdicts.json')
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
 */
export function writeRuleVerdicts({ rows, campaign, outPath, analyse = analyseFn, now = () => new Date().toISOString() }) {
  const res = analyse(rows)
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
    ledger: { total: res.total, labeled: res.labeled, failures: res.failures, base: res.base, rulesTested: res.rulesTested },
    rules, predictive, history,
  }
  mkdirSync(dirname(outPath), { recursive: true })
  const tmp = `${outPath}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  renameSync(tmp, outPath)
  return { version, predictive, total: Object.keys(rules).length }
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
