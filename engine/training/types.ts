/**
 * Training data types for decision journals.
 *
 * Captures (input, decision, outcome) triples per VSM level so governance
 * decisions can be replayed as fine-tuning data for the S5 Decision Model.
 */

// ─── System Levels ───────────────────────────────────────────────

export type SystemLevel = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

// ─── Journal Entry ───────────────────────────────────────────────

export interface JournalEntry {
  timestamp: number
  sessionId: string
  agentId?: string
  system: SystemLevel
  input: Record<string, unknown>
  decision: Record<string, unknown>
  outcome?: Record<string, unknown>
}

// ─── Backfill Record ─────────────────────────────────────────────

export interface BackfillRecord {
  _backfill: true
  system: SystemLevel
  entryTimestamp: number
  outcome: Record<string, unknown>
}

// ─── Factory Functions ───────────────────────────────────────────

export type MakeJournalEntryOpts = {
  sessionId: string
  system: SystemLevel
  input: Record<string, unknown>
  decision: Record<string, unknown>
  agentId?: string
  outcome?: Record<string, unknown>
}

export function makeJournalEntry(opts: MakeJournalEntryOpts): JournalEntry {
  const entry: JournalEntry = {
    timestamp: Date.now(),
    sessionId: opts.sessionId,
    system: opts.system,
    input: opts.input,
    decision: opts.decision,
  }
  if (opts.agentId !== undefined) {
    entry.agentId = opts.agentId
  }
  if (opts.outcome !== undefined) {
    entry.outcome = opts.outcome
  }
  return entry
}

export type MakeBackfillRecordOpts = {
  system: SystemLevel
  entryTimestamp: number
  outcome: Record<string, unknown>
}

export function makeBackfillRecord(opts: MakeBackfillRecordOpts): BackfillRecord {
  return {
    _backfill: true,
    system: opts.system,
    entryTimestamp: opts.entryTimestamp,
    outcome: opts.outcome,
  }
}
