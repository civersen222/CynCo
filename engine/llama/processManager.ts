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
  ]

  args.push('--flash-attn', config.flashAttn !== false ? 'on' : 'off')

  if (config.threads != null) {
    args.push('--threads', String(config.threads))
  }

  if (config.loraPath) {
    args.push('--lora', config.loraPath)
  }

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
}

export class ProcessManager {
  readonly port: number
  private binaryPath: string
  private baseConfig: ProcessManagerConfig
  private child: ChildProcess | null = null
  private currentLoraPath: string | null = null

  constructor(config: ProcessManagerConfig) {
    this.binaryPath = config.binaryPath
    this.port = config.port
    this.baseConfig = config
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /**
   * Ensure the server is running. If port is already occupied, assume
   * an external server is running and skip. Otherwise spawn a new process.
   */
  async ensureRunning(): Promise<void> {
    // Check if port is already in use (external server)
    if (await this.isPortOccupied()) {
      console.log(`[llama-cpp] Port ${this.port} already in use — connecting to existing server`)
      return
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

    // Log stderr for diagnostics
    this.child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) console.log(`[llama-server] ${line}`)
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
}
