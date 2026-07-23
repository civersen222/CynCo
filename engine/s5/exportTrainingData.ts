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

/** Keep only decisions from viable sessions; output is the real logged decision. */
export function joinViableExamples(
  entries: JournalEntry[],
  outcomeBySession: Map<string, string>,
): TrainingExample[] {
  const out: TrainingExample[] = []
  for (const e of entries) {
    if (outcomeBySession.get(e.sessionId) !== 'viable') continue
    if (!e.input || !e.decision) continue
    out.push({ input: formatJournalInput(e.input), output: JSON.stringify(e.decision) })
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
    if (rec && rec._backfill) continue
    if (rec && rec.sessionId && rec.input && rec.decision) entries.push(rec as JournalEntry)
  }
  if (skipped > 0) console.warn(`[export] skipped ${skipped} malformed journal line(s)`)

  const examples = joinViableExamples(entries, opts.outcomeBySession)
  if (examples.length === 0) return { written: 0 }
  writeFileSync(opts.outPath, examples.map(e => JSON.stringify(e)).join('\n') + '\n')
  return { written: examples.length }
}

// ─── CLI ────────────────────────────────────────────────────────────
if (import.meta.main) {
  const os = require('os')
  const path = require('path')
  const journalPath = process.argv[2] ?? path.join(os.homedir(), '.cynco', 'training', 's5-decisions.jsonl')
  const dbPath = process.argv[3] ?? path.join(os.homedir(), '.cynco', 'governance', 'governance.db')
  const outPath = process.argv[4] ?? path.join(os.homedir(), '.cynco', 'training', 's5_training_data.jsonl')
  const outcomeBySession = loadOutcomesFromDb(dbPath)
  const { written } = exportViableExamples({ journalPath, outPath, outcomeBySession })
  console.log(`[export] wrote ${written} viable-session example(s) to ${outPath}`)
}
