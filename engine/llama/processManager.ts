// engine/llama/processManager.ts
import { type ChildProcess, spawn } from 'child_process'
import { ServerStartError } from './errors.js'

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
 * not proportional to them. Measured 2026-08-18 from llama-server's own
 * `create_check: ... created context checkpoint` lines on this build and model
 * (Qwen3.8-27B-NVFP4-MTP, --flash-attn on, --parallel 1):
 *
 *     22 tokens -> 149.713 MiB
 *  91867 tokens -> 510.234 MiB
 *  93911 tokens -> 518.257 MiB
 *
 * Those three points fit `149.64 MiB + 4.02 KiB/token` to within 0.02 MiB. The
 * fixed part is the hybrid model's recurrent (Gated DeltaNet) state, which is
 * the same size no matter where in the window the checkpoint sits; only the
 * attention KV slice grows with position.
 *
 * This matters because dividing ONE observation by its token count reads the
 * intercept as a slope. The F91 write-up did exactly that — "187.9 MiB at 9757
 * tokens" gives 19.7 KiB/token — and the affine model reproduces that same
 * observation as 187.94 MiB, so both descriptions fit the point they were taken
 * from. They disagree everywhere else: at 104858 tokens the proportional
 * reading predicts 2017 MiB against a measured ~561 MiB, a 3.6x over-estimate.
 */
const CHECKPOINT_BASE_MIB = 149.65
const CHECKPOINT_KIB_PER_TOKEN = 4.02

/** Host memory one context checkpoint costs at the far end of a `ctxSize` window. */
function worstCheckpointMib(ctxSize: number): number {
  return CHECKPOINT_BASE_MIB + (ctxSize * CHECKPOINT_KIB_PER_TOKEN) / 1024
}

/**
 * The host prompt-cache budget (`--cache-ram`, MiB) that a given context and
 * checkpoint count require, rounded up to a whole GiB so the number is legible
 * in the `[llama-cpp] Starting:` line.
 *
 * The rule is: the cache must hold at least ONE complete slot's worth of
 * checkpoints. Below that the cache cannot keep even a single conversation
 * whole, so it evicts the state the checkpoints exist to restore and the
 * mechanism pays its memory cost for nothing.
 *
 * Deriving it from BOTH inputs is the point. F91 was `--ctx-checkpoints` being
 * doubled to 64 while `--cache-ram` sat on llama-server's fixed 8192 MiB
 * default; 753 turns later the server logged "failed to allocate memory for
 * prompt cache state: bad allocation", exited 9, and burned its restart budget.
 * With this derivation that commit would have raised the budget with the count
 * automatically, and the pair cannot be desynchronised by editing one of them.
 *
 * `--cache-ram` is a maximum, not a reservation (llama-server: "set the maximum
 * cache size in MiB"), and it is HOST memory, not VRAM — 21504 MiB at the
 * 131072 default is a ceiling on 63.5 GiB of system RAM, filled lazily.
 */
function derivedCacheRamMib(ctxSize: number, ctxCheckpoints: number): number {
  const totalMib = worstCheckpointMib(ctxSize) * ctxCheckpoints
  return Math.max(1024, Math.ceil(totalMib / 1024) * 1024)
}

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
    : process.env.LOCALCODE_CACHE_RAM || String(derivedCacheRamMib(emittedCtxSize, ctxCheckpoints))
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

  constructor(config: ProcessManagerConfig) {
    this.binaryPath = config.binaryPath
    this.port = config.port
    this.baseConfig = config
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

  private async startProcess(): Promise<void> {
    const args = buildServerArgs({
      ...this.baseConfig,
      loraPath: this.currentLoraPath ?? undefined,
    })

    console.log(`[llama-cpp] Starting: ${this.binaryPath} ${args.join(' ')}`)

    // Add llama-server's directory to PATH so CUDA DLLs (cublas, cudart) are found
    const path = require('path')
    const binDir = path.dirname(this.binaryPath)
    const env = { ...process.env }
    if (env.PATH && !env.PATH.includes(binDir)) {
      env.PATH = `${binDir}${path.delimiter}${env.PATH}`
    }

    this.child = spawn(this.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
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
          console.error(
            `[llama-cpp] NOT restarting — ${recentRestarts} restarts in the last ` +
            `${RESTART_WINDOW_MS / 1000}s exhausts the budget of ${MAX_RESTARTS_IN_WINDOW}. ` +
            `The server cannot stay up; treat this as a fault, not a stall.`,
          )
        }
        return
      }

      this.restartTimes.push(now)
      console.log(
        `[llama-cpp] restarting llama-server (${recentRestarts + 1}/${MAX_RESTARTS_IN_WINDOW} in window)`,
      )
      this.startProcess().catch(err => {
        console.error(
          `[llama-cpp] restart failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
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

      // Check if process died
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
