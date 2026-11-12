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
import { execFile, execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export type SiblingDecision = 'none' | 'handoff'

/** The bridge port the phone engine listens on (`LOCALCODE_WS_PORT` unset). */
export const PHONE_ENGINE_PORT = 9160

/**
 * Is this engine taking the phone engine's place: the same bridge port and the same home? That is the
 * owner's desk engine. An engine on another port or in another home (a smoke run, a test) is a second
 * engine beside it and has no business stopping it.
 */
export function inPhoneEnginesSeat(env: { wsPort: string | undefined; cyncoHome: string; defaultHome: string }): boolean {
  const port = parseInt(env.wsPort ?? String(PHONE_ENGINE_PORT), 10)
  const same = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return port === PHONE_ENGINE_PORT && same(env.cyncoHome, env.defaultHome)
}

/**
 * Only an eager, interactive engine on Windows that takes the phone engine's seat hands off; the phone
 * engine, one-shots, and any engine on another port or in another home never do. A smoke engine on
 * 19161 with a scratch home stopped the live phone engine for nine and a half minutes on 2026-11-12,
 * because nothing asked whose place it was taking (F224).
 */
export function siblingDecision(env: { lazy: boolean; runTask: boolean; platform: string; inPhoneSeat: boolean }): SiblingDecision {
  if (env.platform !== 'win32') return 'none'
  if (env.lazy || env.runTask) return 'none'
  if (!env.inPhoneSeat) return 'none'
  return 'handoff'
}

export type ServicesRunner = (action: 'status' | 'stop' | 'start') => Promise<string>

const DEFAULT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'cynco-services.ps1')

/**
 * The services script matches the engine by command line (`bun engine\main.ts`),
 * which this desk engine also is: without `-ExcludePid <our pid>` a `status`
 * could report the desk engine as the running phone engine and `stop` could
 * kill the caller (PR #190 review). Pure; pinned by siblingEngine.test.ts.
 */
export function servicesArgs(scriptPath: string, action: 'status' | 'stop' | 'start', excludePid: number): string[] {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, action, 'engine', '-ExcludePid', String(excludePid)]
}

export function defaultServicesRunner(scriptPath = DEFAULT_SCRIPT, excludePid = process.pid): ServicesRunner {
  return (action) => new Promise((resolve, reject) => {
    execFile('powershell', servicesArgs(scriptPath, action, excludePid), { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

export type ServicesRunnerSync = (action: 'status' | 'stop' | 'start') => string

/** Blocking twin for `process.on('exit')`, where nothing asynchronous runs any more. */
export function defaultServicesRunnerSync(scriptPath = DEFAULT_SCRIPT, excludePid = process.pid): ServicesRunnerSync {
  return (action) => String(execFileSync('powershell', servicesArgs(scriptPath, action, excludePid), { timeout: 20_000, windowsHide: true }))
}

export type TakeOver = { wasRunning: boolean; release: () => Promise<void>; releaseSync: () => void }

/**
 * Stop the phone engine if it is running; `release()` starts it again (once).
 * `releaseSync()` is the same promise for `process.on('exit')`: a desk engine
 * that crashes or whose shutdown throws still gives the GPU back (a hard kill
 * from Task Manager runs neither; `cynco-services.ps1 start engine` then).
 * Never throws: a failure to read or stop it is logged and the desk engine
 * proceeds — the worst case is then exactly today's behaviour.
 */
export async function takeOverFromHeadless(deps: { services: ServicesRunner; servicesSync?: ServicesRunnerSync; log: (line: string) => void }): Promise<TakeOver> {
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
    releaseSync: () => {
      if (released || !wasRunning) return
      released = true
      if (!deps.servicesSync) { deps.log('[power] phone engine not restarted (no sync runner); run cynco-services.ps1 start engine'); return }
      try {
        deps.servicesSync('start')
        deps.log('[power] phone engine restarted (exit hook)')
      } catch (e) {
        deps.log(`[power] phone engine not restarted (${e instanceof Error ? e.message : String(e)}); run cynco-services.ps1 start engine`)
      }
    },
  }
}
