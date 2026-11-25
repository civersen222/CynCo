// engine/daemon/taskRunner.ts
// Spawns one-shot engine runs with a GPU guard and a hard timeout.
import { spawn } from 'child_process'
import { join } from 'path'
import { writeTaskFile, readOutcome } from './taskFile.js'
import { clearGpuBusy, writeGpuBusy } from './gpuBusyFile.js'
import { activity as processActivity, type ActivityRegistry } from '../power/activity.js'
import { ownProcessTree, type OwnedTree } from '../processTree.js'
import type { TaskFileInput, TaskOutcome } from './types.js'
import { mintRunId, type RunContainment } from '../containment.js'

export class GpuBusyError extends Error {
  constructor() { super('GPU busy: an interactive llama-server is running') }
}

// A compute app holding this much VRAM means the GPU can't also fit a
// one-shot engine model load (Qwen3.6-27B Q6_K needs ~24GB of the 5090's 32GB).
const GPU_VRAM_BUSY_MIB = 4096

/**
 * Any HTTP answer from the engine's model port means a model server is up there. This is the
 * strongest busy signal: it is exactly the server a new one-shot's ProcessManager.ensureRunning()
 * would kill as "stale" (2026-10-28: the daemon's run killed a live hand-started run's server
 * after the tasklist probe missed it; nvidia-smi reports [N/A] memory under WDDM).
 */
async function modelServerAnswering(): Promise<boolean> {
  const port = parseInt(process.env.LOCALCODE_PORT ?? '8081', 10)
  await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
  return true // any response, even 503 while a model loads, is a live server
}

/**
 * GPU guard (spec §2): a model server answering on the engine port, nvidia-smi compute apps,
 * and the tasklist heuristic for an interactive CynCo session (llama-server). Any signal → busy.
 * Each probe fails open: can't tell → let the run proceed; engine startup
 * will fail loudly if truly contended.
 */
export async function isGpuBusy(
  listProcesses?: () => Promise<string>,
  queryGpuApps?: () => Promise<string>,
  probeModelServer?: () => Promise<boolean>,
): Promise<boolean> {
  // A refused connection is the normal idle answer, so a throwing probe means "no server", not an error.
  const serverUp = await (probeModelServer ?? modelServerAnswering)().catch(() => false)
  if (serverUp) return true

  // Command lines where the OS gives them (so an embedding-only server can be told apart), else the bare
  // process list. Ollama runs its embedding model as its own llama-server.exe (`--embedding`, under 1 GB)
  // and keeps it a few minutes after any embed call; counting it deferred every trigger that followed a
  // pass that embedded anything (2026-10-28).
  const list = listProcesses ?? (async () => {
    const { execSync } = require('child_process')
    if (process.platform === 'win32') {
      try {
        return execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'llama-server.exe\'\\" | ForEach-Object { $_.CommandLine }"',
          { timeout: 15000, encoding: 'utf-8' },
        ) as string
      } catch (e) {
        console.log(`[daemon] llama-server command lines unavailable, falling back to tasklist: ${e instanceof Error ? e.message : e}`)
      }
    }
    return execSync('tasklist', { timeout: 10000, encoding: 'utf-8' }) as string
  })
  const queryGpu = queryGpuApps ?? (async () => {
    const { execSync } = require('child_process')
    return execSync('nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits', {
      timeout: 10000, encoding: 'utf-8',
    }) as string
  })

  try {
    const out = await list()
    const chatServer = out.toLowerCase().split('\n').some(l => l.includes('llama-server') && !l.includes('--embedding'))
    if (chatServer) return true
  } catch {}

  try {
    // One "pid, used_memory_MiB" line per compute app; empty when GPU is idle
    for (const line of (await queryGpu()).split('\n')) {
      const usedMib = parseInt(line.split(',')[1] ?? '', 10)
      if (Number.isFinite(usedMib) && usedMib >= GPU_VRAM_BUSY_MIB) return true
    }
  } catch {}

  return false
}

export interface TaskRunnerOptions {
  /** Directory for task/outcome files (per-mission tmp). */
  workDir: string
  /** Command to launch the one-shot engine. Default: ['bun', '<repoRoot>/engine/main.ts']. */
  spawnCmd?: string[]
  /** Repo root (cwd for the engine process). Default: process.cwd(). */
  repoRoot?: string
  isGpuBusyImpl?: () => Promise<boolean>
  /** Polled while a task runs; true kills the task tree and reports a paused outcome (control.ts). */
  shouldPause?: () => boolean
  /** How often shouldPause is asked. Default 5 s. */
  pausePollMs?: number
  /** Where the one-shot's GPU claim is written (default <cyncoHome>/gpu-busy.json). Tests point it at a temp dir. */
  gpuBusyPath?: string
  /** Where the one-shot registers as an open activity (hold-awake). Default: the process-wide registry. */
  activity?: ActivityRegistry
  /**
   * Before the busy check: take the model port from an app's server, or from one that is nobody's, by the rule the chat
   * engine uses (engine/apps/gpu.ts). `why` is the trigger. Another engine's server is left, and the busy check defers.
   */
  takeGpu?: (why: string) => Promise<void>
  /** After the run, however it ended, and after a deferral: start again what was stopped for it. */
  giveGpuBack?: () => Promise<void>
  /** Asked after the paused check and before the GPU is taken: `<layer>: <reason>` refuses the run, null lets it go on. */
  refuse?: () => string | null
  /**
   * After the busy check and the integrity baseline: make the run's sandbox (engine/containment.ts) under the run id
   * `run()` minted, which keys the baseline, the sandbox and the task file. A refusal is a failed run, never an uncontained one.
   */
  contain?: (input: TaskFileInput, runId: string) => { ok: true; containment: RunContainment } | { ok: false; reason: string }
  /** After the child has exited, however it ended: give the mission folder its label back. */
  release?: (c: RunContainment) => { relabelled: boolean; note: string }
  /** Polled with shouldPause. A sentence kills the run; it is NOT parked, so clearing the latch does not relaunch it. */
  halted?: () => string | null
  /**
   * The integrity pair (F242, engine/integrity.ts). `before` may throw (the run is then not started); `after` never
   * throws and returns the sentence when a protected folder changed, having already written the latch. Neither goes
   * through hook(), which swallows.
   */
  integrity?: {
    before: (runId: string, cwd: string | undefined, timeoutMs: number) => void | Promise<void> // awaited (wave 15, `baselineInChild`); a throw or a rejection refuses the run
    /** `notConfirmedDead`: why the one-shot's tree is not known to be dead; the settle then latches whatever it finds. */
    after: (runId: string, notConfirmedDead?: string) => Promise<string | null>
    /**
     * Whether a baseline of this run is open in the guard folder (wave 15b, check P1-C3): a `before` that
     * rejected after its child had written the baseline (it then failed, or hung and was ended) leaves one.
     * It is settled at once, `after` with nothing run: a clean settle closes it, a real change still latches.
     * Left out, nothing is asked and nothing is settled.
     */
    opened?: (runId: string) => boolean
  }
  /** How long the settle waits for the child's exit after its tree was killed (default 10 s). Tests shorten it. */
  deadWaitMs?: number
}

type Hook = (name: string, fn?: () => Promise<void>) => Promise<void>

/** How a run refused for want of its baseline is said; the guard (`scripts/cynco-guard.mjs pre`) says it the same way. */
const NO_BASELINE = 'no integrity baseline could be taken'

/** The engine announces its journal once at startup; the daemon needs the id to resume a paused run. */
const JOURNAL_LINE = /\[session\] Journal: .*?(session-\d+)\.jsonl/

export class TaskRunner {
  private opts: TaskRunnerOptions

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts
  }

  async run(input: TaskFileInput): Promise<TaskOutcome> {
    // Already paused: report it the way the poll path does, without spawning a run only to kill it.
    if (this.opts.shouldPause?.()) {
      console.log(`[task:${input.triggerId}] paused before start — not spawned`)
      return { ok: false, summary: '', recommendations: [], error: 'PAUSED', paused: { elapsedMs: 0 } }
    }
    // Nothing is taken yet, so nothing is given back. Not through hook(), which swallows.
    const refusal = this.opts.refuse?.() ?? null
    if (refusal) {
      console.log(`[task:${input.triggerId}] REFUSED: ${refusal} — nothing was run`)
      return { ok: false, summary: '', recommendations: [], error: `REFUSED: ${refusal}` }
    }
    // A hook that fails must not stop a run or hide a deferral: say so and go on.
    const hook: Hook = async (name, fn) => {
      try { await fn?.() } catch (e) { console.log(`[task:${input.triggerId}] ${name} failed: ${e instanceof Error ? e.message : String(e)}`) }
    }
    await hook('taking the GPU', this.opts.takeGpu ? () => this.opts.takeGpu!(input.triggerId) : undefined)
    const busy = await (this.opts.isGpuBusyImpl ?? isGpuBusy)()
    if (busy) {
      // What was taken for a run that will not start is given back at once.
      await hook('giving the GPU back', this.opts.giveGpuBack)
      throw new GpuBusyError()
    }
    // F242: one run id keys the integrity baseline, the sandbox and the task file. The baseline is taken
    // before the sandbox is made, and settled once the child tree is dead, on every path out of this method.
    const runId = mintRunId(`daemon-${input.missionId}-${input.triggerId}`)
    let baselineTaken = false
    if (this.opts.integrity) {
      try {
        await this.opts.integrity.before(runId, input.cwd, input.timeoutMs)
        baselineTaken = true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Wave 15b (check P1-C7): a reason that already says so is not wrapped a second time.
        let reason = msg.startsWith(NO_BASELINE) ? msg : `${NO_BASELINE} (${msg})`
        // Wave 15b (check P1-C3): a child that wrote the baseline and then failed or hung leaves it open, and an open
        // baseline whose holder lives past its deadline is settled as an orphan, which latches and stops every
        // unattended starter for a run that never started. Nothing ran, so it is settled now; a real change still latches.
        let settledNote = ''
        let opened = false
        try { opened = this.opts.integrity.opened?.(runId) ?? false } catch (oe) {
          console.log(`[task:${input.triggerId}] whether a baseline of ${runId} was left open could not be read (${oe instanceof Error ? oe.message : String(oe)})`)
        }
        if (opened) {
          const tripped = await this.opts.integrity.after(runId)
          settledNote = tripped === null ? '' : `; the baseline it left was settled: ${tripped}`
          console.log(`[task:${input.triggerId}] the refused baseline process left a baseline of ${runId}; settled it${tripped === null ? ', unchanged' : `: ${tripped}`}`)
        }
        reason += settledNote
        console.log(`[task:${input.triggerId}] REFUSED: integrity: ${reason} — nothing was run`)
        await hook('giving the GPU back', this.opts.giveGpuBack)
        return { ok: false, summary: '', recommendations: [], error: `REFUSED: integrity: ${reason}` }
      }
    }
    // A holder object, not a `let`: the strict type-check narrows a `let` that only a closure assigns.
    const pair: { settled: boolean; tripped: string | null } = { settled: false, tripped: null }
    // Runs once, after the child tree is dead (or when no child was started), before the sandbox is given back.
    const settle = async (notConfirmedDead?: string): Promise<void> => {
      if (pair.settled || !baselineTaken || !this.opts.integrity) return
      pair.settled = true
      pair.tripped = await this.opts.integrity.after(runId, notConfirmedDead)
    }
    let outcome: TaskOutcome | null = null
    let thrown: unknown = null
    let threw = false
    try {
      outcome = await this.spawnAndWait(input, hook, runId, settle)
    } catch (e) {
      thrown = e
      threw = true
    }
    await settle()   // a path that left before the child was started
    if (pair.tripped) {
      console.log(`[task:${input.triggerId}] INTEGRITY: ${pair.tripped}`)
      return { ok: false, summary: '', recommendations: [], error: `INTEGRITY: ${pair.tripped}` }
    }
    if (threw) throw thrown
    return outcome!
  }

  /** From the sandbox to the child's end: everything that has a child tree to wait for. `settle` runs once that tree is dead. */
  private async spawnAndWait(input: TaskFileInput, hook: Hook, runId: string, settle: (notConfirmedDead?: string) => Promise<void>): Promise<TaskOutcome> {
    // F242: the sandbox is made only for a run that will start (a deferral builds none). A refusal is a
    // failed run: nothing is spawned and what was taken for it is given back.
    const est = this.opts.contain?.(input, runId)
    if (est && !est.ok) {
      console.log(`[task:${input.triggerId}] REFUSED: containment: ${est.reason} — nothing was run`)
      await settle()
      await hook('giving the GPU back', this.opts.giveGpuBack)
      return { ok: false, summary: '', recommendations: [], error: `REFUSED: containment: ${est.reason}` }
    }
    // Called once the child has exited or been killed, or when it never started. releaseContainment never throws.
    const releaseSandbox = () => {
      if (!est?.ok || !this.opts.release) return
      const r = this.opts.release(est.containment)
      if (!r.relabelled && r.note) console.log(`[task:${input.triggerId}] ${r.note}`)
    }

    const repoRoot = this.opts.repoRoot ?? process.cwd()
    const stamp = Date.now()
    const taskPath = join(this.opts.workDir, `task-${input.triggerId}-${stamp}.json`)
    const finalInput: TaskFileInput = {
      ...input,
      outcomePath: input.outcomePath || join(this.opts.workDir, `outcome-${input.triggerId}-${stamp}.json`),
      // The child engine adopts this sandbox before the model loads (engine/main.ts).
      ...(est?.ok ? { runId: est.containment.runId } : {}),
    }
    // A throw before the child is owned (task file, spawn) would leave the mission folder labelled.
    let child: ReturnType<typeof spawn>
    let tree: OwnedTree
    let busyPath: string | undefined
    let endActivity: () => void
    // What the catch below must end if a throw comes after the child was started.
    let startedChild: ReturnType<typeof spawn> | undefined
    let startedTree: OwnedTree | undefined
    let activityEnd: (() => void) | undefined
    try {
    writeTaskFile(taskPath, finalInput)
    // --no-install (wave 19b): Bun never fetches a missing package by itself; one not installed is an error.
    const cmd = this.opts.spawnCmd ?? ['bun', '--no-install', join(repoRoot, 'engine', 'main.ts')]
    // The one-shot engine must not inherit the daemon's ntfy credentials —
    // it reports through its outcome file, never directly to the phone.
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('CYNCO_NTFY_')) continue
      env[k] = v
    }
    child = spawn(cmd[0], [...cmd.slice(1), '--run-task', taskPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Non-Windows: own process group so a timeout kill(-pid) reaps bun AND
      // any llama-server it spawned. Windows owns the tree instead (below).
      detached: process.platform !== 'win32',
      env,
    })
    startedChild = child
    // Taken now, while the child has started nothing: a kill later cannot miss
    // the llama-server it spawns (engine/processTree.ts). The process, not its pid:
    // a walked tree is never killed by the number once the child's exit was handled (F255).
    tree = ownProcessTree(child)
    startedTree = tree
    // The claim on the GPU: readers (lazy engine, dashboard, widget) wait on
    // it instead of killing this child's llama-server (F182). Cleared in the
    // finally below on every exit path, including the timeout kill.
    busyPath = this.opts.gpuBusyPath
    // A one-shot is an open activity for its whole lifetime: the PC stays awake
    // (engine/power/awake.ts) until the child has exited or been killed.
    endActivity = (this.opts.activity ?? processActivity).begin('oneshot', input.triggerId)
    activityEnd = endActivity
    if (child.pid) {
      try {
        writeGpuBusy({ task: input.missionId, triggerId: input.triggerId, startedAt: new Date().toISOString(), timeoutMs: input.timeoutMs, pid: child.pid }, busyPath)
      } catch (e) {
        console.log(`[task:${input.triggerId}] gpu-busy.json not written: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    } catch (e) {
      // A throw after the child was started (review finding of slice S2): the child and what it
      // started are ended before its sandbox is given back, or the one-shot would run on in a
      // folder whose label was just set back to medium.
      if (startedChild !== undefined) {
        console.log(`[task:${input.triggerId}] the one-shot was started and then setup failed: ${e instanceof Error ? e.message : String(e)} — ending it`)
        const startedExited = new Promise<number | null>(resolve => {
          if (startedChild!.exitCode !== null) return resolve(startedChild!.exitCode)
          startedChild!.once('exit', code => resolve(code))
          startedChild!.once('error', () => resolve(null))
        })
        const startedOwned = startedTree ?? ownProcessTree(undefined)
        await this.killTree(startedChild, startedExited, startedOwned)
        const deadWhy = await this.confirmDead(startedChild, startedExited, startedOwned)
        startedTree?.release()
        // The baseline is settled before anything is given back; a tree not known dead latches.
        await settle(deadWhy ?? undefined)
      }
      await settle()
      activityEnd?.()
      try {
        clearGpuBusy(busyPath)
      } catch (clearErr) {
        console.log(`[task:${input.triggerId}] gpu-busy.json not cleared: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`)
      }
      await hook('giving the GPU back', this.opts.giveGpuBack)
      releaseSandbox()
      throw e
    }
    // Made before the try, so the finally waits on the same exit (a spawn error fires once, and is not seen again).
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })
    try {
    let sessionId: string | undefined
    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString()
      const m = JOURNAL_LINE.exec(text)
      if (m) sessionId = m[1]
      console.log(`[task:${input.triggerId}] ${text.trim()}`)
    })
    child.stderr?.on('data', (d: Buffer) => console.log(`[task:${input.triggerId}] ${d.toString().trim()}`))

    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    const ended = await Promise.race<'exit' | 'timeout' | 'pause' | 'halt'>([
      exited.then(() => 'exit' as const),
      new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), input.timeoutMs) }),
      new Promise<'pause' | 'halt'>((r) => {
        const ask = this.opts.shouldPause, halted = this.opts.halted
        if (!ask && !halted) return
        // F242: the integrity latch first; a run it stops is killed, never parked.
        poll = setInterval(() => { if (halted?.()) r('halt'); else if (ask?.()) r('pause') }, this.opts.pausePollMs ?? 5000)
      }),
    ])
    if (timer !== null) clearTimeout(timer)
    if (poll !== null) clearInterval(poll)

    if (ended !== 'exit') {
      await this.killTree(child, exited, tree)
      if (ended === 'halt') {
        const why = this.opts.halted?.() ?? 'the integrity latch is present'
        console.log(`[task:${input.triggerId}] STOPPED: integrity: ${why}`)
        return { ok: false, summary: '', recommendations: [], error: `STOPPED: integrity: ${why}` }
      }
      if (ended === 'pause') {
        const elapsedMs = Date.now() - started
        console.log(`[task:${input.triggerId}] paused on request after ${Math.round(elapsedMs / 60000)} min${sessionId ? ` (journal ${sessionId})` : ' (no journal announced yet — it will restart)'}`)
        return { ok: false, summary: '', recommendations: [], error: 'PAUSED', paused: { ...(sessionId ? { sessionId } : {}), elapsedMs } }
      }
      return { ok: false, summary: '', recommendations: [], error: `Task timeout after ${input.timeoutMs}ms` }
    }

    const code = await exited
    const outcome = readOutcome(finalInput.outcomePath)
    if (!outcome.ok && !outcome.error && code !== 0) {
      outcome.error = `Engine exited with code ${code}`
    }
    return outcome
    } finally {
      // F242: nothing of a one-shot outlives it. Releasing a Job Object kills nothing (engine/processTree.ts),
      // so its tree is ended first, and the settling compare is told when the tree is not known to be dead
      // (no Job Object, or no exit seen); it then latches whatever it finds.
      const deadWhy = await this.confirmDead(child, exited, tree)
      tree.release()
      await settle(deadWhy ?? undefined)
      // The child has exited or been killed (killTree, or `await exited`): its sandbox can be given back.
      releaseSandbox()
      endActivity()
      try {
        clearGpuBusy(busyPath)
      } catch (e) {
        console.log(`[task:${input.triggerId}] gpu-busy.json not cleared: ${e instanceof Error ? e.message : String(e)}`)
      }
      // After the claim is cleared: giving back reads it, and must find the GPU free.
      await hook('giving the GPU back', this.opts.giveGpuBack)
    }
  }

  /**
   * Ends whatever of the one-shot's tree is still alive and waits, bounded, for the child's exit. Null when the
   * tree is known to be dead; otherwise why not. Never throws.
   */
  private async confirmDead(child: ReturnType<typeof spawn>, exited: Promise<number | null>, tree: OwnedTree): Promise<string | null> {
    try {
      if (process.platform === 'win32' && tree.kind === 'job') await tree.kill()
      else if (process.platform !== 'win32' && child.pid) {
        // The process group: anything the child left behind.
        try { process.kill(-child.pid, 'SIGKILL') } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') console.log(`[task] the one-shot's process group could not be killed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      return `the one-shot's tree could not be ended (${e instanceof Error ? e.message : String(e)})`
    }
    const waitMs = this.opts.deadWaitMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | null = null
    const gone = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), waitMs) }),
    ])
    if (timer !== null) clearTimeout(timer)
    if (!gone) return `the one-shot (pid ${child.pid ?? '?'}) had not exited ${Math.round(waitMs / 1000)} s after its tree was ended`
    if (process.platform === 'win32' && tree.kind !== 'job') return 'the one-shot\'s tree had no Job Object, so a process it started may still run'
    return null
  }

  /** Kill bun and the llama-server it spawned (the owned tree on Windows, the process group elsewhere). */
  private async killTree(child: ReturnType<typeof spawn>, exited: Promise<number | null>, tree: OwnedTree): Promise<void> {
    {
      if (process.platform === 'win32') {
        // A tree found at kill time must be walked while its root is alive: once
        // the child's exit was handled its pid may be another process's (F255).
        // The walked handle is given the child, asks its exitCode and signalCode in
        // the turn of its taskkill, and refuses with one line when it has ended; a
        // handle of a child with no pid kills nothing. A Job Object ends the job
        // whatever the child did. So nothing is asked here (wave 24, round three,
        // check Y2c-4: the condition that stood here only decided whether that
        // refusal line was logged, on a path no caller reaches: every path to
        // killTree runs before the child's exit can have been handled). The tree's
        // own kill is pinned by daemon/taskRunnerTreeKill.test.ts.
        await tree.kill()
        try { child.kill() } catch {}
      } else {
        // Kill the whole process group (bun → llama-server); escalate to
        // SIGKILL if SIGTERM is ignored.
        const killGroup = (sig: NodeJS.Signals) => {
          if (!child.pid) return
          try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} }
        }
        killGroup('SIGTERM')
        const gone = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
        ])
        if (!gone) killGroup('SIGKILL')
      }
    }
  }
}

// ─── The daemon's baseline in a process of its own (wave 15, NOW.md:83) ─────────────────────────

/** The arguments of `scripts/cynco-guard.mjs pre` for one daemon run (wave 15). */
export function guardPreArgv(o: { runId: string; cwd: string | undefined; by: string; holderPid: number; maxSeconds: number }): string[] {
  return ['pre', o.runId, ...(o.cwd ? ['--cwd', o.cwd] : ['--no-cwd']), '--by', o.by, '--holder-pid', String(o.holderPid), '--max-seconds', String(o.maxSeconds)]
}

/**
 * What a runtime is told before a script so that Bun never fetches a missing package by itself (wave 19b):
 * `--no-install` when the runtime's file name is bun or bun.exe (the daemon runs under Bun, so its own
 * process.execPath is one), nothing for another runtime (a test's Node refuses the flag). The name is read
 * after either separator, so a Windows path is read the same on every host.
 */
export function bunNoInstall(runtime: string): string[] {
  return /^bun(\.exe)?$/i.test(runtime.split(/[\\/]/).pop() ?? '') ? ['--no-install'] : []
}

/** How long the baseline process may take: the walk is 6 to 9 s cold on this PC, the volume listing is capped at 20 s. */
export const BASELINE_CHILD_TIMEOUT_MS = 120_000

/**
 * The integrity baseline of a daemon run, taken by `bun scripts/cynco-guard.mjs pre` in a process of
 * its own and awaited (wave 15, NOW.md:83): the walk (6 to 9 s cold on this PC, and the PowerShell
 * volume listing, capped at 20 s) no longer holds the daemon's event loop. Fail-closed: a child that
 * cannot start, exits other than 0 or does not end within `timeoutMs` (it is then ended with its tree)
 * rejects, and the run is refused. A guard refusal is handed on as the guard's own reason. Resolves
 * with the child's output lines, for the daemon log.
 */
export function baselineInChild(o: {
  runId: string; cwd: string | undefined; by: string; holderPid: number; maxSeconds: number
  /** The runtime and the guard script; default this process's own runtime (the daemon runs under Bun) and the checkout's script. */
  runtime?: string; script?: string; repoRoot?: string; timeoutMs?: number
}): Promise<string[]> {
  const runtime = o.runtime ?? process.execPath
  const script = o.script ?? join(o.repoRoot ?? process.cwd(), 'scripts', 'cynco-guard.mjs')
  const timeoutMs = o.timeoutMs ?? BASELINE_CHILD_TIMEOUT_MS
  return new Promise<string[]>((resolveP, rejectP) => {
    let out = ''
    let err = ''
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (e: Error | null, lines?: string[]) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (e) rejectP(e)
      else resolveP(lines ?? [])
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(runtime, [...bunNoInstall(runtime), script, ...guardPreArgv(o)], { cwd: o.repoRoot ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      finish(new Error(`the baseline process could not be started (${(e as NodeJS.ErrnoException)?.code ?? String(e)})`))
      return
    }
    const tree = ownProcessTree(child, (line) => console.log(`[daemon] ${line}`))
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf-8') })
    child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf-8') })
    child.on('error', (e: NodeJS.ErrnoException) => {
      tree.release()
      finish(new Error(`the baseline process could not be started (${e.code ?? e.message})`))
    })
    let timedOut = false
    const late = () => new Error(`the baseline process did not end within ${timeoutMs} ms; it was ended`)
    timer = setTimeout(() => {
      timedOut = true
      void tree.kill().then(() => finish(late()))
    }, timeoutMs)
    child.on('close', (code: number | null) => {
      if (timedOut) { finish(late()); return }
      tree.release()
      const lines = (s: string) => s.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
      if (code === 0) { finish(null, [...lines(out), ...lines(err)]); return }
      const errLines = lines(err)
      const refusal = errLines.map(l => /^\[guard\] REFUSED: integrity: (.*?)(?: — nothing was dispatched)?$/.exec(l)).find(Boolean)
      // Wave 15b (check P1-C7): the guard's own 'no integrity baseline could be taken (<why>)' is handed on as <why>,
      // since TaskRunner says that phrase itself; the outcome and the page read it once.
      if (refusal) { finish(new Error(/^no integrity baseline could be taken \((.*)\)$/s.exec(refusal[1]!)?.[1] ?? refusal[1])); return }
      const last = [...errLines, ...lines(out)].pop()
      finish(new Error(`the baseline process exited ${code === null ? 'without a code' : code}${last ? ` (${last})` : ''}`))
    })
  })
}
