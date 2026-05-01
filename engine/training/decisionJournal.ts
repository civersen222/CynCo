/**
 * DecisionJournalWriter — append-only, fsync'd JSONL writer for per-system
 * VSM training data. Writes to ~/.cynco/training/s{1-5}-decisions.jsonl.
 *
 * Each entry is an (input, decision, outcome) triple that can be replayed
 * as fine-tuning data for the S5 Decision Model.
 */

import { appendFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { JournalEntry, BackfillRecord, SystemLevel } from './types.js'
import { makeBackfillRecord } from './types.js'

// ─── File mapping ────────────────────────────────────────────────

const SYSTEM_FILES: Record<SystemLevel, string> = {
  S1: 's1-decisions.jsonl',
  S2: 's2-decisions.jsonl',
  S3: 's3-decisions.jsonl',
  S4: 's4-decisions.jsonl',
  S5: 's5-decisions.jsonl',
}

// ─── Writer class ────────────────────────────────────────────────

export class DecisionJournalWriter {
  private readonly dir: string
  private readonly counts: Record<SystemLevel, number> = {
    S1: 0, S2: 0, S3: 0, S4: 0, S5: 0,
  }

  constructor(trainingDir?: string) {
    this.dir = trainingDir ?? join(homedir(), '.cynco', 'training')
    mkdirSync(this.dir, { recursive: true })
  }

  /** Append a JournalEntry as a JSON line to the correct system file. */
  log(entry: JournalEntry): void {
    this._write(entry.system, entry)
    this.counts[entry.system]++
  }

  /**
   * Append a BackfillRecord to a system file.
   * Used to patch in outcomes that were unknown at decision time.
   */
  backfill(system: SystemLevel, entryTimestamp: number, outcome: Record<string, unknown>): void {
    const record: BackfillRecord = makeBackfillRecord({ system, entryTimestamp, outcome })
    this._write(system, record)
    this.counts[system]++
  }

  /** In-memory count of entries logged (including backfills) for a given system. */
  entryCount(system: SystemLevel): number {
    return this.counts[system]
  }

  // ─── Private ───────────────────────────────────────────────────

  private _write(system: SystemLevel, record: JournalEntry | BackfillRecord): void {
    const filePath = join(this.dir, SYSTEM_FILES[system])
    const line = JSON.stringify(record) + '\n'
    try {
      const fd = openSync(filePath, 'a')
      appendFileSync(fd, line)
      fsyncSync(fd)
      closeSync(fd)
    } catch (e) {
      console.error(`[journal] Write failed (${system}): ${e}`)
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────

let _instance: DecisionJournalWriter | null = null

export function getJournal(): DecisionJournalWriter | null {
  return _instance
}

export function initJournal(trainingDir?: string): DecisionJournalWriter {
  _instance = new DecisionJournalWriter(trainingDir)
  return _instance
}
