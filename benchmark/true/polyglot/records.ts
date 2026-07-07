// benchmark/true/polyglot/records.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExerciseRecord } from './types.js'

/** Durable per-exercise result: appended immediately, never rewritten. */
export function appendRecord(path: string, record: ExerciseRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n')
}

function key(r: ExerciseRecord): string {
  return `${r.language}/${r.exercise}`
}

export function loadRecords(path: string): ExerciseRecord[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim())
  const out: ExerciseRecord[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch {
      if (i === lines.length - 1) {
        console.warn(`[polyglot] dropping torn final JSONL line (crash mid-append?): ${lines[i].slice(0, 80)}`)
        break
      }
      throw new Error(`corrupt results file ${path} at line ${i + 1} — refusing to resume`)
    }
  }
  // Dedup by language/exercise keeping first occurrence (honest result; duplicate = bug or file concat).
  const seen = new Set<string>()
  return out.filter((r) => {
    const k = key(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function completedKeys(records: ExerciseRecord[]): Set<string> {
  return new Set(records.map(key))
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
