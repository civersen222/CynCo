/**
 * engine/power/siblingEngine.ts — one GPU, two engines: the desk engine takes
 * over from the phone engine and gives it back.
 *
 * The headless phone engine (logon task "CynCo headless engine", lazy) owns
 * 9160/9161 and, when warm, the llama port. A desk engine started from a
 * terminal or the TUI is eager: its `ensureRunning()` would kill the phone
 * engine's warm server as "stale" and the phone engine would then burn its
 * restart budget rebinding (F182 shape; wakefulness review #8). The owner's
 * decision (2026-11-08): when a desk engine starts, the phone engine is
 * stopped first and restarted when the desk engine exits — "if I'm at the
 * machine I won't be using it on my phone." `scripts/cynco-services.ps1` is
 * the one owner of start/stop, so this module only drives it.
 */
import { execFile } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export type SiblingDecision = 'none' | 'handoff'

/** Only an eager, interactive engine on Windows hands off; the phone engine and one-shots never do. */
export function siblingDecision(env: { lazy: boolean; runTask: boolean; platform: string }): SiblingDecision {
  if (env.platform !== 'win32') return 'none'
  if (env.lazy || env.runTask) return 'none'
  return 'handoff'
}

export type ServicesRunner = (action: 'status' | 'stop' | 'start') => Promise<string>

export function defaultServicesRunner(scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'cynco-services.ps1')): ServicesRunner {
  return (action) => new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, action, 'engine'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

export type TakeOver = { wasRunning: boolean; release: () => Promise<void> }

/**
 * Stop the phone engine if it is running; `release()` starts it again (once).
 * Never throws: a failure to read or stop it is logged and the desk engine
 * proceeds — the worst case is then exactly today's behaviour.
 */
export async function takeOverFromHeadless(deps: { services: ServicesRunner; log: (line: string) => void }): Promise<TakeOver> {
  let wasRunning = false
  try {
    const status = await deps.services('status')
    wasRunning = /^engine\s+RUNNING/m.test(status)
    if (wasRunning) {
      await deps.services('stop')
      deps.log('[power] phone engine stopped for this desk session; it restarts when this engine exits')
    }
  } catch (e) {
    deps.log(`[power] could not check/stop the phone engine (${e instanceof Error ? e.message : String(e)}); continuing`)
    wasRunning = false
  }
  let released = false
  return {
    wasRunning,
    release: async () => {
      if (released || !wasRunning) return
      released = true
      try {
        await deps.services('start')
        deps.log('[power] phone engine restarted')
      } catch (e) {
        deps.log(`[power] phone engine not restarted (${e instanceof Error ? e.message : String(e)}); run cynco-services.ps1 start engine`)
      }
    },
  }
}
