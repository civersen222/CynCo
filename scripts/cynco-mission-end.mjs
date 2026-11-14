// scripts/cynco-mission-end.mjs
// What a mission leaves behind on the dashboard's ports when its driver is gone (F236).
//
// scripts/dispatch-mission.sh waits for its driver to exit and then calls this.
// The rule: exactly one engine serves the dashboard afterwards, and on a PC
// with the phone engine it is the phone engine.
//
// 2026-11-14: the t5 wave stalled (F235), a person killed the driver and the
// mission engine by hand, and the launcher's end step booted a bare idle engine
// on 9160/9161, as it did whenever the phone engine had not been running at
// launch (it had been stopped by hand, the workaround before F234). Two seconds
// later the person started the phone engine, which walked to 9162/9163, and the
// phone talked to the bare stand-in, which has none of the phone engine's
// environment (lazy llama with idle unload, the busy fallback, ntfy).
//
// So, in order:
//   1. The mission engine is the launcher's. When it outlives its driver (the
//      driver was killed, or its teardown failed) by more than a grace period,
//      its tree is killed: a mission engine left alive keeps the dashboard with
//      a mission's environment (approve-all) and nobody watching it.
//   2. A caller that owns the dashboard (CYNCO_SKIP_IDLE_ENGINE, the campaign
//      runner between waves) is left to it.
//   3. Anything already answering on the dashboard port is left alone.
//   4. When the phone engine's scheduled task exists and is enabled, it is
//      started, whether or not it ran before the mission. The bare idle engine
//      is the answer only on a PC with no phone engine.
//
//   bun scripts/cynco-mission-end.mjs --engine-pid <windows pid> [--skip-idle]
//
// Prints its reasoning as `[mission-end] …` lines and, last, `ACTION phone`,
// `ACTION idle` or `ACTION none`; dispatch-mission.sh acts on that word.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PHONE_ENGINE_TASK = 'CynCo headless engine'
export const DASHBOARD_URL = 'http://127.0.0.1:9161/'
/** How long the mission engine may outlive its driver: the driver's own teardown (`/quit`) takes seconds. */
export const ENGINE_GRACE_MS = 60_000
/** Task Scheduler states in which the task can be started (`Disabled` is the owner's no). */
export const STARTABLE_TASK_STATES = new Set(['Ready', 'Running', 'Queued'])

/**
 * The decision, with every fact asked through `deps` so it can be argued with in a test:
 * `engineAlive()`, `killEngine()`, `dashboardAnswers()`, `phoneTaskState()` ('' when not
 * registered), `sleep(ms)`, `log(line)`. Returns `{ action, reaped, why }`.
 */
export async function missionEnd({ skipIdle = false, graceMs = ENGINE_GRACE_MS, pollMs = 5_000 } = {}, deps) {
  let reaped = false
  if (deps.engineAlive()) {
    let waited = 0
    while (deps.engineAlive() && waited < graceMs) { await deps.sleep(pollMs); waited += pollMs }
    if (deps.engineAlive()) {
      deps.log(`the mission engine outlived its driver by ${Math.round(waited / 1000)}s (the driver was killed, or its teardown failed) — stopping its tree so it does not keep the dashboard (F236)`)
      await deps.killEngine()
      reaped = true
      // Its ports close with it; give the OS a moment before asking who answers.
      await deps.sleep(2_000)
    }
  }
  if (skipIdle) return { action: 'none', reaped, why: 'the caller owns the dashboard engine (CYNCO_SKIP_IDLE_ENGINE)' }
  if (await deps.dashboardAnswers()) return { action: 'none', reaped, why: 'something already answers on the dashboard port (a desk engine, the phone engine, or the next dispatch)' }
  const state = String(deps.phoneTaskState() ?? '').trim()
  if (STARTABLE_TASK_STATES.has(state)) {
    return { action: 'phone', reaped, why: `the phone engine's task is ${state}: it serves the dashboard, not a bare stand-in (F236)` }
  }
  return { action: 'idle', reaped, why: state ? `the phone engine's task is ${state}, so a bare idle engine keeps the dashboard answering` : 'no phone engine task is registered, so a bare idle engine keeps the dashboard answering' }
}

const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }

function readTaskState(name = PHONE_ENGINE_TASK) {
  if (process.platform !== 'win32') return ''
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue).State`], { encoding: 'utf-8', windowsHide: true, timeout: 20_000 })
  if (r.error || r.status !== 0) { console.log(`[mission-end] could not read the task "${name}" (${r.error?.message ?? `exit ${r.status}`}); treating it as not registered`); return '' }
  return String(r.stdout ?? '').trim()
}

async function answers(url = DASHBOARD_URL) {
  try { await fetch(url, { signal: AbortSignal.timeout(3_000) }); return true } catch { return false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1] }
  const enginePid = Number(arg('--engine-pid'))
  const { killProcessTree } = await import('../engine/processTree.js')
  const log = (l) => console.log(`[mission-end] ${l}`)
  try {
    const r = await missionEnd({ skipIdle: process.argv.includes('--skip-idle') }, {
      engineAlive: () => pidAlive(enginePid),
      killEngine: () => killProcessTree(enginePid, log),
      dashboardAnswers: () => answers(),
      phoneTaskState: () => readTaskState(),
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      log,
    })
    log(r.why)
    console.log(`ACTION ${r.action}`)
  } catch (e) {
    // Never leave the dashboard dark on a fault here: the bare engine is the old behaviour.
    log(`failed (${e instanceof Error ? e.message : String(e)}); falling back to the bare idle engine`)
    console.log('ACTION idle')
  }
}
