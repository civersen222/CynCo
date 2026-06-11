// engine/daemon/taskFile.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { TaskFileInput, TaskOutcome } from './types.js'

const REQUIRED_INPUT_FIELDS: (keyof TaskFileInput)[] = [
  'missionId', 'triggerId', 'prompt', 'context', 'allowedTools', 'timeoutMs', 'outcomePath',
]

export function writeTaskFile(path: string, input: TaskFileInput): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(input, null, 2), 'utf-8')
}

export function readTaskFile(path: string): TaskFileInput {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (raw[field] === undefined) throw new Error(`Task file missing required field: ${field}`)
  }
  if (!Array.isArray(raw.allowedTools)) throw new Error('Task file invalid: allowedTools must be an array')
  return raw as TaskFileInput
}

export function writeOutcome(path: string, outcome: TaskOutcome): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(outcome, null, 2), 'utf-8')
}

export function readOutcome(path: string): TaskOutcome {
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err: any) {
    return { ok: false, summary: '', recommendations: [], error: `Outcome file missing or unreadable: ${path} (${err?.message ?? err})` }
  }
  return {
    ok: raw.ok === true,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    recommendations: Array.isArray(raw.recommendations) ? raw.recommendations : [],
    ...(raw.error ? { error: String(raw.error) } : {}),
  }
}
