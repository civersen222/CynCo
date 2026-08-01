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

/** Keep only decisions from viable sessions; output is the real logged decision. */
export function joinViableExamples(
  entries: JournalEntry[],
  outcomeBySession: Map<string, string>,
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

/** Read journal, join to outcomes, write viable-only JSONL. Empty → no file written. */
export function exportViableExamples(opts: {
  journalPath: string
  outPath: string
  outcomeBySession: Map<string, string>
}): { written: number } {
  const { readFileSync, writeFileSync, existsSync } = require('fs')
  if (!existsSync(opts.journalPath)) return { written: 0 }

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

  const examples = joinViableExamples(entries, opts.outcomeBySession)
  if (examples.length === 0) return { written: 0 }
  writeFileSync(opts.outPath, examples.map(e => JSON.stringify(e)).join('\n') + '\n')
  return { written: examples.length }
}

// ─── CLI ────────────────────────────────────────────────────────────
if (import.meta.main) {
  const os = require('os')
  const path = require('path')
  const journalPath = process.argv[2] ?? path.join(cyncoHome(), 'training', 's5-decisions.jsonl')
  const dbPath = process.argv[3] ?? path.join(cyncoHome(), 'governance', 'governance.db')
  const outPath = process.argv[4] ?? path.join(cyncoHome(), 'training', 's5_training_data.jsonl')
  const outcomeBySession = loadOutcomesFromDb(dbPath)
  const { written } = exportViableExamples({ journalPath, outPath, outcomeBySession })
  console.log(`[export] wrote ${written} viable-session example(s) to ${outPath}`)
}
