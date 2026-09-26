/**
 * Outcome-joined, reward-filtered S5 training exporter.
 *
 * Reads the S5 decision journal (~/.cynco/training/s5-decisions.jsonl), joins
 * each entry to its session outcome by sessionId (from governance.db), and
 * emits {input, output} JSONL for ONLY the decisions made in `viable` sessions
 * (rejection sampling on outcome). The output is the REAL logged S5 decision —
 * not a rule-derived one — so the model learns from good trajectories rather
 * than distilling the rule engine. Consumed by scripts/fine_tune_s5.py.
 */

import type { JournalEntry } from '../training/types.js'
import { cyncoHome } from '../paths.js'
import { RuleAuthority, ruleVerdictsPath } from './ruleAuthority.js'

export type TrainingExample = { input: string; output: string }

/** Render a journaled S5Input object into the model's readable "input view". */
export function formatJournalInput(input: Record<string, unknown>): string {
  const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)
  const toolResults = Array.isArray(input.recentToolResults)
    ? (input.recentToolResults as { tool?: string; success?: boolean }[])
        .map(t => `${t.tool ?? '?'}:${t.success ? 'ok' : 'fail'}`)
        .join(', ')
    : ''
  const lines = [
    `User: ${String(input.userMessage ?? '')}`,
    `Workflow: ${input.activeWorkflow ?? 'none'}`,
    `Phase: ${input.currentPhase ?? 'none'}`,
    `Context: ${Math.round(num(input.contextUsagePercent) * 100)}%`,
    `Turn: ${num(input.turnCount)}`,
    `Governance: ${String(input.governanceStatus ?? 'unknown')}`,
    `Variety: ${String(input.varietyBalance ?? 'balanced')}`,
    `Difficulty: ${String(input.promptDifficulty ?? 'unknown')}`,
    `Recent tools: ${toolResults || 'none'}`,
  ]
  return lines.join('\n')
}

// Bookkeeping that belongs in the journal but must never reach the training
// target: `decisionId` is a UUID (the model would learn to hallucinate one),
// while `ruleIds` and `rejected` describe how the rule engine reached the
// decision. Including them would train imitation of the rule engine's internals,
// which is the opposite of learning from the decision itself.
const NON_TARGET_FIELDS = ['decisionId', 'ruleIds', 'rejected']

/** What the earned-only filter dropped (Phase 4). `byRule` counts, per rule,
 *  the decisions it disqualified (a decision with two unearned rules counts
 *  once under each); `'(none)'` counts decisions no rule produced. */
export type ExcludedCounts = { byRule: Record<string, number>; bySeat: Record<string, number>; legacy: boolean }

/** Key under which a decision with no rule behind it is counted — nothing earned it. */
export const NO_RULE = '(none)'

/**
 * Keep only decisions from viable sessions; output is the real logged decision.
 *
 * Phase 4: with an `earned`-mode `authority`, a decision is kept only when
 * every rule behind it is PREDICTIVE in the campaign's verdict file — the same
 * test the loop applies before enforcing it. Imitating a rule that predicts
 * nothing would launder noise into weights. Without one (or in legacy mode)
 * nothing is filtered, exactly as before.
 */
export function joinViableExamples(
  entries: JournalEntry[],
  outcomeBySession: Map<string, string>,
  authority: RuleAuthority = RuleAuthority.legacy(),
  excluded: ExcludedCounts = { byRule: {}, bySeat: {}, legacy: authority.mode === 'legacy' },
): TrainingExample[] {
  const out: TrainingExample[] = []
  for (const e of entries) {
    if (outcomeBySession.get(e.sessionId) !== 'viable') continue
    if (!e.input || !e.decision) continue
    // Per-decision veto. The session label is coarse — it stamps one verdict on
    // every decision the session made — so a decision measured to have made
    // things worse is dropped even from a viable session. An `unknown` outcome
    // is not a veto: it means nothing was measured, and the session label
    // remains the only evidence there is.
    if (e.outcome?.outcome === 'negative') continue
    if (authority.mode === 'earned') {
      const raw = (e.decision as Record<string, unknown>).ruleIds
      const ruleIds = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
      if (authority.authorityOf(ruleIds) !== 'earned') {
        const unearned = ruleIds.filter(id => authority.verdictOf(id) !== 'PREDICTIVE')
        for (const id of unearned.length ? unearned : [NO_RULE]) excluded.byRule[id] = (excluded.byRule[id] ?? 0) + 1
        continue
      }
    }
    const target: Record<string, unknown> = { ...e.decision }
    for (const f of NON_TARGET_FIELDS) delete target[f]
    out.push({ input: formatJournalInput(e.input), output: JSON.stringify(target) })
  }
  return out
}

/** Build sessionId → outcome map from governance.db (bun:sqlite; kept off the test path). */
export function loadOutcomesFromDb(dbPath: string): Map<string, string> {
  const { GovernanceDB } = require('../vsm/governanceDb.js')
  const db = new GovernanceDB(dbPath)
  const map = new Map<string, string>()
  for (const s of db.getRecentSessions(1_000_000)) map.set(s.sessionId, s.outcome)
  db.close()
  return map
}

/** The two seats whose retained authority the export reports. */
export type SeatAuthorities = { ideation: number; 'gate-author': number }

/**
 * Each seat's retained authority from `~/.cynco/retained/seats.json` (the store
 * `scripts/cynco-proposals.mjs` writes); 0 for a seat the store does not hold,
 * and 0 for both when the file is absent or unreadable (warned).
 */
export function readSeatAuthorities(seatsPath: string | undefined): SeatAuthorities {
  const out: SeatAuthorities = { ideation: 0, 'gate-author': 0 }
  if (!seatsPath) return out
  const { readFileSync, existsSync } = require('fs')
  if (!existsSync(seatsPath)) return out
  let raw: any
  try {
    raw = JSON.parse(readFileSync(seatsPath, 'utf-8'))
  } catch (e) {
    console.warn(`[export] ${seatsPath} is not readable JSON — reporting every seat at 0: ${e instanceof Error ? e.message : String(e)}`)
    return out
  }
  for (const seat of ['ideation', 'gate-author'] as const) {
    const v = raw?.seats?.[seat]?.authority
    if (typeof v === 'number' && Number.isFinite(v)) out[seat] = v
  }
  return out
}

export type ExportSummary = { written: number; excluded: ExcludedCounts; seats: SeatAuthorities }

/**
 * Read journal, join to outcomes, write viable-only JSONL. Empty → no file written.
 *
 * Phase 4: `verdictsPath` (the campaign runner's rule-verdict file) makes the
 * export earned-only — see `joinViableExamples`. Absent file or no path →
 * legacy pass-through, reported as `excluded.legacy: true`.
 *
 * Seats: the summary reports the ideation and gate-author seats' retained
 * authority from `seatsPath`. The S5 decision journal carries no seat rows
 * today — ideation and gate-authoring are campaign-runner seats and are not
 * journaled here — so nothing can be excluded by seat and `excluded.bySeat`
 * is always `{}`. When seat decisions are journaled, the filter belongs beside
 * the rule filter above, keyed on the seat's authority being 0.
 */
export function exportViableExamples(opts: {
  journalPath: string
  outPath: string
  outcomeBySession: Map<string, string>
  verdictsPath?: string
  seatsPath?: string
}): ExportSummary {
  const { readFileSync, writeFileSync, existsSync } = require('fs')
  const authority = opts.verdictsPath ? RuleAuthority.load(opts.verdictsPath) : RuleAuthority.legacy()
  const excluded: ExcludedCounts = { byRule: {}, bySeat: {}, legacy: authority.mode === 'legacy' }
  const seats = readSeatAuthorities(opts.seatsPath)
  if (!existsSync(opts.journalPath)) return { written: 0, excluded, seats }

  const raw = readFileSync(opts.journalPath, 'utf-8')
  const entries: JournalEntry[] = []
  // Backfills are appended after the entry they describe, so they cannot be
  // merged in one pass. Collected here and folded on afterwards. Keyed on
  // decisionId only: the timestamp key cannot address an S5 line (the writer and
  // makeJournalEntry read the clock independently), so a timestamp-keyed
  // backfill is left where it is rather than joined to an arbitrary neighbour.
  const outcomeByDecision = new Map<string, Record<string, unknown>>()
  let skipped = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec: any
    try {
      rec = JSON.parse(t)
    } catch {
      skipped++
      continue
    }
    if (rec && rec._backfill) {
      if (rec.decisionId && rec.outcome) outcomeByDecision.set(rec.decisionId, rec.outcome)
      continue
    }
    if (rec && rec.sessionId && rec.input && rec.decision) entries.push(rec as JournalEntry)
  }
  if (skipped > 0) console.warn(`[export] skipped ${skipped} malformed journal line(s)`)

  for (const e of entries) {
    const id = (e.decision as Record<string, unknown> | undefined)?.decisionId
    if (typeof id !== 'string') continue
    const backfilled = outcomeByDecision.get(id)
    // Later wins over the entry's own outcome: the backfill is the measurement
    // taken after the decision, which is the whole reason it exists.
    if (backfilled) e.outcome = { ...e.outcome, ...backfilled }
  }

  const examples = joinViableExamples(entries, opts.outcomeBySession, authority, excluded)
  if (examples.length === 0) return { written: 0, excluded, seats }
  writeFileSync(opts.outPath, examples.map(e => JSON.stringify(e)).join('\n') + '\n')
  return { written: examples.length, excluded, seats }
}

/** The CLI's summary table, as lines. */
export function exportSummaryLines(r: ExportSummary, outPath: string): string[] {
  const lines = [`[export] wrote ${r.written} example(s) to ${outPath}`]
  lines.push(r.excluded.legacy
    ? '[export] rule filter: legacy — no rule-verdict file, nothing excluded by rule'
    : '[export] rule filter: earned-only — kept decisions whose every rule is PREDICTIVE')
  const byRule = Object.entries(r.excluded.byRule).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (byRule.length) {
    lines.push('  excluded by rule   decisions')
    for (const [id, n] of byRule) lines.push(`  ${id.padEnd(17)} ${String(n).padStart(9)}`)
  }
  lines.push(`  excluded by seat: ${Object.keys(r.excluded.bySeat).length ? JSON.stringify(r.excluded.bySeat) : 'none (the S5 journal carries no seat rows)'}`)
  lines.push(`  seats: ideation ${r.seats.ideation}, gate-author ${r.seats['gate-author']}`)
  return lines
}

// ─── CLI ────────────────────────────────────────────────────────────
if (import.meta.main) {
  const os = require('os')
  const path = require('path')
  const journalPath = process.argv[2] ?? path.join(cyncoHome(), 'training', 's5-decisions.jsonl')
  const dbPath = process.argv[3] ?? path.join(cyncoHome(), 'governance', 'governance.db')
  const outPath = process.argv[4] ?? path.join(cyncoHome(), 'training', 's5_training_data.jsonl')
  const verdictsPath = process.argv[5] ?? ruleVerdictsPath(cyncoHome())
  const seatsPath = process.argv[6] ?? path.join(cyncoHome(), 'retained', 'seats.json')
  const outcomeBySession = loadOutcomesFromDb(dbPath)
  const result = exportViableExamples({ journalPath, outPath, outcomeBySession, verdictsPath, seatsPath })
  for (const line of exportSummaryLines(result, outPath)) console.log(line)
  console.log(`[export] excluded: ${JSON.stringify(result.excluded)}`)
}
