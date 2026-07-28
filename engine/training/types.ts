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
  // Two join keys, both optional, at least one present. `entryTimestamp` is the
  // original and the only one S2 can supply. It is a weak key: makeJournalEntry
  // stamps its own Date.now(), so a caller holding a different clock reading
  // cannot address the line it wrote. `decisionId` is a UUID carried inside the
  // journaled decision and matches exactly.
  entryTimestamp?: number
  decisionId?: string
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
  entryTimestamp?: number
  decisionId?: string
  outcome: Record<string, unknown>
}

export function makeBackfillRecord(opts: MakeBackfillRecordOpts): BackfillRecord {
  const record: BackfillRecord = {
    _backfill: true,
    system: opts.system,
    outcome: opts.outcome,
  }
  // Omit rather than null the absent key, so a reader joining on `decisionId`
  // never has to distinguish "no id" from "id is null".
  if (opts.entryTimestamp !== undefined) record.entryTimestamp = opts.entryTimestamp
  if (opts.decisionId !== undefined) record.decisionId = opts.decisionId
  return record
}
