/**
 * engine/power/awake.ts — keep Windows awake exactly while something is open.
 *
 * On the first activity (`ActivityRegistry.onBusy`) spawn `scripts/hold-awake.ps1`,
 * which calls SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) and lives
 * until killed; on the last activity ending (`onIdle`) kill it. The helper also
 * polls its parent pid and exits by itself, so a crashed engine or daemon never
 * leaves the PC unable to sleep (and it dies with the F131 job as well). Off
 * Windows this is a no-op. Nothing here ever puts the machine to sleep: the
 * Windows idle timer does that, and the doorman wakes it.
 * Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 3).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { ActivityRegistry } from './activity.js'

export type HoldAwakeDeps = {
  platform?: string
  spawn?: typeof nodeSpawn
  scriptPath?: string
  log?: (line: string) => void
}

export function defaultHoldAwakeScript(): string {
  // engine/power/awake.ts → <repo>/scripts/hold-awake.ps1
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hold-awake.ps1')
}

/** Returns an unwire function that also kills a live helper. */
export function wireHoldAwake(registry: ActivityRegistry, deps: HoldAwakeDeps = {}): () => void {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return () => {}
  const spawn = deps.spawn ?? nodeSpawn
  const scriptPath = deps.scriptPath ?? defaultHoldAwakeScript()
  const log = deps.log ?? (() => {})
  let helper: ChildProcess | null = null

  const start = () => {
    if (helper) return
    try {
      helper = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ParentPid', String(process.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      const spawned = helper
      // Identity matters: a late exit from a helper we already replaced must not
      // null out the live one, or the next stop() cannot kill it (review #4).
      spawned.on?.('exit', () => { if (helper === spawned) helper = null })
      log(`[power] holding the PC awake (helper pid ${helper?.pid ?? '?'})`)
    } catch (e) {
      helper = null
      log(`[power] hold-awake helper failed to start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const stop = () => {
    if (!helper) return
    try { helper.kill() } catch (e) { log(`[power] hold-awake helper kill failed: ${e instanceof Error ? e.message : String(e)}`) }
    helper = null
    log('[power] released the PC (nothing open)')
  }

  const offBusy = registry.onBusy(start)
  const offIdle = registry.onIdle(stop)
  if (registry.count() > 0) start()
  return () => { offBusy(); offIdle(); stop() }
}
