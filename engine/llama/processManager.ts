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
    '--ctx-size', String(config.ctxSize ?? 32768),
    '--n-gpu-layers', String(config.gpuLayers ?? 999),
    '--batch-size', String(config.batchSize ?? 2048),
    '--ubatch-size', String(config.ubatchSize ?? envInt('LOCALCODE_UBATCH_SIZE') ?? 2048),
  ]

  args.push('--flash-attn', config.flashAttn !== false ? 'on' : 'off')

  if (config.threads != null) {
    args.push('--threads', String(config.threads))
  }

  if (config.loraPath) {
    args.push('--lora', config.loraPath)
  }

  if (config.specType) {
    args.push('--spec-type', config.specType)
    args.push('--spec-draft-n-max', String(config.specDraftN ?? 2))
  }

  // Single slot — we only process one request at a time
  args.push('--parallel', '1')
  // Qwen3.6 is a hybrid Gated DeltaNet + attention model. llama.cpp context
  // checkpoints snapshot recurrent state during prefill so warm turns roll
  // back to the nearest checkpoint instead of re-prefilling from token 0
  // (ggml-org/llama.cpp#21831). This needs the host-memory prompt cache, so
  // --cache-ram is left at the server default unless explicitly overridden.
  // NOTE: prefix reuse also requires the client prompt to be strictly
  // append-only — see engine/__tests__/engine/prefixStability.test.ts.
  const cacheRam = config.cacheRam != null
    ? String(config.cacheRam)
    : process.env.LOCALCODE_CACHE_RAM // string passthrough — value forwarded verbatim, no envInt
  if (cacheRam != null && cacheRam !== '') {
    args.push('--cache-ram', cacheRam)
  }
  args.push('--ctx-checkpoints', String(config.ctxCheckpoints ?? envInt('LOCALCODE_CTX_CHECKPOINTS') ?? 64))
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
}

export class ProcessManager {
  readonly port: number
  private binaryPath: string
  private baseConfig: ProcessManagerConfig
  private child: ChildProcess | null = null
  private currentLoraPath: string | null = null
  onEvalTokPerSec?: (tps: number) => void

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

    // Handle unexpected exit
    this.child.on('exit', (code) => {
      if (this.child) {
        console.log(`[llama-cpp] llama-server exited with code ${code}`)
        this.child = null
      }
    })

    // Wait for health check
    await this.waitForHealth()
  }

  private async waitForHealth(timeoutMs = 60000): Promise<void> {
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
