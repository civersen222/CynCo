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
//      a mission's environment (approve-all) and nobody watching it. The pid is
//      asked by its image (engineDeps): only while tasklist lists it as bun.exe
//      is it the engine, and only then is its tree killed (wave 13c); a bun.exe
//      only with the creation time the dispatch read when it confirmed the pid
//      (--engine-started, wave 13d).
//   2. A caller that owns the dashboard (CYNCO_SKIP_IDLE_ENGINE, the campaign
//      runner between waves) is left to it.
//   3. Anything already answering on the dashboard port is left alone.
//   4. When the phone engine's scheduled task exists and is enabled, it is
//      started, whether or not it ran before the mission. The bare idle engine
//      is the answer only on a PC with no phone engine.
//
//   bun scripts/cynco-mission-end.mjs --engine-pid <windows pid> --engine-started <ticks> [--skip-idle]
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
 * registered), `sleep(ms)`, `log(line)`, and `now()` (optional, Date.now). Returns `{ action, reaped, why }`.
 */
export async function missionEnd({ skipIdle = false, graceMs = ENGINE_GRACE_MS, pollMs = 5_000 } = {}, deps) {
  let reaped = false
  // Wave 13d (R4): the grace is wall time as well as the sum of the sleeps. Each ask of engineAlive runs tasklist
  // (and PowerShell for a bun.exe), up to 20 s each when they hang, so summing the sleeps alone stretched the 60 s
  // grace to about six minutes (16 asks) before ACTION was printed and the phone engine started.
  const now = deps.now ?? Date.now
  const t0 = now()
  if (deps.engineAlive()) {
    let waited = 0
    while (deps.engineAlive() && waited < graceMs && now() - t0 < graceMs) { await deps.sleep(pollMs); waited += pollMs }
    if (deps.engineAlive()) {
      const outlived = Math.max(waited, now() - t0)
      deps.log(`the mission engine outlived its driver by ${Math.round(outlived / 1000)}s (the driver was killed, or its teardown failed) — stopping its tree so it does not keep the dashboard (F236)`)
      // `false` is a kill that was not made (engineDeps: the pid is not the engine's bun.exe at that moment).
      reaped = (await deps.killEngine()) !== false
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

// Wave 13c (C4, C7): the engine's pid is asked by its image, never by a signal-0 probe. The dispatch hands
// --engine-pid the pid tasklist CONFIRMED as the engine's bun.exe; if that engine has ended and Windows gave its pid
// to another program within the watcher's 10 s and the grace, the old probe answered "alive" and killProcessTree
// then ended that program's tree. Read as scripts/dispatch-mission.sh's engine_listing reads it: tasklist by PID
// alone; a row naming the pid with image bun.exe is the engine; tasklist's own no-match line is gone; a row with
// another image is the pid reused (a process never changes its image); anything else is unknown.
const NO_SUCH_TASK = 'INFO: No tasks are running which match the specified criteria.'

/** `tasklist /FI "PID eq <pid>" /NH /FO CSV`, as `{ status, stdout, error }`. */
export function runTasklist(pid) {
  if (process.platform !== 'win32') return { status: null, stdout: '', error: new Error('tasklist runs on Windows only') }
  return spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf-8', windowsHide: true, timeout: 20_000 })
}

/**
 * What tasklist says of `pid`: `{ state: 'listed' }` (a bun.exe), `{ state: 'gone' }`, `{ state: 'other', image }`,
 * `{ state: 'unknown', why }`, or `{ state: 'none' }` for no usable pid (nothing is asked).
 */
export function engineListing(pid, tasklist = runTasklist) {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'none' }
  const r = tasklist(pid)
  if (r.error || r.status !== 0) return { state: 'unknown', why: `tasklist could not be run or failed (${r.error ? r.error.message : `exit ${r.status}`})` }
  const out = String(r.stdout ?? '').replace(/\r/g, '')
  const lines = out.split('\n')
  for (const line of lines) {
    const m = /^"([^"]*)","(\d+)",/.exec(line)
    if (m && Number(m[2]) === pid) return m[1] === 'bun.exe' ? { state: 'listed' } : { state: 'other', image: m[1] }
  }
  if (out === '') return { state: 'unknown', why: 'tasklist printed nothing' }
  if (lines.some(l => l === NO_SUCH_TASK)) return { state: 'gone' }
  return { state: 'unknown', why: 'tasklist printed what this does not read' }
}

/**
 * Wave 13d (R8): the creation time of a Windows process, in .NET ticks (UTC, 100 ns), as `{ ticks }` (a string: the
 * value is past what a Number holds exactly), or `{ error }`. Read as scripts/dispatch-mission.sh's process_started
 * reads it, through PowerShell's Get-Process.
 */
export function runStartTime(pid) {
  if (process.platform !== 'win32') return { error: new Error('the start time is read on Windows only') }
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf-8', windowsHide: true, timeout: 20_000 })
  if (r.error) return { error: r.error }
  if (r.status !== 0) return { error: new Error(`PowerShell exit ${r.status}`) }
  const ticks = String(r.stdout ?? '').trim()
  return /^\d+$/.test(ticks) ? { ticks } : { error: new Error('PowerShell printed what this does not read') }
}

/**
 * `engineAlive` and `killEngine` for missionEnd, by image. Alive: listed, or unknown (fail closed: it is waited for).
 * A pid held by another image is the engine gone, said once. The kill asks again first and is made only while the
 * pid is listed as bun.exe; otherwise it is not made, said why, and `false` is returned.
 *
 * Wave 13d (R8): `started` is the creation time the dispatch read when it confirmed the pid (--engine-started). A
 * bun.exe on the pid is the engine only with that creation time: with another it is the pid reused by another bun.exe
 * (gone, said once, never killed); one whose creation time cannot be read, or no valid `started`, is unknown (waited
 * for, never killed).
 */
export function engineDeps(pid, { tasklist = runTasklist, startTime = runStartTime, started, killTree, log }) {
  let reuseSaid = false
  const reuseLine = (image) => `pid ${pid} is now ${image}: the engine's bun.exe has ended and its pid was reused`
  const ask = () => {
    const l = engineListing(pid, tasklist)
    if (l.state !== 'listed') return l
    if (typeof started !== 'string' || !/^\d+$/.test(started)) return { state: 'unknown', why: `pid ${pid} is a bun.exe, but no creation time of the engine was given (--engine-started)` }
    const t = startTime(pid)
    if (!t || t.error || typeof t.ticks !== 'string') return { state: 'unknown', why: `pid ${pid} is a bun.exe, but its start time could not be read (${t?.error?.message ?? 'no answer'})` }
    if (t.ticks !== started) return { state: 'other', image: `another bun.exe (created ${t.ticks}; the engine was created ${started})` }
    return l
  }
  return {
    engineAlive: () => {
      const l = ask()
      if (l.state === 'other' && !reuseSaid) { reuseSaid = true; log(reuseLine(l.image)) }
      return l.state === 'listed' || l.state === 'unknown'
    },
    killEngine: async () => {
      const l = ask()
      if (l.state !== 'listed') {
        const why = l.state === 'other' ? `pid ${pid} is now ${l.image}, not the engine's bun.exe`
          : l.state === 'gone' ? `pid ${pid} is gone` : l.state === 'none' ? 'no engine pid was given' : l.why
        log(`the mission engine was not killed: ${why}`)
        return false
      }
      await killTree(pid, log)
      return true
    },
  }
}

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
      ...engineDeps(enginePid, { tasklist: runTasklist, startTime: runStartTime, started: arg('--engine-started'), killTree: killProcessTree, log }),
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
