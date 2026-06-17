import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskDef } from './types.js'

interface RawTask {
  id: string
  prompt: string
  start_ref: string
  hidden_test: string
  setup_patch?: string
  timeout_ms: number
  source: 'mined' | 'authored'
}

/** Load every `<dir>/<id>/task.json` into a TaskDef with absolute paths resolved. */
export function loadCivkingsTasks(tasksDir: string): TaskDef[] {
  if (!existsSync(tasksDir)) return []
  const out: TaskDef[] = []
  for (const entry of readdirSync(tasksDir).sort()) {
    const dir = join(tasksDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const jsonPath = join(dir, 'task.json')
    if (!existsSync(jsonPath)) continue
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as RawTask
    out.push({
      id: raw.id,
      prompt: raw.prompt,
      startRef: raw.start_ref,
      hiddenTestPath: join(dir, raw.hidden_test),
      hiddenTestName: raw.hidden_test,
      setupPatch: raw.setup_patch ? join(dir, raw.setup_patch) : undefined,
      timeoutMs: raw.timeout_ms,
      source: raw.source,
    })
  }
  return out
}
