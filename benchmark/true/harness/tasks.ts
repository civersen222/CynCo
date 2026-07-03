import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
  // Resolve to absolute so paths survive being handed to `git -C <workdir>`,
  // which resolves relative paths against the workdir, not our cwd.
  const tasksRoot = resolve(tasksDir)
  const out: TaskDef[] = []
  for (const entry of readdirSync(tasksRoot).sort()) {
    const dir = join(tasksRoot, entry)
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
