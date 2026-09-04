// engine/llama/processManager.ts
import { type ChildProcess, spawn } from 'child_process'
import { basename, join } from 'path'
import { ServerStartError } from './errors.js'
import { readGgufMeta } from './gguf.js'
import { checkpointCostFromMeta, derivedCacheRamMib, MEASURED_DEFAULT_COST, type CheckpointCostModel } from './checkpointCost.js'
import { CheckpointCalibrator } from './checkpointCalibration.js'
import { evaluateSpawn, readGpuMemory, readHostMemory, spawnRequirementFor, topCommitConsumers, type SpawnCheck } from './hostResources.js'
import { statSync } from 'fs'
import { cyncoHome } from '../paths.js'

export type ServerConfig = {
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  loraPath?: string
  specType?: string
  specDraftN?: number
  cacheRam?: number
  reasoningBudget?: number
  ctxCheckpoints?: number
  checkpointMinStep?: number
  ubatchSize?: number
  chatTemplateFile?: string
  cacheTypeK?: string
  cacheTypeV?: string
  chatTemplateKwargs?: Record<string, string | number | boolean>
  /** Per-architecture checkpoint cost; buildServerArgs derives --cache-ram from it. Default: the measured Qwen3.8 fit. */
  checkpointCost?: CheckpointCostModel
}

/**
 * Default context window, in tokens.
 *
 * 131072 is half of what Qwen3.8-27B is trained for (262144) and costs ~2.5 GB
 * of f16 KV on the 32 GB card this stack targets. It is doubled from the 65536
 * the profiles carried because at 65536 the engine compacted 101 times in 900
 * turns on CivKings 11N — once every ~9 turns — and 49 times on 11M.
 *
 * Exported because `bootstrapProvider` needs the same number for the token
 * budget it hands the conversation loop: a ProcessManager started at 131072
 * while the loop believed 32768 would compact at a quarter of the real window.
 */
export const DEFAULT_CTX_SIZE = 131072

/**
 * A context checkpoint's host-memory cost is AFFINE in the tokens it covers,
 * not proportional to them — see checkpointCost.ts, which now derives the two
 * terms from the GGUF header (and checkpointCalibration.ts, which measures
 * them live). The measured constants this file used to carry (149.65 MiB +
 * 4.02 KiB/token on Qwen3.8-27B) live there as MEASURED_DEFAULT_COST.
 */

function envInt(name: string): number | undefined {
  const v = process.env[name]
  if (v == null || v === '') return undefined
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? undefined : n
}

/**
 * Build command-line arguments for llama-server.
 */
export function buildServerArgs(config: ServerConfig): string[] {
  const args: string[] = [
    '--model', config.modelPath,
    '--port', String(config.port),
    '--host', '127.0.0.1',
    '--ctx-size', String(config.ctxSize ?? DEFAULT_CTX_SIZE),
    '--n-gpu-layers', String(config.gpuLayers ?? 999),
    '--batch-size', String(config.batchSize ?? 2048),
    '--ubatch-size', String(config.ubatchSize ?? envInt('LOCALCODE_UBATCH_SIZE') ?? 2048),
  ]

  // Native tool calling (P1.8): --jinja enables the chat-template engine so
  // OpenAI `tools` render into the prompt and tool_calls/reasoning_content
  // are parsed server-side. Required for the default native transport.
  args.push('--jinja')

  args.push('--flash-attn', config.flashAttn !== false ? 'on' : 'off')

  if (config.threads != null) {
    args.push('--threads', String(config.threads))
  }

  if (config.loraPath) {
    args.push('--lora', config.loraPath)
  }

  // Override the GGUF's embedded chat template. Needed when a community
  // quant ships a stricter template than the model actually requires (e.g.
  // NVFP4 GGUFs whose template raises on mid-conversation system messages,
  // which the engine's context injection produces).
  if (config.chatTemplateFile) {
    args.push('--chat-template-file', config.chatTemplateFile)
  }

  // Extra kwargs handed to the jinja template. Qwen3.8 reads `reasoning_effort`
  // (low | medium | xhigh) and `preserve_thinking` from here; other models
  // ignore unknown keys.
  if (config.chatTemplateKwargs && Object.keys(config.chatTemplateKwargs).length > 0) {
    args.push('--chat-template-kwargs', JSON.stringify(config.chatTemplateKwargs))
  }

  // KV cache quantisation. Left at the server default (f16) unless a profile
  // asks for less — quantised KV costs accuracy and we have the VRAM.
  if (config.cacheTypeK) args.push('--cache-type-k', config.cacheTypeK)
  if (config.cacheTypeV) args.push('--cache-type-v', config.cacheTypeV)

  if (config.specType) {
    args.push('--spec-type', config.specType)
    args.push('--spec-draft-n-max', String(config.specDraftN ?? 2))
  }

  // Single slot — we only process one request at a time
  args.push('--parallel', '1')
  // Qwen3.6/3.8 are hybrid Gated DeltaNet + attention models. llama.cpp context
  // checkpoints snapshot recurrent state during prefill so warm turns roll
  // back to the nearest checkpoint instead of re-prefilling from token 0
  // (ggml-org/llama.cpp#21831). Those snapshots live in the host prompt cache,
  // which --cache-ram caps.
  //
  // F91: --cache-ram is DERIVED from the context and the checkpoint count
  // rather than left on llama-server's fixed 8192 MiB, because the three are
  // one decision. Raising the window raises what each checkpoint can cost
  // (see the affine model above — 407 MiB at 65536, 664 MiB at 131072) and
  // raising the count multiplies it; leaving the budget behind is what produced
  // "failed to allocate memory for prompt cache state: bad allocation" 753
  // turns into CivKings 11M.
  //
  // NOTE: prefix reuse also requires the client prompt to be strictly
  // append-only — see engine/__tests__/engine/prefixStability.test.ts.
  //
  // 32 checkpoints is llama-server's own default. 37461e1 doubled it to 64 in
  // the same commit that left --cache-ram at the server default, and nobody
  // multiplied the two; that product is F91.
  const ctxCheckpoints = config.ctxCheckpoints ?? envInt('LOCALCODE_CTX_CHECKPOINTS') ?? 32
  // Read the context back out of `args` rather than off `config`, so the
  // derivation follows whatever actually reached the server — including the
  // default. A cache-ram computed from a ctxSize the server never saw is the
  // same bug in a new place.
  const emittedCtxSize = Number(args[args.indexOf('--ctx-size') + 1])
  const cacheRam = config.cacheRam != null
    ? String(config.cacheRam)
    // string passthrough — value forwarded verbatim, no envInt
    : process.env.LOCALCODE_CACHE_RAM || String(derivedCacheRamMib(emittedCtxSize, ctxCheckpoints, config.checkpointCost ?? MEASURED_DEFAULT_COST))
  args.push('--cache-ram', cacheRam)
  args.push('--ctx-checkpoints', String(ctxCheckpoints))
  args.push('--checkpoint-min-step', String(config.checkpointMinStep ?? envInt('LOCALCODE_CHECKPOINT_MIN_STEP') ?? 256))
  // Default 256: >256 thinking tokens hurts tool-call accuracy and uncapped reasoning
  // can burn 30K+ invisible tokens (5+ min wasted per iteration).
  // Raise via LOCALCODE_REASONING_BUDGET if your model needs more deliberation.
  const reasoningBudget = config.reasoningBudget != null
    ? String(config.reasoningBudget)
    : process.env.LOCALCODE_REASONING_BUDGET ?? '256'
  args.push('--reasoning-budget', reasoningBudget)

  return args
}

/**
 * Validate that the served chat template supports native tool calls (P1.8).
 * Checks GET /props for a template that references tools; a template without
 * tool support silently renders requests WITHOUT the tool list — the model
 * would never see its tools. Non-fatal: callers log loudly and continue
 * (the simulated kill switch still works).
 */
export async function validateChatTemplate(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const resp = await fetchImpl(`${baseUrl}/props`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return { ok: false, reason: `/props HTTP ${resp.status}` }
    const props = await resp.json() as any
    const template: string = props?.chat_template
      ?? props?.default_generation_settings?.chat_template ?? ''
    if (!template) return { ok: false, reason: 'no chat_template in /props' }
    if (!/tool/i.test(template)) {
      return {
        ok: false,
        reason: 'chat template has no tool support — native tool calls will not render. ' +
          'Set chat_template_file in the profile to a tool-capable template (see VENDORED serving notes).',
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** How far back a restart still counts against the budget. */
const RESTART_WINDOW_MS = 600_000
/** Restarts allowed inside one window before we call it a crash loop. */
const MAX_RESTARTS_IN_WINDOW = 3

/**
 * How many of `times` fall inside the window ending at `now`.
 *
 * The comparison is strict, so a restart exactly `windowMs` old is outside the
 * window — one keystroke of difference that only shows up when a long session
 * sits on the boundary.
 */
export function recentRestartCount(times: number[], now: number, windowMs: number): number {
  return times.filter(t => now - t < windowMs).length
}

/**
 * Whether an exited llama-server should be brought back up.
 *
 * Deliberate stops are never restarted — stop(), restartWithAdapter() and
 * restartWithoutAdapter() kill the child on purpose, and respawning there would
 * race the caller's own startProcess and leave two servers on one port.
 *
 * The budget matters as much as the restart: a server that cannot stay up must
 * eventually surface as an error rather than hide a permanent fault behind an
 * infinite respawn.
 */
export function shouldRestartAfterExit(
  { deliberate, recentRestarts, maxRestarts }: {
    deliberate: boolean
    recentRestarts: number
    maxRestarts: number
  },
): boolean {
  if (deliberate) return false
  return recentRestarts < maxRestarts
}

/**
 * Delay before a crash-triggered restart. F140 spent the 3-in-600s budget in
 * 14 minutes against a memory-pressure event that lasted 14 minutes; with
 * backoff the same three attempts span 5s + 10s + 20s of waiting plus three
 * pre-spawn checks, each of which can refuse (see hostResources.ts) without
 * consuming a restart.
 */
export function restartDelayMs(recentRestarts: number): number {
  return Math.min(5_000 * 2 ** recentRestarts, 120_000)
}

/** How long a refused restart waits before looking again. */
const REFUSAL_RECHECK_MS = 120_000
/** VRAM is released a moment after a process dies; one re-read before refusing on it. */
const GPU_RECHECK_DELAY_MS = 3_000

export type ProcessManagerConfig = {
  binaryPath: string
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  specType?: string
  specDraftN?: number
  cacheRam?: number
  reasoningBudget?: number
  ctxCheckpoints?: number
  checkpointMinStep?: number
  ubatchSize?: number
  chatTemplateFile?: string
  cacheTypeK?: string
  cacheTypeV?: string
  chatTemplateKwargs?: Record<string, string | number | boolean>
  /** Per-architecture checkpoint cost; when unset the manager reads the GGUF header (or a stored calibration). */
  checkpointCost?: CheckpointCostModel
  /** Test seam: replace the live host/GPU measurement. Production leaves it unset. */
  preSpawnCheck?: () => Promise<SpawnCheck>
}

export class ProcessManager {
  readonly port: number
  private binaryPath: string
  private baseConfig: ProcessManagerConfig
  private child: ChildProcess | null = null
  private currentLoraPath: string | null = null
  /** Timestamps of crash-triggered restarts, for the rolling-window budget. */
  private restartTimes: number[] = []
  onEvalTokPerSec?: (tps: number) => void
  /** Last chat-template validation failure reason, null when OK (P1.8). */
  templateWarning: string | null = null
  /** The checkpoint cost model this manager derives --cache-ram from. Public so the launch line and tests can name its source. */
  readonly checkpointCost: CheckpointCostModel
  private calibrator: CheckpointCalibrator
  /** Called with the reason whenever a spawn is refused or the restart budget is exhausted. main.ts wires it to a governance.alert. */
  onFault?: (reason: string) => void
  /** The last pre-spawn refusal, null when the last attempt was allowed to spawn. */
  lastRefusal: string | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** A spawn-level failure (ENOENT, EACCES) for the current attempt; waitForHealth surfaces it immediately. */
  private spawnFailure: Error | null = null

  constructor(config: ProcessManagerConfig) {
    this.binaryPath = config.binaryPath
    this.port = config.port
    const storeDir = join(cyncoHome(), 'llama')
    const modelKey = basename(config.modelPath)
    // Precedence: a calibration measured on THIS machine for THIS file, then the
    // header-derived model, then the measured default with the reason it applied.
    let cost = config.checkpointCost ?? CheckpointCalibrator.loadStored(storeDir, modelKey)
    if (!cost) {
      try {
        cost = checkpointCostFromMeta(readGgufMeta(config.modelPath))
      } catch (e) {
        cost = { ...MEASURED_DEFAULT_COST, detail: `could not read ${modelKey}: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    this.checkpointCost = cost
    this.baseConfig = { ...config, checkpointCost: cost }
    this.calibrator = new CheckpointCalibrator({ model: cost, modelKey, storeDir, warn: m => console.warn(m) })
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /**
   * Ensure the server is running with correct settings.
   * Always kills stale servers on the port and starts fresh.
   */
  async ensureRunning(): Promise<void> {
    // Kill any stale llama-server on our port — on Windows, child processes
    // survive when Bun exits, leaving zombies with wrong settings.
    if (await this.isPortOccupied()) {
      console.log(`[llama-cpp] Killing stale server on port ${this.port}`)
      await this.killProcessOnPort(this.port)
      // Wait for port to free
      for (let i = 0; i < 10; i++) {
        if (!(await this.isPortOccupied())) break
        await new Promise(r => setTimeout(r, 500))
      }
    }

    await this.startProcess()
  }

  /**
   * Restart the server with a LoRA adapter loaded.
   */
  async restartWithAdapter(loraPath: string): Promise<void> {
    this.currentLoraPath = loraPath
    await this.stop()
    await this.startProcess()
  }

  /**
   * Restart the server without any LoRA adapter.
   */
  async restartWithoutAdapter(): Promise<void> {
    this.currentLoraPath = null
    await this.stop()
    await this.startProcess()
  }

  /**
   * Stop the server process.
   */
  async stop(): Promise<void> {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (!this.child) return

    const child = this.child
    this.child = null

    try {
      child.kill()
    } catch {
      // Force kill on Windows if normal kill fails
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process')
          execSync(`taskkill /F /PID ${child.pid}`, { timeout: 5000 })
        } catch {}
      }
    }

    // Wait briefly for process to exit
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 3000)
      child.on('exit', () => { clearTimeout(timeout); resolve() })
    })
  }

  /**
   * Measure what the box can give and refuse, with the reason, when it cannot
   * give what this launch needs. Runs before EVERY spawn — first boot, adapter
   * swaps and crash restarts alike — so a machine out of commit charge is told
   * so once, instead of six times as exit code 9 (F140).
   */
  private async preSpawnCheck(): Promise<SpawnCheck> {
    if (this.baseConfig.preSpawnCheck) return this.baseConfig.preSpawnCheck()
    const [host, gpu0] = await Promise.all([readHostMemory(), readGpuMemory()])
    let fileBytes = 0
    try { fileBytes = statSync(this.baseConfig.modelPath).size } catch (e) {
      console.log(`[llama-cpp] model size unknown (${e instanceof Error ? e.message : String(e)}); no VRAM floor for this check`)
    }
    const req = spawnRequirementFor({ ctxSize: this.baseConfig.ctxSize ?? DEFAULT_CTX_SIZE, modelFileBytes: fileBytes, cost: this.checkpointCost })
    let check = evaluateSpawn(host, gpu0, req)
    if (check.ok) return check
    if (/VRAM/.test(check.reason)) {
      // A server that just died releases its VRAM a beat after the process ends.
      await new Promise(r => setTimeout(r, GPU_RECHECK_DELAY_MS))
      check = evaluateSpawn(host, await readGpuMemory(), req)
      if (check.ok) return check
    }
    // Only pay for the process listing when we are about to refuse.
    return evaluateSpawn(host, gpu0, req, await topCommitConsumers())
  }

  private async startProcess(): Promise<void> {
    const check = await this.preSpawnCheck()
    if (!check.ok) {
      this.lastRefusal = check.reason
      console.error(`[llama-cpp] REFUSING to start llama-server: ${check.reason}`)
      this.onFault?.(check.reason)
      throw new ServerStartError(this.port, `refused: ${check.reason}`)
    }
    this.lastRefusal = null

    const args = buildServerArgs({
      ...this.baseConfig,
      loraPath: this.currentLoraPath ?? undefined,
    })

    console.log(`[llama-cpp] Starting: ${this.binaryPath} ${args.join(' ')}`)
    console.log(
      `[llama-cpp] checkpoint cost: ${this.checkpointCost.baseMib.toFixed(1)} MiB + ${this.checkpointCost.kibPerToken.toFixed(2)} KiB/token ` +
      `(${this.checkpointCost.source}: ${this.checkpointCost.detail})`,
    )

    // Add llama-server's directory to PATH so CUDA DLLs (cublas, cudart) are found
    const path = require('path')
    const binDir = path.dirname(this.binaryPath)
    const env = { ...process.env }
    if (env.PATH && !env.PATH.includes(binDir)) {
      env.PATH = `${binDir}${path.delimiter}${env.PATH}`
    }

    this.spawnFailure = null
    this.child = spawn(this.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    })
    // Without a listener a spawn error is an uncaught exception; with one it is
    // a ServerStartError from waitForHealth, carrying the real cause.
    this.child.on('error', (err: Error) => {
      this.spawnFailure = err
      console.error(`[llama-cpp] spawn failed: ${err.message}`)
    })

    // Log stderr for diagnostics + parse eval tok/s
    this.child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) console.log(`[llama-server] ${line}`)
      // Parse "eval time = ... tokens per second" from llama-server timing output
      const evalMatch = line.match(/\|\s+eval time\s+=\s+[\d.]+ ms\s+\/\s+\d+ tokens\s+\(\s*[\d.]+ ms per token,\s+([\d.]+) tokens per second\)/)
      if (evalMatch && this.onEvalTokPerSec) {
        this.onEvalTokPerSec(parseFloat(evalMatch[1]))
      }
      // Hold the derived checkpoint cost to what the server actually reports.
      this.calibrator.observe(line)
    })

    // Handle unexpected exit. `spawned` pins the identity of *this* process:
    // stop() clears (or replaces) this.child before killing, so a handle that
    // no longer points at us means the exit was ours to cause.
    const spawned = this.child
    this.child.on('exit', (code) => {
      const deliberate = this.child !== spawned
      if (!deliberate) this.child = null

      const now = Date.now()
      const recentRestarts = recentRestartCount(this.restartTimes, now, RESTART_WINDOW_MS)
      console.log(
        `[llama-cpp] llama-server exited with code ${code}${deliberate ? ' (stopped on purpose)' : ''}`,
      )

      if (!shouldRestartAfterExit({ deliberate, recentRestarts, maxRestarts: MAX_RESTARTS_IN_WINDOW })) {
        if (!deliberate) {
          const reason = `llama-server cannot stay up: ${recentRestarts} restarts in the last ${RESTART_WINDOW_MS / 1000}s ` +
            `exhaust the budget of ${MAX_RESTARTS_IN_WINDOW} — a fault, not a stall`
          console.error(`[llama-cpp] NOT restarting — ${reason}`)
          this.onFault?.(reason)
        }
        return
      }

      this.restartTimes.push(now)
      const delay = restartDelayMs(recentRestarts)
      console.log(
        `[llama-cpp] restarting llama-server in ${delay / 1000}s (${recentRestarts + 1}/${MAX_RESTARTS_IN_WINDOW} in window)`,
      )
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.startProcess().catch(err => {
          console.error(`[llama-cpp] restart failed: ${err instanceof Error ? err.message : String(err)}`)
          // A refusal is not a crash: hand the budget entry back and look again
          // after the longest backoff, until the window itself has expired.
          if (this.lastRefusal) {
            this.restartTimes.pop()
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null
              this.startProcess().catch(e2 => console.error(`[llama-cpp] restart failed again: ${e2 instanceof Error ? e2.message : String(e2)}`))
            }, REFUSAL_RECHECK_MS)
          }
        })
      }, delay)
    })

    // Wait for health check
    await this.waitForHealth()

    // Template validation (P1.8) — warn loudly, never block startup.
    const templateCheck = await validateChatTemplate(`http://127.0.0.1:${this.port}`)
    this.templateWarning = templateCheck.ok ? null : (templateCheck.reason ?? 'unknown')
    if (!templateCheck.ok) {
      console.log(`[llama-cpp] WARNING: chat template validation failed: ${templateCheck.reason}`)
    } else {
      console.log(`[llama-cpp] Chat template supports native tool calls`)
    }
  }

  private async waitForHealth(
    timeoutMs = Number(process.env.LOCALCODE_LLAMA_HEALTH_TIMEOUT_MS) || 300000,
  ): Promise<void> {
    const start = Date.now()
    const url = `http://127.0.0.1:${this.port}/health`

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) })
        if (resp.ok) {
          console.log(`[llama-cpp] Server healthy on port ${this.port}`)
          return
        }
      } catch {
        // Not ready yet
      }

      // Check if process died, or never started
      if (this.spawnFailure) {
        throw new ServerStartError(this.port, `spawn failed: ${this.spawnFailure.message}`)
      }
      if (this.child && this.child.exitCode !== null) {
        throw new ServerStartError(this.port, `Process exited with code ${this.child.exitCode}`)
      }

      await new Promise(r => setTimeout(r, 500))
    }

    throw new ServerStartError(this.port, `Health check timed out after ${timeoutMs}ms`)
  }

  private async isPortOccupied(): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  private async killProcessOnPort(port: number): Promise<void> {
    if (process.platform !== 'win32') {
      try {
        const { execSync } = require('child_process')
        execSync(`fuser -k ${port}/tcp`, { timeout: 5000 })
      } catch {}
      return
    }

    // Windows: find PID listening on port, then kill it
    try {
      const { execSync } = require('child_process')
      const result = execSync('netstat -ano', { timeout: 5000, encoding: 'utf-8' })
      for (const line of result.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && /^\d+$/.test(pid)) {
            try {
              execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 })
              console.log(`[llama-cpp] Killed stale process PID ${pid} on port ${port}`)
            } catch {}
          }
        }
      }
    } catch {}
  }
}
