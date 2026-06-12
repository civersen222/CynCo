// engine/daemon/taskRunner.ts
// Spawns one-shot engine runs with a GPU guard and a hard timeout.
import { spawn } from 'child_process'
import { join } from 'path'
import { writeTaskFile, readOutcome } from './taskFile.js'
import type { TaskFileInput, TaskOutcome } from './types.js'

export class GpuBusyError extends Error {
  constructor() { super('GPU busy: an interactive llama-server is running') }
}

/**
 * Heuristic: if llama-server is already running, an interactive CynCo session
 * owns the GPU — a scheduled task must not fight it for VRAM.
 */
export async function isGpuBusy(
  listProcesses?: () => Promise<string>,
): Promise<boolean> {
  const list = listProcesses ?? (async () => {
    const { execSync } = require('child_process')
    return execSync('tasklist', { timeout: 10000, encoding: 'utf-8' }) as string
  })
  try {
    const out = await list()
    return out.toLowerCase().includes('llama-server')
  } catch {
    return false // can't tell — let the run proceed; engine startup will fail loudly if truly contended
  }
}

export interface TaskRunnerOptions {
  /** Directory for task/outcome files (per-mission tmp). */
  workDir: string
  /** Command to launch the one-shot engine. Default: ['bun', '<repoRoot>/engine/main.ts']. */
  spawnCmd?: string[]
  /** Repo root (cwd for the engine process). Default: process.cwd(). */
  repoRoot?: string
  isGpuBusyImpl?: () => Promise<boolean>
}

export class TaskRunner {
  private opts: TaskRunnerOptions

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts
  }

  async run(input: TaskFileInput): Promise<TaskOutcome> {
    const busy = await (this.opts.isGpuBusyImpl ?? isGpuBusy)()
    if (busy) throw new GpuBusyError()

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
      // any llama-server it spawned. Windows uses taskkill /T instead.
      detached: process.platform !== 'win32',
      env,
    })
    child.stdout?.on('data', (d: Buffer) => console.log(`[task:${input.triggerId}] ${d.toString().trim()}`))
    child.stderr?.on('data', (d: Buffer) => console.log(`[task:${input.triggerId}] ${d.toString().trim()}`))

    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })
    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), input.timeoutMs) }),
    ])
    if (timer !== null) clearTimeout(timer)

    if (timedOut) {
      if (process.platform === 'win32') {
        // taskkill /T must run while the tree is alive; skip if the child
        // exited during the race window (avoids a noisy taskkill ERROR).
        if (child.pid && child.exitCode === null) {
          try {
            const { execSync } = require('child_process')
            execSync(`taskkill /F /T /PID ${child.pid}`, { timeout: 5000, stdio: 'ignore' })
          } catch {}
        }
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
      return { ok: false, summary: '', recommendations: [], error: `Task timeout after ${input.timeoutMs}ms` }
    }

    const code = await exited
    const outcome = readOutcome(finalInput.outcomePath)
    if (!outcome.ok && !outcome.error && code !== 0) {
      outcome.error = `Engine exited with code ${code}`
    }
    return outcome
  }
}
