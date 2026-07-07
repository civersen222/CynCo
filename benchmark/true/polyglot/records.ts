// benchmark/true/polyglot/records.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExerciseRecord } from './types.js'

/** Durable per-exercise result: appended immediately, never rewritten. */
export function appendRecord(path: string, record: ExerciseRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n')
}

export function loadRecords(path: string): ExerciseRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

export function completedKeys(records: ExerciseRecord[]): Set<string> {
  return new Set(records.map((r) => `${r.language}/${r.exercise}`))
}

/**
 * Conservative per-exercise ceiling: 2 tries x 8 min model + 2 x 5 min tests.
 * The chunk scheduler refuses to start an exercise that could overrun the
 * budget, so a chunk may end early but never runs long.
 */
export const WORST_CASE_MS = 2 * 8 * 60_000 + 2 * 5 * 60_000 // 26 min

export function fitsInBudget(elapsedMs: number, budgetMs: number, worstCaseMs = WORST_CASE_MS): boolean {
  return elapsedMs + worstCaseMs <= budgetMs
}
