/**
 * Step 2 of the governance falsification program: do the S5 rules predict
 * anything?
 *
 * The ledger pairs each mission's governance decisions with an externally
 * graded outcome. Step 3 — training a decision model on those decisions — is
 * only worth doing if the decisions carry information in the first place. A
 * rule that fires on every mission predicts nothing no matter how sensible its
 * reasoning string reads, and imitating it would launder noise into weights.
 *
 * So this asks one question per rule:
 *
 *     among LABELED missions, does this rule fire more often on the ones that
 *     failed than on the ones that did not?
 *
 * The honest answer for most rules will be "we cannot tell yet", and the point
 * of this tool is to say that with a number attached rather than to produce a
 * ranking that looks decisive at n=5.
 *
 * Labels follow benchmark/cynco-ledger/README.md exactly and are not relaxed:
 *
 *   success   = outcome === 'landed' && verified === true && the sweep left no
 *               survivor that a DoD item claimed to own
 *   failure   = labeled and not success
 *   unlabeled = verified === null || mutationSweep === null   (EXCLUDED)
 *
 * `mutationSweep === null` means a withheld mutation set never ran, so nothing
 * checked whether the delivered tests actually own the rules they claim. An
 * unmeasured mission is not a passing one; it is excluded, never defaulted.
 *
 * Usage:
 *   node scripts/cynco-signal-validation.mjs [--json] [--ledger-dir DIR]
 *   bun  scripts/cynco-signal-validation.mjs --denials [--triples PATH] [--json]
 *   bun  scripts/cynco-signal-validation.mjs --gate-lines [--json]
 *        (the lines table, then the per-campaign GATES table; --json prints
 *        only the line summary)
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_DIR = 'benchmark/cynco-ledger'

// ── Statistics ───────────────────────────────────────────────────

/** log(n!) via lgamma, so 2x2 tables do not overflow at any ledger size. */
function lnFactorial(n) {
  // Lanczos approximation of ln Γ(n+1). Exact enough for p-values reported to 3dp.
  if (n < 2) return 0
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  let x = n + 1
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Probability of exactly this 2x2 table under the hypergeometric null. */
function hypergeomP(a, b, c, d) {
  const n = a + b + c + d
  return Math.exp(
    lnFactorial(a + b) + lnFactorial(c + d) + lnFactorial(a + c) + lnFactorial(b + d) -
    lnFactorial(n) - lnFactorial(a) - lnFactorial(b) - lnFactorial(c) - lnFactorial(d),
  )
}

/**
 * Two-sided Fisher exact test.
 *
 * Two-sided and not one-sided on purpose: a rule that fires MORE often on
 * successes is not a null result, it is a rule pointing the wrong way, and a
 * one-sided test would quietly file it under "no evidence".
 */
export function fisherExact(a, b, c, d) {
  const observed = hypergeomP(a, b, c, d)
  const rowA = a + b, colA = a + c, n = a + b + c + d
  const lo = Math.max(0, colA - (n - rowA))
  const hi = Math.min(rowA, colA)
  let p = 0
  for (let x = lo; x <= hi; x++) {
    const px = hypergeomP(x, rowA - x, colA - x, n - rowA - colA + x)
    // 1e-9 slack: tables that are equiprobable in exact arithmetic can differ
    // in the last bits after exp(), and dropping one would understate p.
    if (px <= observed * (1 + 1e-9)) p += px
  }
  return Math.min(1, p)
}

/**
 * Wilson score interval. Not the normal approximation: at n=3 with 1 failure,
 * the normal interval runs below zero and reads as precision, which is exactly
 * the over-claim this tool exists to prevent.
 */
export function wilson(successes, n, z = 1.96) {
  if (n === 0) return [0, 1]
  const p = successes / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const halfWidth = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (centre - halfWidth) / d), Math.min(1, (centre + halfWidth) / d)]
}

// ── Ledger ───────────────────────────────────────────────────────

export function readLedger(dir) {
  const files = readdirSync(dir).filter(f => /^missions.*\.jsonl$/.test(f)).sort()
  const rows = []
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line))
    }
  }
  return rows
}

/** true = success, false = failure, null = unlabeled. See README labeling rule.
 *
 * The survivor clause is not optional and was missing here at first. The README
 * has always said success requires `mutationSweep` to have "no survivor that a
 * DoD item claimed to own", and cynco-ledger.mjs has always defined `accepted`
 * as killed === total. Dropping that clause silently relabeled 19 of 75 rows
 * from failure to success and moved the base failure rate from 62.7% to 37.3%
 * — a mission that landed, passed its check-cmd, and left eight of its own
 * claimed rules unpinned is not a success, and counting it as one is the exact
 * laundering this ledger was built to prevent.
 */
export function labelOf(row) {
  if (row.verified === null || row.verified === undefined) return null
  const sweep = row.mutationSweep
  if (sweep === null || sweep === undefined) return null
  if (row.outcome !== 'landed' || row.verified !== true) return false
  // A DERIVED sweep mutates whatever expressions the mission's diff happened to
  // add (see scripts/cynco-mutation-sweep.py). Its survivors are real findings
  // about test coverage, but they are not rules a DoD item claimed to own, so
  // they cannot be read as "the mission failed its own definition of done".
  // Conflating the two would fail every mission whose brief told it not to add
  // tests. It still counts as MEASURED, which is the point of running it.
  if (sweep.kind === 'derived') return true
  return (sweep.survived ?? []).length === 0
}

/** Rule ids that fired at least once during a mission. Set, not multiset: the
 *  unit of analysis is the mission, and a rule firing nine times in one run is
 *  one mission's worth of evidence, not nine. */
export function rulesFired(row) {
  const out = new Set()
  for (const d of row.s5Decisions ?? []) {
    for (const id of d.ruleIds ?? []) out.add(id)
  }
  return out
}

/** The invariants that denied at least once in a mission — the "rule fired"
 *  reading of a denial, so the S5 machinery above can ask the mission-level
 *  question of an invariant unchanged. */
export function invariantsFired(row) {
  const out = new Set()
  for (const [k, n] of Object.entries(row?.invariants?.denialsByInvariant ?? {})) if (n > 0) out.add(k)
  return out
}

export function analyse(rows, { firedOf = rulesFired } = {}) {
  const labeled = rows.map(r => ({ row: r, label: labelOf(r) })).filter(x => x.label !== null)
  const nFail = labeled.filter(x => x.label === false).length
  const base = labeled.length ? nFail / labeled.length : 0

  const ids = new Set()
  for (const r of rows) for (const id of firedOf(r)) ids.add(id)

  const rules = [...ids].map(id => {
    let a = 0, b = 0, c = 0, d = 0     // a=fired&failed b=fired&ok c=quiet&failed d=quiet&ok
    for (const { row, label } of labeled) {
      const fired = firedOf(row).has(id)
      if (fired && label === false) a++
      else if (fired) b++
      else if (label === false) c++
      else d++
    }
    const firedTotal = rows.filter(r => firedOf(r).has(id)).length
    const nOnLabeled = a + b
    const precision = nOnLabeled ? a / nOnLabeled : null
    return {
      id, firedTotal, labeled: nOnLabeled, failures: a,
      precision,
      ci: wilson(a, nOnLabeled),
      lift: precision === null ? null : precision - base,
      p: (a + b === 0 || c + d === 0) ? null : fisherExact(a, b, c, d),
      coverage: labeled.length ? nOnLabeled / labeled.length : 0,
    }
  })
  // Holm-Bonferroni across every rule tested in this run.
  //
  // Eight rules are eight chances to land under 0.05, and at this ledger size
  // the raw p-values sit right where that matters: two rules read "significant"
  // uncorrected and neither survives. Reporting the raw p alone would hand back
  // a green light built out of the number of rules we happen to have.
  const tested = rules.filter(r => r.p !== null).sort((x, y) => x.p - y.p)
  let running = 0
  tested.forEach((r, i) => {
    const adj = Math.min(1, r.p * (tested.length - i))
    running = Math.max(running, adj)          // Holm's p-values are monotone
    r.pAdjusted = running
  })
  for (const r of rules) if (r.p === null) r.pAdjusted = null

  rules.sort((x, y) => y.firedTotal - x.firedTotal)
  return {
    total: rows.length, labeled: labeled.length, failures: nFail, base,
    rulesTested: tested.length, rules,
  }
}

// ── Denials: did the denial change the next call? ─────────────────
//
// The unit here is the DENIAL, not the mission. For each invariant the 2×2
// table is (denials followed by the call the denial asked for) against
// (quiet calls followed by that class) — where the quiet rate is the
// session's own class share (ruling 4 of the Phase 1 spec): the ledger has
// no per-call sequence, so `byClass.sourceEdit / total` stands in for "how
// often does an edit follow any call". The table is printed so the
// approximation stays visible; it is conservative (the quiet rate includes
// the denial-driven edits), so it cannot manufacture significance.
export const DENIAL_MIN = 30
const CAP_INVARIANTS = ['edit-gap', 'commit-gap']

export function denialVerdict(r) {
  if (r.invariant === 'revert') return 'IDENTITY'
  if (r.denials < DENIAL_MIN) return 'TOO FEW'
  if (r.pAdjusted !== null && r.pAdjusted < 0.05 && r.ci[1] < r.baseRate) return 'INERT'
  if (r.pAdjusted !== null && r.pAdjusted < 0.05 && r.ci[0] > r.baseRate) return 'EFFECTIVE'
  return 'NO EVIDENCE'
}

export function analyseDenials(summary) {
  const kinds = ['edit-gap', 'commit-gap', 'revert']
  const invariants = kinds.map(invariant => {
    const d = summary.denials?.[invariant] ?? { denials: 0, complied: 0, changed: 0 }
    const q = summary.quiet?.[invariant] ?? { calls: 0, complied: 0 }
    const a = d.complied, b = d.denials - d.complied, c = q.complied, dd = Math.max(0, q.calls - q.complied)
    const testable = CAP_INVARIANTS.includes(invariant) && d.denials >= DENIAL_MIN && q.calls > 0
    return {
      invariant, denials: d.denials, complied: d.complied, changed: d.changed,
      compliedRate: d.denials ? d.complied / d.denials : null, ci: wilson(d.complied, d.denials),
      quietCalls: q.calls, quietComplied: q.complied, baseRate: q.calls ? q.complied / q.calls : null,
      p: testable ? fisherExact(a, b, c, dd) : null, pAdjusted: null, verdict: null,
    }
  })
  const tested = invariants.filter(r => r.p !== null).sort((x, y) => x.p - y.p)
  let running = 0
  tested.forEach((r, i) => { running = Math.max(running, Math.min(1, r.p * (tested.length - i))); r.pAdjusted = running })
  for (const r of invariants) r.verdict = denialVerdict(r)
  return { invariants }
}

export function denialTable(res) {
  const pct = v => (v === null ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%')
  const lines = ['invariant   denials  complied  rate     95% CI        quiet rate     p    p(Holm)  verdict']
  for (const r of res.invariants) {
    const [lo, hi] = r.ci
    lines.push(`${r.invariant.padEnd(11)} ${String(r.denials).padStart(7)} ${String(r.complied).padStart(9)}  ${pct(r.compliedRate)}  [${(lo * 100).toFixed(0).padStart(3)}%,${(hi * 100).toFixed(0).padStart(4)}%]  ${pct(r.baseRate)}  ${r.p === null ? '  —  ' : r.p.toFixed(3)}   ${r.pAdjusted === null ? '  —  ' : r.pAdjusted.toFixed(3)}   ${r.verdict}`)
  }
  return lines
}

// ── Gate lines: does a CynCo-authored gate line hold? ─────────────
//
// The unit is the GRADED GATE LINE (scripts/cynco-gate-lines.mjs builds the
// rows). Two bars, and the seat has to clear both before it earns the right to
// seal its own gates:
//
//   1. VOLUME — at least GATE_AUTHOR_MIN_LINES terminal CynCo lines. One
//      campaign ships nine to seventeen, so this is two campaigns' worth of
//      evidence and not a lucky one.
//   2. FLOOR — the Wilson lower bound on the held rate is at or above
//      GATE_AUTHOR_HELD_FLOOR. The point estimate is not enough: 4/4 held is a
//      100 % rate with a lower bound of 0.40.
//
// ...and it must not be significantly WORSE than the human seat it is asking
// to replace, which is the Fisher test on held × author.
//
// Both thresholds live HERE, beside DENIAL_MIN, for the same reason (spec
// ruling 3): a threshold with two homes is a threshold that drifts.
// `scripts/cynco-gate-author.mjs` re-exports them so the promotion reads the
// same two numbers this table prints — it cannot import them the other way,
// because that module reaches the bun-only grade chain and this one is run
// under plain node.
export const GATE_AUTHOR_MIN_LINES = 30
export const GATE_AUTHOR_HELD_FLOOR = 0.8

/**
 * `TOO FEW` (not enough lines to tell) | `PARITY` (clears the floor and is not
 * significantly worse than the human) | `BELOW FLOOR`.
 *
 * `BELOW FLOOR` is also what a seat that clears the floor but reads
 * significantly worse than the human gets: there are three verdicts and only
 * one of them is "this seat has earned it", so the shortfall — whichever of the
 * two it is — lands in the same bucket. The table prints both numbers beside
 * it, so which one fired is never a guess.
 */
export function gateLineVerdict(summary) {
  const c = summary?.byAuthor?.cynco
  if (!c || c.n < GATE_AUTHOR_MIN_LINES) return 'TOO FEW'
  if (c.ci[0] < GATE_AUTHOR_HELD_FLOOR) return 'BELOW FLOOR'
  const human = summary?.byAuthor?.human
  const worse = summary?.fisher?.p !== null && summary?.fisher?.p < 0.05 && human?.rate !== null && human?.rate !== undefined && c.rate < human.rate
  return worse ? 'BELOW FLOOR' : 'PARITY'
}

/** The gate-line table, as lines. Mirrors `denialTable`: the printer prints. */
export function gateLineTable(summary) {
  const pct = v => (v === null || v === undefined ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%')
  const lines = ['author  lines   held  rate     95% CI']
  for (const author of ['cynco', 'human']) {
    const b = summary?.byAuthor?.[author] ?? { n: 0, held: 0, rate: null, ci: [0, 1] }
    lines.push(`${author.padEnd(6)} ${String(b.n).padStart(6)} ${String(b.held).padStart(6)}  ${pct(b.rate)}  [${(b.ci[0] * 100).toFixed(0).padStart(3)}%,${(b.ci[1] * 100).toFixed(0).padStart(4)}%]`)
  }
  const f = summary?.fisher ?? { p: null, table: [[0, 0], [0, 0]] }
  lines.push('')
  lines.push(`Fisher p ${f.p === null ? '—' : f.p.toFixed(3)} on ${JSON.stringify(f.table)} (held vs resealed, cynco row first).`)
  lines.push(`Verdict: ${gateLineVerdict(summary)} — the seat needs ${GATE_AUTHOR_MIN_LINES} terminal CynCo lines and a Wilson lower bound at or above ${GATE_AUTHOR_HELD_FLOOR}.`)
  return lines
}

/**
 * The GATES table: one row per campaign from the gate-outcomes dataset
 * (scripts/cynco-gate-lines.mjs `gateOutcomeRows`) — how each seal ended,
 * including the refused ones the line table above cannot see.
 */
export function gateOutcomeTable(rows) {
  const lines = ['campaign  author  outcome    refusals  attempts']
  for (const r of rows ?? []) {
    lines.push(`${String(r.campaign).padEnd(8)}  ${String(r.author).padEnd(6)}  ${String(r.outcome).padEnd(9)}  ${String(r.refusals ?? '—').padStart(8)}  ${String(r.attempts ?? '—').padStart(8)}`)
  }
  if (!(rows ?? []).length) lines.push('(no campaign has sealed or been refused yet)')
  return lines
}

export function printGateLineTable(summary) {
  for (const l of gateLineTable(summary)) console.log(l)
}

// ── Brain candidate signals (Task 4, 2a-iii) ───────────────────────
//
// scripts/cynco-ledger.mjs lifts the engine's per-turn `brain` telemetry
// (layer-convergence agreement/depth, tool-token entropy) onto each row as
// `brainStats`. That is data, not a rule: it earns nothing until it clears
// the same bar every S5 rule has to clear in `analyse` above. These two
// functions turn the two continuous readings into three candidate boolean
// signals by quartile cut, so `analyse` can ask its one question of them —
// "does this fire more often on missions that failed?" — same as any rule id.
//
// Thresholds live HERE ONLY (spec ruling 3). Nothing in the engine or the
// ledger collector applies one; a `brainStats` row is just a measurement
// until this file cuts it.

/** Nearest-rank percentile: rank = ceil(p * n), 1-indexed into the ascending
 *  sort. Stated explicitly because "the 25th/75th percentile" is ambiguous
 *  between several interpolation schemes and this tool's numbers must be
 *  reproducible by hand against a small ledger, not just by re-running it. */
function nearestRankPercentile(sortedAsc, p) {
  const n = sortedAsc.length
  if (n === 0) return null
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)))
  return sortedAsc[rank - 1]
}

/** { agree: [q1, q3], entropy: [q1, q3] } over LABELED rows (labelOf !== null)
 *  that carry `brainStats` — an unmeasured or brain-less row must not pull
 *  the cut points toward its own missing reading. */
export function signalQuartiles(rows) {
  const agreeVals = []
  const entropyVals = []
  for (const row of rows) {
    if (labelOf(row) === null) continue
    const bs = row.brainStats
    if (!bs) continue
    if (bs.meanAgree != null) agreeVals.push(bs.meanAgree)
    if (bs.meanToolEntropy != null) entropyVals.push(bs.meanToolEntropy)
  }
  agreeVals.sort((a, b) => a - b)
  entropyVals.sort((a, b) => a - b)
  return {
    agree: [nearestRankPercentile(agreeVals, 0.25), nearestRankPercentile(agreeVals, 0.75)],
    entropy: [nearestRankPercentile(entropyVals, 0.25), nearestRankPercentile(entropyVals, 0.75)],
  }
}

/** The candidate signals a single row fires, against pre-computed quartiles:
 *    LC-low  — layer convergence agreement at/below the 25th percentile
 *              (the probed layers disagreed with the deepest one)
 *    LC-high — agreement at/above the 75th percentile (they agreed a lot)
 *    TE-high — tool-token entropy at/above the 75th percentile (the model was
 *              uncertain which tool to call)
 *  A row with no `brainStats` fires nothing — absence is not a reading. */
export function signalsFired(row, quartiles) {
  const out = new Set()
  const bs = row?.brainStats
  if (!bs) return out
  if (bs.meanAgree != null) {
    if (quartiles.agree[0] != null && bs.meanAgree <= quartiles.agree[0]) out.add('LC-low')
    if (quartiles.agree[1] != null && bs.meanAgree >= quartiles.agree[1]) out.add('LC-high')
  }
  if (bs.meanToolEntropy != null && quartiles.entropy[1] != null && bs.meanToolEntropy >= quartiles.entropy[1]) {
    out.add('TE-high')
  }
  return out
}

// ── Report ───────────────────────────────────────────────────────

/**
 * The S5 verdict for one `analyse` rule row. Exported (Phase 4) because the
 * table is no longer its only reader: `scripts/cynco-rule-verdicts.mjs` stores
 * these exact strings in `~/.cynco/datasets/rule-verdicts.json`, and the
 * engine's per-rule S5 authority (`engine/s5/ruleAuthority.ts`) grants
 * enforcement only to a rule whose stored string is `'PREDICTIVE'`. One
 * function, so the table and the authority can never disagree.
 */
export function ruleVerdictOf(r) {
  if (r.labeled < 10) return 'TOO FEW — cannot tell'
  if (r.coverage > 0.95) return 'CONSTANT — fires on everything, predicts nothing'
  const p = r.pAdjusted
  if (p !== null && p < 0.05 && r.lift > 0) return 'PREDICTIVE'
  if (p !== null && p < 0.05 && r.lift < 0) return 'INVERTED — fires more on successes'
  if (r.p !== null && r.p < 0.05) return 'NOT AFTER CORRECTION — chance across this many rules'
  return 'NO EVIDENCE'
}

/** The rule-table body shared by the default S5 report and `--signals`: the
 *  per-id precision/CI/lift/p row, the Holm footnote, and the closing
 *  verdict line. Factored out (M8-style: one table, one printer) so a second
 *  candidate-signal family does not grow its own copy that quietly drifts
 *  from this one's column meanings. */
export function printRuleTable(res) {
  const pct = v => (v === null ? '   —  ' : (v * 100).toFixed(1).padStart(5) + '%')
  console.log('rule    fired  labeled  fails  precision   95% CI         lift       p    p(Holm)  verdict')
  for (const r of res.rules) {
    const [lo, hi] = r.ci
    console.log(
      `${r.id.padEnd(6)} ${String(r.firedTotal).padStart(6)} ${String(r.labeled).padStart(8)}` +
      ` ${String(r.failures).padStart(6)}   ${pct(r.precision)}   ` +
      `[${(lo * 100).toFixed(0).padStart(3)}%,${(hi * 100).toFixed(0).padStart(4)}%] ` +
      `${r.lift === null ? '    —  ' : ((r.lift >= 0 ? '+' : '') + (r.lift * 100).toFixed(1) + 'pp').padStart(7)}` +
      `  ${r.p === null ? '  —  ' : r.p.toFixed(3)}` +
      `   ${r.pAdjusted === null ? '  —  ' : r.pAdjusted.toFixed(3)}   ${ruleVerdictOf(r)}`,
    )
  }
  console.log()
  console.log(`${res.rulesTested} rules tested; p(Holm) corrects for that. A rule is only`)
  console.log('called predictive on the corrected value.')
  console.log()
  const usable = res.rules.filter(r => ruleVerdictOf(r) === 'PREDICTIVE')
  console.log(usable.length === 0
    ? 'No rule clears the bar. Enforcement authority stays withheld, and there is\n' +
      'nothing here worth training a decision model to imitate yet.'
    : `Predictive: ${usable.map(r => r.id).join(', ')}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const dirIdx = argv.indexOf('--ledger-dir')
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : DEFAULT_DIR

  if (argv.includes('--denials')) {
    const tIdx = argv.indexOf('--triples')
    const { exportTriples } = await import('./cynco-triples.mjs')
    const summaryPath = tIdx >= 0 ? argv[tIdx + 1] : null
    const summary = summaryPath ? JSON.parse(readFileSync(summaryPath, 'utf-8')) : exportTriples().summary
    const res = analyseDenials(summary)
    const mission = analyse(readLedger(dir), { firedOf: invariantsFired })
    if (argv.includes('--json')) { console.log(JSON.stringify({ denials: res, missions: mission }, null, 2)); return }
    console.log('DENIALS — did the denial change the next call? (unit: the denial)')
    for (const l of denialTable(res)) console.log(l)
    console.log()
    console.log(`INVARIANTS AS RULES — does a mission with ≥ 1 denial fail more often? (unit: the mission; ${mission.labeled} labeled of ${mission.total})`)
    for (const r of mission.rules) console.log(`  ${r.id.padEnd(11)} fired ${String(r.firedTotal).padStart(3)}  labeled ${String(r.labeled).padStart(3)}  fails ${String(r.failures).padStart(3)}  p ${r.p === null ? '  —  ' : r.p.toFixed(3)}  p(Holm) ${r.pAdjusted === null ? '  —  ' : r.pAdjusted.toFixed(3)}`)
    if (mission.rules.length === 0) console.log('  (no mission with an invariants block has a denial yet)')
    console.log()
    console.log('GOVERNANCE POSIWID — per campaign, the latest wave\'s reading (stated purpose: regulate)')
    const campaignIds = Object.keys(summary.campaigns ?? {})
    for (const id of campaignIds) {
      const g = summary.campaigns[id]?.governancePosiwid
      console.log(g
        ? `  ${id}: ${g.verdict} (divergence ${g.divergence.toFixed(3)}, dominant ${g.dominantObserved}, support ${g.support}${g.onsetWave ? `; drift onset wave ${g.onsetWave}` : ''})`
        : `  ${id}: no reading yet`)
    }
    if (campaignIds.length === 0) console.log('  (no campaign yet)')
    return
  }

  // Imported lazily, exactly as `--denials` imports the triples exporter: both
  // reach `engine/paths.js`, which is TypeScript behind a `.js` specifier and
  // only loads under bun. The default report and `--signals` must keep running
  // under plain node, so neither module may be a static import here.
  if (argv.includes('--gate-lines')) {
    const { exportGateLines, exportGateOutcomes } = await import('./cynco-gate-lines.mjs')
    const r = exportGateLines()
    if (argv.includes('--json')) { console.log(JSON.stringify(r.summary, null, 2)); return }
    console.log(`GATE LINES — did the sealed line hold? (unit: the graded line; ${r.rows.length} row(s) → ${r.outPath})`)
    printGateLineTable(r.summary)
    const o = exportGateOutcomes()
    console.log()
    console.log(`GATES — how did each seal end? (unit: the campaign; ${o.rows.length} row(s) → ${o.outPath})`)
    for (const l of gateOutcomeTable(o.rows)) console.log(l)
    return
  }

  if (argv.includes('--signals')) {
    const rows = readLedger(dir)
    const quartiles = signalQuartiles(rows)
    const res = analyse(rows, { firedOf: r => signalsFired(r, quartiles) })
    if (argv.includes('--json')) { console.log(JSON.stringify({ quartiles, signals: res }, null, 2)); return }
    const labeledRows = rows.filter(r => labelOf(r) !== null)
    const withBrainStats = labeledRows.filter(r => r.brainStats != null).length
    console.log(`signals: ${withBrainStats} of ${labeledRows.length} labeled rows carry brainStats`)
    const fmt = v => (v === null || v === undefined ? '—' : v.toFixed(3))
    console.log(`quartiles — agree [q1 ${fmt(quartiles.agree[0])}, q3 ${fmt(quartiles.agree[1])}]  ` +
                `entropy [q1 ${fmt(quartiles.entropy[0])}, q3 ${fmt(quartiles.entropy[1])}]`)
    console.log()
    printRuleTable(res)
    return
  }

  const rows = readLedger(dir)
  const res = analyse(rows)

  if (argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  console.log(`ledger: ${res.total} missions, ${res.labeled} labeled ` +
              `(${res.failures} failures, base rate ${(res.base * 100).toFixed(1)}%)`)
  console.log(`unlabeled ${res.total - res.labeled} — verified or mutationSweep unmeasured; excluded, not defaulted`)
  console.log()
  printRuleTable(res)
}

// pathToFileURL, not string surgery: on Windows argv[1] is `C:\...` and the URL
// is `file:///C:/...` — a hand-built `file://` prefix is one slash short, the
// comparison silently fails and the script exits printing nothing.
// M5: `main` is async and `--denials` awaits real I/O inside it. An un-awaited
// call turns a thrown read error into an unhandled rejection — a stack trace on
// stderr and exit 0, which a caller reads as a clean run that printed nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1) })
