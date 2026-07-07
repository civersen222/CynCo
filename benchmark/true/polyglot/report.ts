// benchmark/true/polyglot/report.ts
import type { ExerciseRecord } from './types.js'

export const TOTAL_EXERCISES = 225

export interface Summary {
  total: number
  passed: number // pass@2 (headline)
  passedTry1: number // pass@1
  envFailures: number
  timeouts: number
  byLanguage: Record<string, { total: number; passed: number }>
}

export function summarize(records: ExerciseRecord[]): Summary {
  const s: Summary = { total: 0, passed: 0, passedTry1: 0, envFailures: 0, timeouts: 0, byLanguage: {} }
  for (const r of records) {
    s.total++
    if (r.passed) s.passed++
    if (r.passedTry === 1) s.passedTry1++
    if (r.envFailure) s.envFailures++
    if (r.error?.includes('timeout')) s.timeouts++
    const lang = (s.byLanguage[r.language] ??= { total: 0, passed: 0 })
    lang.total++
    if (r.passed) lang.passed++
  }
  return s
}

// Aider leaderboard reference points (polyglot, pass@2).
const LEADERBOARD: Array<[string, number]> = [
  ['gemma-3-27b-it (aider)', 4.9],
  ['Qwen3-32B (aider)', 45.8],
  ['GPT-4o (aider)', 73.7],
]

const pct = (n: number, d: number) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1))

export function formatReport(s: Summary, model: string): string {
  const lines: string[] = []
  lines.push(`Polyglot progress — model: ${model}`)
  lines.push(`  recorded: ${s.total}/${TOTAL_EXERCISES}`)
  lines.push(`  pass@2: ${s.passed}/${s.total} (${pct(s.passed, s.total)}%)   pass@1: ${s.passedTry1}/${s.total} (${pct(s.passedTry1, s.total)}%)`)
  lines.push(`  env failures: ${s.envFailures}   timeouts: ${s.timeouts}`)
  for (const [lang, v] of Object.entries(s.byLanguage).sort()) {
    lines.push(`  ${lang.padEnd(12)} ${v.passed}/${v.total} (${pct(v.passed, v.total)}%)`)
  }
  if (s.total >= TOTAL_EXERCISES) {
    lines.push('')
    lines.push('Leaderboard comparison (pass@2):')
    for (const [name, score] of LEADERBOARD) lines.push(`  ${name.padEnd(28)} ${score}%`)
    lines.push(`  ${`${model} (CynCo)`.padEnd(28)} ${pct(s.passed, s.total)}%`)
  }
  return lines.join('\n')
}
