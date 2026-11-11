// engine/daemon/taskRunner.ts
// Spawns one-shot engine runs with a GPU guard and a hard timeout.
import { spawn } from 'child_process'
import { join } from 'path'
import { writeTaskFile, readOutcome } from './taskFile.js'
import { clearGpuBusy, writeGpuBusy } from './gpuBusyFile.js'
import { activity as processActivity, type ActivityRegistry } from '../power/activity.js'
import { ownProcessTree, type OwnedTree } from '../processTree.js'
import type { TaskFileInput, TaskOutcome } from './types.js'

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
}

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
    // A hook that fails must not stop a run or hide a deferral: say so and go on.
    const hook = async (name: string, fn?: () => Promise<void>) => {
      try { await fn?.() } catch (e) { console.log(`[task:${input.triggerId}] ${name} failed: ${e instanceof Error ? e.message : String(e)}`) }
    }
    await hook('taking the GPU', this.opts.takeGpu ? () => this.opts.takeGpu!(input.triggerId) : undefined)
    const busy = await (this.opts.isGpuBusyImpl ?? isGpuBusy)()
    if (busy) {
      // What was taken for a run that will not start is given back at once.
      await hook('giving the GPU back', this.opts.giveGpuBack)
      throw new GpuBusyError()
    }

    const repoRoot = this.opts.repoRoot ?? process.cwd()
    const stamp = Date.now()
    const taskPath = join(this.opts.workDir, `task-${input.triggerId}-${stamp}.json`)
    const finalInput: TaskFileInput = {
      ...input,
      outcomePath: input.outcomePath || join(this.opts.workDir, `outcome-${input.triggerId}-${stamp}.json`),
    }
    writeTaskFile(taskPath, finalInput)

    const cmd = this.opts.spawnCmd ?? ['bun', join(repoRoot, 'engine', 'main.ts')]
    // The one-shot engine must not inherit the daemon's ntfy credentials —
    // it reports through its outcome file, never directly to the phone.
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('CYNCO_NTFY_')) continue
      env[k] = v
    }
    const child = spawn(cmd[0], [...cmd.slice(1), '--run-task', taskPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Non-Windows: own process group so a timeout kill(-pid) reaps bun AND
      // any llama-server it spawned. Windows owns the tree instead (below).
      detached: process.platform !== 'win32',
      env,
    })
    // Taken now, while the child has started nothing: a kill later cannot miss
    // the llama-server it spawns (engine/processTree.ts).
    const tree = ownProcessTree(child.pid)
    // The claim on the GPU: readers (lazy engine, dashboard, widget) wait on
    // it instead of killing this child's llama-server (F182). Cleared in the
    // finally below on every exit path, including the timeout kill.
    const busyPath = this.opts.gpuBusyPath
    // A one-shot is an open activity for its whole lifetime: the PC stays awake
    // (engine/power/awake.ts) until the child has exited or been killed.
    const endActivity = (this.opts.activity ?? processActivity).begin('oneshot', input.triggerId)
    if (child.pid) {
      try {
        writeGpuBusy({ task: input.missionId, triggerId: input.triggerId, startedAt: new Date().toISOString(), timeoutMs: input.timeoutMs, pid: child.pid }, busyPath)
      } catch (e) {
        console.log(`[task:${input.triggerId}] gpu-busy.json not written: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    try {
    let sessionId: string | undefined
    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString()
      const m = JOURNAL_LINE.exec(text)
      if (m) sessionId = m[1]
      console.log(`[task:${input.triggerId}] ${text.trim()}`)
    })
    child.stderr?.on('data', (d: Buffer) => console.log(`[task:${input.triggerId}] ${d.toString().trim()}`))

    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    const ended = await Promise.race<'exit' | 'timeout' | 'pause'>([
      exited.then(() => 'exit' as const),
      new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), input.timeoutMs) }),
      new Promise<'pause'>((r) => {
        const ask = this.opts.shouldPause
        if (!ask) return
        poll = setInterval(() => { if (ask()) r('pause') }, this.opts.pausePollMs ?? 5000)
      }),
    ])
    if (timer !== null) clearTimeout(timer)
    if (poll !== null) clearInterval(poll)

    if (ended !== 'exit') {
      await this.killTree(child, exited, tree)
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
      tree.release()
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

  /** Kill bun and the llama-server it spawned (the owned tree on Windows, the process group elsewhere). */
  private async killTree(child: ReturnType<typeof spawn>, exited: Promise<number | null>, tree: OwnedTree): Promise<void> {
    {
      if (process.platform === 'win32') {
        // A tree found at kill time must be walked while its root is alive;
        // skip if the child exited during the race window (avoids a noisy
        // taskkill ERROR). A Job Object needs no such care.
        if (tree.kind === 'job' || (child.pid && child.exitCode === null)) await tree.kill()
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
