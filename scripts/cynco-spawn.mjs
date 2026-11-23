// scripts/cynco-spawn.mjs — the one synchronous spawn every grader uses.
//
// F155. Under bun 1.3.13 on Windows, `spawnSync`'s timeout deadline is measured
// from the PREVIOUS `spawnSync` in the same process rather than from this call:
// the first spawn after a long idle gap is killed almost immediately with
// `error.code === 'ETIMEDOUT'` and empty output, and the spawns right after it
// run normally. The reviewer's reproduction, one process:
//
//   warmup   36 ms   normal
//   A         7 ms   ETIMEDOUT, empty stdout   (12 s gap before it)
//   B        —       normal
//   C        —       normal
//
// The live C9 authoring runner had last spawned four hours earlier
// (`archiveBase` / `commitStaging`), so its first gate run — the gate at BASE —
// came back empty and "timed out after 7200000 ms" after a few milliseconds.
// Everything downstream believed it: a null terminator, zero parsed lines, and
// six MUST-FAIL comparisons against an empty BASE failure set.
//
// Two rules follow, and they are the whole of this module:
//
//   1. A TIMEOUT IS AN ELAPSED MEASUREMENT. `timedOut` is true only when the
//      call actually spent the time — `error.code === 'ETIMEDOUT'` AND
//      `elapsedMs >= timeoutMs * 0.9`. The 0.9 is slack for the clock, not for
//      a three-order-of-magnitude discrepancy.
//   2. ANYTHING ELSE spawnSync reports is a HARNESS FAULT, named as one.
//      `fault = { code, status, signal, elapsedMs }` and `timedOut: false`, so a
//      caller cannot mistake "the harness did not run this" for "the thing I was
//      measuring failed".
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { basename, win32 } from 'node:path'
import {
  containedCommand, toolSpawnRefusal, establishContainment, releaseContainment, ownIntegrityLevel, launcherFaultOf,
  refusalPrefix, refusalText,
} from '../engine/containment.js'

/**
 * The fraction of the cap a run must have actually spent before an ETIMEDOUT is
 * believed. Exported so the tests pin the same number the code uses.
 */
export const TIMEOUT_ELAPSED_FRACTION = 0.9

/**
 * F160. The bash these spawns need is GIT BASH: `dispatch-mission.sh` and the
 * `git archive | tar` pipe are written for it, over Windows paths, with the
 * Windows python and bun. A bare `bash` on a Windows PATH resolves to
 * `C:\Windows\System32\bash.exe` — the WSL launcher — unless Git's `bin` dir
 * sits ahead of System32, which is true inside a Git Bash terminal and false
 * from PowerShell, cmd, `Start-Process` or Task Scheduler. The Phase 4 live
 * proof's first wave, launched from PowerShell, faulted in under a second:
 * `dispatch-mission.sh: line 12: set: pipefail: invalid option name`.
 *
 * Pure: given the platform and where `git.exe` is, name the bash to spawn.
 * Git for Windows puts `git.exe` at `<root>\cmd\git.exe` (its PATH entry) or
 * `<root>\mingw64\bin\git.exe`; its bash is `<root>\bin\bash.exe`. Anything
 * else — another platform, no git, no bash beside it — is the bare `bash`
 * the caller always used.
 */
export function bashBin({ platform = process.platform, gitPath = null, exists = existsSync } = {}) {
  if (platform !== 'win32') return 'bash'
  // Windows paths whatever the host: the tests pin the Windows layout from any OS.
  const p = win32
  const found = gitPath && (() => {
    const dir = p.dirname(gitPath)                 // <root>\cmd | <root>\mingw64\bin | <root>\bin
    const up = p.dirname(dir)                      // <root>     | <root>\mingw64     | <root>
    const roots = /^mingw(32|64)$/i.test(p.basename(up)) ? [p.dirname(up)] : [up]
    return roots.map(r => p.join(r, 'bin', 'bash.exe')).find(exists) ?? null
  })()
  if (found) return found
  // Refuse, don't fall back (F160): bare `bash` on a Windows PATH is the WSL
  // launcher, and a fault an hour into a wave is worse than a refusal now.
  throw new Error(`F160: no Git Bash found${gitPath ? ` beside ${gitPath}` : ' (no git.exe on PATH)'} — install Git for Windows or put its bin dir on PATH`)
}

/**
 * The first `git.exe` on PATH as `where.exe` reports it; null when none.
 * `$PATH:git.exe` restricts the search to PATH — a bare `where git.exe` looks
 * in the current directory first, which a mission's repo could plant.
 */
export function gitExeOnPath(spawn = spawnSync, systemRoot = process.env.SystemRoot) {
  // where.exe by full path too: a bare name is itself looked up cwd-first.
  const where = systemRoot ? win32.join(systemRoot, 'System32', 'where.exe') : 'where.exe'
  const r = spawn(where, ['$PATH:git.exe'], { encoding: 'utf8' })
  return String(r?.stdout ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || null
}

let cachedBash = null
/** The bash every spawn under `scripts/` uses, resolved once per process (F160); a refusal is not cached. */
export function bashExe() {
  if (cachedBash === null) cachedBash = bashBin({ gitPath: process.platform === 'win32' ? gitExeOnPath() : null })
  return cachedBash
}

/**
 * `spawnSync`, with an elapsed-time check over its timeout claim.
 *
 * Options: `cwd`, `env` (merged over process.env unless `envExact`, which
 * passes `env` as the whole environment), `timeoutMs`, `shell`,
 * `retryImpossibleTimeout` (see below), `onStaleRetry(line)` (the retry's log
 * line goes to it instead of stderr), `contained` (a run context, or
 * `{ own, extraRoots?, labelOwn? }`: see `containedPlan`; F242).
 *
 * Returns `{ status, stdout, stderr, elapsedMs, timedOut, fault }`.
 * `timedOut` and `fault` are mutually exclusive, and both are absent-or-false
 * on a clean run, so `if (r.fault)` and `if (r.timedOut)` are both safe reads.
 *
 * `now` is injectable so a test can drive the elapsed measurement without
 * spending the time; `spawn` likewise, so a test can produce the early
 * ETIMEDOUT this module exists for without needing bun's bug to be present.
 */
export function runSync(cmd, args, opts = {}, hooks = {}) {
  const first = attempt(cmd, args, opts, hooks)
  // Opt-IN, per call. Running a command twice is only safe when running it twice
  // is the same as running it once: a gate, a cheat stub, a positive shim and a
  // `--check` are all reads of a tree and may be repeated freely. A `git commit`,
  // a `git apply` or a `git archive` may not, and the default must be the
  // conservative one — a harness that silently double-applies a patch to recover
  // from a timeout it invented would be a worse bug than the one being fixed.
  if (!opts.retryImpossibleTimeout) return first
  // The stale deadline is not a condition of the machine, it is a condition of
  // the PREVIOUS call: in the reproduction the spawns right behind the killed one
  // run normally. So an ETIMEDOUT that provably did not spend its cap is retried
  // exactly once, immediately, and the retry is the reading. Retrying is safe
  // here and only here — a REAL timeout never reaches this branch, because it is
  // separated by elapsed time, and every other spawn error is reported unretried.
  //
  // Without this the fix only moved the victim. Live C9 attempt 5 refused
  // correctly instead of inventing nine problems — `harness fault: the re-check
  // subprocess did not run (code ETIMEDOUT, status null, signal SIGTERM, after
  // 15 ms)` — but the runner's first spawn after four idle hours was the spawn OF
  // the subprocess, so the triple still went ungraded.
  if (first.fault?.code === 'ETIMEDOUT') {
    const second = attempt(cmd, args, opts, hooks)
    if (second.fault?.code === 'ETIMEDOUT') return second
    // Said out loud, because otherwise the retry is invisible: nothing could tell
    // from a log whether it had fired, which made "did the fix work?" unanswerable
    // on the one live run that exercised it. A caller that COUNTS its retries
    // (the mid-wave progress probe, whose every tick follows a gap) passes
    // `onStaleRetry` and decides how often the line is printed.
    const line = `[spawn] ${cmd}: an impossible ETIMEDOUT after ${first.fault.elapsedMs} ms `
      + `(cap ${opts.timeoutMs} ms) — bun's stale deadline; retried once and the retry ran (F155)`
    if (typeof opts.onStaleRetry === 'function') opts.onStaleRetry(line)
    else console.error(line)
    return { ...second, staleDeadlineRetried: true }
  }
  return first
}

// F166: every merge-mode spawn is an instrument whose OUTPUT IS PARSED — a gate,
// the suite gate, the sweep, git. The runner inherits whatever launched it, and
// the operator's terminal exported `FORCE_COLOR=3`: pytest honours it even on a
// pipe, printed `\x1b[31mFAILED\x1b[0m …`, and the suite gate's
// `line.startswith("FAILED ")` saw no failure in a run that had one — C10 wave 1
// became a harness fault instead of a graded MISS. So the child never sees a
// colour-forcing variable, and is told plainly not to colour, unless the caller
// set those keys itself. `envExact` callers built their environment on purpose
// and are left alone.
export const COLOUR_FORCING_KEYS = ['FORCE_COLOR', 'CLICOLOR_FORCE']
export const NO_COLOUR_ENV = { NO_COLOR: '1', PY_COLORS: '0' }

export function instrumentEnv(base, env) {
  const merged = { ...base, ...(env ?? {}) }
  for (const k of COLOUR_FORCING_KEYS) if (!(env && k in env)) delete merged[k]
  for (const [k, v] of Object.entries(NO_COLOUR_ENV)) if (!(env && k in env)) merged[k] = v
  return merged
}

// F242: the `contained` option. A command that runs workspace code for an unattended run (the
// driver's check and probe, every grader and calibration run) starts inside a containment: the
// caller's own (`contained` is a run context) or one made for this command (`{ own, extraRoots?,
// labelOwn? }`, kind `grader`, released when the command has ended). On Windows the child is then
// started by the low-integrity launcher. A command that could not be run contained is not run: the
// result carries `fault.code === 'ECONTAINMENT'`, so every caller's `if (r.fault)` reads it as
// "did not run", never as a failing gate.
let saidDirect = false

/** `Refused [containment]: <reason>. <the default advice>` back to `<reason>`. */
function refusalReason(text) {
  const prefix = `${refusalPrefix('containment')} `
  const suffix = refusalText('containment', '').slice(prefix.length)
  let r = String(text)
  if (r.startsWith(prefix)) r = r.slice(prefix.length)
  if (r.endsWith(suffix)) r = r.slice(0, r.length - suffix.length)
  return r
}

/** The result of a command that was refused before anything was started. */
function refusedResult(reason) {
  return {
    status: null, stdout: '', stderr: `[spawn] REFUSED: containment: ${reason} — nothing was run`, elapsedMs: 0, timedOut: false,
    fault: { code: 'ECONTAINMENT', status: null, signal: null, elapsedMs: 0 },
  }
}

/**
 * What to start, and how to clean up after it. `{ refused }` when nothing may be started;
 * otherwise `{ cmd, args, shell, cwd, env, viaLauncher, done }`, where `done()` deletes a long
 * command's file and releases a containment made here. `hooks.ownLevel`, `hooks.establish`,
 * `hooks.release`, `hooks.platform` and `hooks.bun` are test seams.
 */
function containedPlan({ cmd, args, shell, cwd, env, envExact, contained }, hooks = {}) {
  const plain = () => ({
    cmd, args, shell, cwd, viaLauncher: false, done: () => {},
    env: envExact ? (env ?? process.env) : instrumentEnv(process.env, env),
  })
  if (contained == null) return plain()
  if (envExact) return { refused: 'a contained command cannot take an exact environment' }
  let ctx
  let own = false
  if (typeof contained.runId === 'string') {
    ctx = contained
  } else {
    if (typeof contained.own !== 'string' || contained.own === '') {
      return { refused: 'the contained option names neither a run context nor a folder of its own' }
    }
    // Entry 1.B2 part 2: a process that is already low integrity (the authoring check started by a
    // contained Bash or check) cannot make a sandbox or set a label, and needs neither.
    if ((hooks.ownLevel ?? ownIntegrityLevel)() === 'low') {
      if (!saidDirect) {
        saidDirect = true
        console.error('[spawn] already inside a contained run: commands run directly, with no second sandbox')
      }
      return plain()
    }
    const est = (hooks.establish ?? establishContainment)({
      kind: 'grader', label: `grade-${basename(contained.own)}`, missionCwd: contained.own,
      labelCwd: contained.labelOwn !== false, extraRoots: contained.extraRoots,
    })
    if (!est.ok) return { refused: est.reason }
    ctx = est.containment
    own = true
  }
  const release = () => {
    if (!own) return
    const r = (hooks.release ?? releaseContainment)(ctx)
    if (!r.relabelled && r.note) console.error(`[spawn] ${r.note}`)
  }
  const refusal = toolSpawnRefusal({ ctx, required: true, platform: hooks.platform, bun: hooks.bun })
  if (refusal) {
    release()
    return { refused: refusalReason(refusal) }
  }
  let c
  try {
    c = containedCommand({ file: cmd, args: args ?? [], ...(shell !== undefined ? { shell } : {}) }, {
      ctx, cwd, platform: hooks.platform,
      env: instrumentEnv(process.env, { ...(contained.labelOwn === false ? { PYTHONDONTWRITEBYTECODE: '1' } : {}), ...(env ?? {}) }),
    })
  } catch (e) {
    // A long command whose file could not be written: nothing was started.
    release()
    return { refused: `the contained command could not be prepared (${e?.message ?? e})` }
  }
  const done = () => {
    if (c.commandFile) {
      try { unlinkSync(c.commandFile) } catch (e) { console.error(`[spawn] the command file ${c.commandFile} could not be removed: ${e?.message ?? e}`) }
    }
    release()
  }
  if (!c.viaLauncher) return { cmd: c.file, args: c.args, shell, cwd: c.cwd, env: c.env, viaLauncher: false, done }
  // F166: the launcher's child inherits what the launcher has, so the two colour-forcing keys are
  // taken out of the launcher's own environment unless the caller named them.
  const launcherEnv = { ...c.env }
  for (const k of COLOUR_FORCING_KEYS) if (!(env && k in env)) delete launcherEnv[k]
  return { cmd: c.file, args: c.args, shell: undefined, cwd: c.cwd, env: launcherEnv, viaLauncher: true, done }
}

function attempt(cmd, args, { cwd, env, envExact, timeoutMs, shell, contained } = {}, { spawn = spawnSync, now = () => Date.now(), ...hooks } = {}) {
  const plan = containedPlan({ cmd, args, shell, cwd, env, envExact, contained }, hooks)
  if (plan.refused !== undefined) return refusedResult(plan.refused)
  try {
    const t0 = now()
    const r = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      // `envExact`: the caller built the WHOLE environment and stripped keys out
      // of it on purpose (the mission dispatch drops CYNCO_NTFY_* and GitHub
      // tokens) — merging process.env back underneath would put them straight back.
      env: plan.env,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      shell: plan.shell,
    })
    const elapsedMs = Math.max(0, now() - t0)
    return classified({ status: r.status ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal ?? null, error: r.error }, elapsedMs, timeoutMs, plan.viaLauncher)
  } finally {
    plan.done()
  }
}

/** Rules 1 and 2 above, shared by runSync and runAsync: an ETIMEDOUT is believed only when the time was spent. */
function classified({ status, stdout, stderr, signal, error }, elapsedMs, timeoutMs, viaLauncher = false) {
  // Entry 1.M1: a launcher that could not run the command (197 with its refused line), or whose
  // child ended with no status (198 with its line), is a fault, never the command's own exit code.
  const launcherFault = viaLauncher ? launcherFaultOf(status, stderr) : null
  if (launcherFault) {
    return { status: null, stdout, stderr, elapsedMs, timedOut: false, fault: { code: launcherFault.code, status: null, signal, elapsedMs } }
  }
  const out = { status, stdout, stderr, elapsedMs, timedOut: false, fault: null }
  if (!error) return out
  const spentIt = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    && elapsedMs >= timeoutMs * TIMEOUT_ELAPSED_FRACTION
  if (error.code === 'ETIMEDOUT' && spentIt) {
    out.timedOut = true
    return out
  }
  out.fault = { code: error.code ?? null, status, signal, elapsedMs }
  return out
}

/**
 * The async sibling of runSync. Same options, same `{ status, stdout, stderr,
 * elapsedMs, timedOut, fault }` shape, the same F166 instrument environment
 * and the same elapsed-time reading of a timeout.
 *
 * Phase 7 review C1: a check that blocks the event loop for half an hour
 * cannot answer the bridge's keep-alive, so the engine drops the socket the
 * driver's note must travel on. This one awaits, so the loop keeps running.
 *
 * The deadline is this function's own timer, not spawnSync's, so bun's stale
 * deadline (F155) cannot fire here; `retryImpossibleTimeout` is accepted and
 * has nothing to retry. On a timeout the child's whole tree is killed
 * (`taskkill /T` on Windows — a shell's pytest grandchild would outlive a
 * plain kill). `hooks.spawn`, `hooks.now` and `hooks.kill` are test seams.
 * `contained` is runSync's option, with the same refusal; the containment is
 * released when the child has closed.
 */
export function runAsync(cmd, args, { cwd, env, envExact, timeoutMs, shell, contained } = {}, { spawn: spawnImpl = spawn, now = () => Date.now(), kill = killTree, ...hooks } = {}) {
  const plan = containedPlan({ cmd, args, shell, cwd, env, envExact, contained }, hooks)
  if (plan.refused !== undefined) return Promise.resolve(refusedResult(plan.refused))
  const t0 = now()
  return new Promise((resolveRun) => {
    let stdout = ''
    let stderr = ''
    let deadlineHit = false
    let settled = false
    let child
    const settle = (fields) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      plan.done()
      resolveRun(classified({ stdout, stderr, ...fields }, Math.max(0, now() - t0), timeoutMs, plan.viaLauncher))
    }
    const timer = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => { deadlineHit = true; kill(child) }, timeoutMs)
      : null
    try {
      child = spawnImpl(plan.cmd, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        windowsHide: true,
        shell: plan.shell,
      })
    } catch (e) {
      settle({ status: null, signal: null, error: { code: e?.code ?? 'ESPAWN' } })
      return
    }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (e) => settle({ status: null, signal: null, error: { code: e?.code ?? 'ESPAWN' } }))
    child.on('close', (code, signal) => settle({
      status: deadlineHit ? null : (typeof code === 'number' ? code : null),
      signal: signal ?? null,
      error: deadlineHit ? { code: 'ETIMEDOUT' } : null,
    }))
  })
}

/** Kill a child and everything under it. */
function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) return
  }
  try { child.kill('SIGKILL') } catch (e) { console.error(`[spawn] could not kill pid ${child.pid}: ${e?.message ?? e}`) }
}

/** One line naming a fault, for a problem list a person reads. */
export function faultSummary(fault) {
  if (!fault) return ''
  const bits = [`code ${fault.code ?? 'null'}`, `status ${fault.status ?? 'null'}`]
  if (fault.signal) bits.push(`signal ${fault.signal}`)
  bits.push(`after ${fault.elapsedMs} ms`)
  return bits.join(', ')
}
