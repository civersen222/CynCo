# LlamaCppProvider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ollama as the default inference backend with llama.cpp's `llama-server`, giving full control over inference parameters and enabling LoRA adapter hot-swap.

**Architecture:** A new `LlamaCppProvider` that manages llama-server as a child process, auto-downloads the binary, resolves GGUF model files, and supports dual-machine adapter routing. Reuses the existing OpenAI-compatible format layer (`format.ts`, `simulated.ts`, `probe.ts`). Ollama remains as fallback via `LOCALCODE_PROVIDER=ollama`.

**Tech Stack:** TypeScript (Bun runtime), bun:test, llama.cpp llama-server, OpenAI-compatible API

**Spec:** `docs/superpowers/specs/2026-05-02-llama-cpp-provider-design.md`

---

### Task 1: Error Types

**Files:**
- Create: `engine/llama/errors.ts`
- Test: `engine/__tests__/llama/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/llama/errors.test.ts
import { describe, expect, it } from 'bun:test'
import {
  BinaryNotFoundError,
  ModelNotFoundError,
  ServerStartError,
  AdapterNotFoundError,
  isBinaryNotFoundError,
  isModelNotFoundError,
} from '../../llama/errors.js'

describe('llama errors', () => {
  it('BinaryNotFoundError includes resolution paths', () => {
    const err = new BinaryNotFoundError(['/a/llama-server', '/b/llama-server'])
    expect(err.message).toContain('llama-server')
    expect(err.message).toContain('/a/llama-server')
    expect(err.searchedPaths).toHaveLength(2)
    expect(err.name).toBe('BinaryNotFoundError')
  })

  it('ModelNotFoundError includes model name and directory', () => {
    const err = new ModelNotFoundError('qwen3.6', '/home/user/.cynco/models/qwen3.6')
    expect(err.message).toContain('qwen3.6')
    expect(err.message).toContain('.cynco/models')
    expect(err.model).toBe('qwen3.6')
    expect(err.name).toBe('ModelNotFoundError')
  })

  it('ServerStartError includes port and reason', () => {
    const err = new ServerStartError(8081, 'CUDA not found')
    expect(err.message).toContain('8081')
    expect(err.message).toContain('CUDA not found')
    expect(err.port).toBe(8081)
    expect(err.name).toBe('ServerStartError')
  })

  it('AdapterNotFoundError includes adapter name', () => {
    const err = new AdapterNotFoundError('s3-lora', '/home/user/.cynco/adapters/s3-lora.gguf')
    expect(err.message).toContain('s3-lora')
    expect(err.adapterName).toBe('s3-lora')
    expect(err.name).toBe('AdapterNotFoundError')
  })

  it('type guards work', () => {
    const binErr = new BinaryNotFoundError([])
    const modelErr = new ModelNotFoundError('x', '/y')
    expect(isBinaryNotFoundError(binErr)).toBe(true)
    expect(isBinaryNotFoundError(modelErr)).toBe(false)
    expect(isModelNotFoundError(modelErr)).toBe(true)
    expect(isModelNotFoundError(new Error('nope'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/llama/errors.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// engine/llama/errors.ts
export class BinaryNotFoundError extends Error {
  readonly name = 'BinaryNotFoundError' as const
  readonly searchedPaths: string[]

  constructor(searchedPaths: string[]) {
    const pathList = searchedPaths.length > 0
      ? `\nSearched:\n${searchedPaths.map(p => `  - ${p}`).join('\n')}`
      : ''
    super(
      `llama-server binary not found.${pathList}\n` +
      `Set LOCALCODE_LLAMA_SERVER to the path, or let LocalCode download it automatically.`
    )
    this.searchedPaths = searchedPaths
  }
}

export class ModelNotFoundError extends Error {
  readonly name = 'ModelNotFoundError' as const
  readonly model: string

  constructor(model: string, searchDir: string) {
    super(
      `No GGUF found for '${model}'. Download one to ${searchDir}/ or set LOCALCODE_MODEL_PATH.`
    )
    this.model = model
  }
}

export class ServerStartError extends Error {
  readonly name = 'ServerStartError' as const
  readonly port: number

  constructor(port: number, reason: string) {
    super(`Failed to start llama-server on port ${port}: ${reason}`)
    this.port = port
  }
}

export class AdapterNotFoundError extends Error {
  readonly name = 'AdapterNotFoundError' as const
  readonly adapterName: string

  constructor(adapterName: string, expectedPath: string) {
    super(`LoRA adapter '${adapterName}' not found at ${expectedPath}`)
    this.adapterName = adapterName
  }
}

export function isBinaryNotFoundError(err: unknown): err is BinaryNotFoundError {
  return err instanceof BinaryNotFoundError
}

export function isModelNotFoundError(err: unknown): err is ModelNotFoundError {
  return err instanceof ModelNotFoundError
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/llama/errors.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 5: Commit**

```bash
git add engine/llama/errors.ts engine/__tests__/llama/errors.test.ts
git commit -m "feat(llama): add error types for llama-cpp provider"
```

---

### Task 2: Model Resolver

**Files:**
- Create: `engine/llama/modelResolver.ts`
- Test: `engine/__tests__/llama/modelResolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/llama/modelResolver.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveModel, resolveAdapter } from '../../llama/modelResolver.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('resolveModel', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns explicit MODEL_PATH when set', () => {
    const ggufPath = path.join(tmpDir, 'my-model.gguf')
    fs.writeFileSync(ggufPath, 'fake-gguf')
    const result = resolveModel('anything', tmpDir, ggufPath)
    expect(result).toBe(ggufPath)
  })

  it('throws if explicit MODEL_PATH does not exist', () => {
    expect(() => resolveModel('x', tmpDir, '/nonexistent/model.gguf'))
      .toThrow('does not exist')
  })

  it('finds GGUF in model subdirectory', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    const ggufPath = path.join(modelDir, 'qwen3.6-Q4_K_M.gguf')
    fs.writeFileSync(ggufPath, 'x'.repeat(100))
    const result = resolveModel('qwen3.6', tmpDir)
    expect(result).toBe(ggufPath)
  })

  it('picks largest GGUF when multiple exist', () => {
    const modelDir = path.join(tmpDir, 'qwen3.6')
    fs.mkdirSync(modelDir, { recursive: true })
    const small = path.join(modelDir, 'qwen3.6-Q2_K.gguf')
    const large = path.join(modelDir, 'qwen3.6-Q4_K_M.gguf')
    fs.writeFileSync(small, 'x'.repeat(50))
    fs.writeFileSync(large, 'x'.repeat(200))
    const result = resolveModel('qwen3.6', tmpDir)
    expect(result).toBe(large)
  })

  it('throws ModelNotFoundError when no GGUF found', () => {
    expect(() => resolveModel('nonexistent', tmpDir))
      .toThrow("No GGUF found for 'nonexistent'")
  })

  it('throws when model dir exists but has no GGUF files', () => {
    const modelDir = path.join(tmpDir, 'empty-model')
    fs.mkdirSync(modelDir, { recursive: true })
    fs.writeFileSync(path.join(modelDir, 'readme.txt'), 'not a gguf')
    expect(() => resolveModel('empty-model', tmpDir))
      .toThrow("No GGUF found for 'empty-model'")
  })
})

describe('resolveAdapter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-adapter-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves adapter by name', () => {
    const adapterPath = path.join(tmpDir, 's3-lora.gguf')
    fs.writeFileSync(adapterPath, 'fake-adapter')
    const result = resolveAdapter('s3-lora', tmpDir)
    expect(result).toBe(adapterPath)
  })

  it('throws AdapterNotFoundError when missing', () => {
    expect(() => resolveAdapter('nonexistent', tmpDir))
      .toThrow("LoRA adapter 'nonexistent' not found")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/llama/modelResolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// engine/llama/modelResolver.ts
import * as fs from 'fs'
import * as path from 'path'
import { ModelNotFoundError, AdapterNotFoundError } from './errors.js'

/**
 * Resolve a model name to a GGUF file path.
 *
 * Resolution order:
 * 1. Explicit modelPath (LOCALCODE_MODEL_PATH) — wins outright
 * 2. modelsDir/<modelName>/*.gguf — pick largest file
 * 3. Error with download instructions
 */
export function resolveModel(
  modelName: string,
  modelsDir: string,
  modelPath?: string,
): string {
  // 1. Explicit path override
  if (modelPath) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(`LOCALCODE_MODEL_PATH does not exist: ${modelPath}`)
    }
    return modelPath
  }

  // 2. Scan modelsDir/<modelName>/*.gguf
  const modelDir = path.join(modelsDir, modelName)
  if (!fs.existsSync(modelDir)) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  const entries = fs.readdirSync(modelDir)
  const ggufs = entries
    .filter(f => f.endsWith('.gguf'))
    .map(f => {
      const fullPath = path.join(modelDir, f)
      const stat = fs.statSync(fullPath)
      return { path: fullPath, size: stat.size }
    })
    .sort((a, b) => b.size - a.size) // largest first

  if (ggufs.length === 0) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  return ggufs[0].path
}

/**
 * Resolve an adapter name to a GGUF file path.
 * Looks for <adaptersDir>/<name>.gguf
 */
export function resolveAdapter(
  adapterName: string,
  adaptersDir: string,
): string {
  const adapterPath = path.join(adaptersDir, `${adapterName}.gguf`)
  if (!fs.existsSync(adapterPath)) {
    throw new AdapterNotFoundError(adapterName, adapterPath)
  }
  return adapterPath
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/llama/modelResolver.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Commit**

```bash
git add engine/llama/modelResolver.ts engine/__tests__/llama/modelResolver.test.ts
git commit -m "feat(llama): add GGUF model + adapter resolver"
```

---

### Task 3: Binary Manager

**Files:**
- Create: `engine/llama/binaryManager.ts`
- Test: `engine/__tests__/llama/binaryManager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/llama/binaryManager.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveBinary, getVersionInfo, LLAMA_SERVER_BINARY } from '../../llama/binaryManager.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('resolveBinary', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-bin-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns explicit env path when set and file exists', () => {
    const binPath = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(binPath, 'fake-binary')
    const result = resolveBinary(binPath, tmpDir)
    expect(result).toBe(binPath)
  })

  it('throws when explicit env path does not exist', () => {
    expect(() => resolveBinary('/nonexistent/llama-server.exe', tmpDir))
      .toThrow('does not exist')
  })

  it('returns cynco bin path when binary exists there', () => {
    const binPath = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(binPath, 'fake-binary')
    const result = resolveBinary(undefined, tmpDir)
    expect(result).toBe(binPath)
  })

  it('returns null when binary not found anywhere', () => {
    const result = resolveBinary(undefined, tmpDir)
    expect(result).toBeNull()
  })

  it('LLAMA_SERVER_BINARY is llama-server.exe on Windows', () => {
    if (process.platform === 'win32') {
      expect(LLAMA_SERVER_BINARY).toBe('llama-server.exe')
    } else {
      expect(LLAMA_SERVER_BINARY).toBe('llama-server')
    }
  })
})

describe('getVersionInfo', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-ver-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no version.json exists', () => {
    expect(getVersionInfo(tmpDir)).toBeNull()
  })

  it('reads version info from version.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'version.json'),
      JSON.stringify({ version: 'b5432', downloadedAt: '2026-05-02T10:00:00Z' })
    )
    const info = getVersionInfo(tmpDir)
    expect(info).not.toBeNull()
    expect(info!.version).toBe('b5432')
    expect(info!.downloadedAt).toBe('2026-05-02T10:00:00Z')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/llama/binaryManager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// engine/llama/binaryManager.ts
import * as fs from 'fs'
import * as path from 'path'

export const LLAMA_SERVER_BINARY = process.platform === 'win32'
  ? 'llama-server.exe'
  : 'llama-server'

export type VersionInfo = {
  version: string
  downloadedAt: string
}

/**
 * Resolve the llama-server binary path.
 *
 * Resolution order:
 * 1. Explicit envPath (LOCALCODE_LLAMA_SERVER) — must exist
 * 2. binDir/llama-server[.exe] (e.g., ~/.cynco/bin/)
 * 3. null — caller should trigger download or fall back
 */
export function resolveBinary(
  envPath: string | undefined,
  binDir: string,
): string | null {
  // 1. Explicit path
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`LOCALCODE_LLAMA_SERVER does not exist: ${envPath}`)
    }
    return envPath
  }

  // 2. ~/.cynco/bin/
  const cyncoBin = path.join(binDir, LLAMA_SERVER_BINARY)
  if (fs.existsSync(cyncoBin)) {
    return cyncoBin
  }

  // 3. Not found
  return null
}

/**
 * Read version info from binDir/version.json.
 */
export function getVersionInfo(binDir: string): VersionInfo | null {
  const versionPath = path.join(binDir, 'version.json')
  try {
    const raw = fs.readFileSync(versionPath, 'utf-8')
    return JSON.parse(raw) as VersionInfo
  } catch {
    return null
  }
}

/**
 * Write version info after a successful download.
 */
export function writeVersionInfo(binDir: string, version: string): void {
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, 'version.json'),
    JSON.stringify({ version, downloadedAt: new Date().toISOString() }, null, 2),
  )
}

/**
 * Download llama-server from llama.cpp GitHub releases.
 *
 * 1. Query GitHub API for latest release
 * 2. Find asset matching platform (win-cuda-x64)
 * 3. Download and extract llama-server binary
 * 4. Write version.json
 *
 * Returns the path to the downloaded binary.
 */
export async function downloadBinary(
  binDir: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const log = onProgress ?? console.log

  log('[llama-cpp] Querying GitHub for latest llama.cpp release...')
  const releaseResp = await fetch(
    'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest',
    { headers: { 'Accept': 'application/vnd.github.v3+json' } },
  )
  if (!releaseResp.ok) {
    throw new Error(`GitHub API returned ${releaseResp.status}: ${await releaseResp.text()}`)
  }
  const release = await releaseResp.json() as {
    tag_name: string
    assets: Array<{ name: string; browser_download_url: string }>
  }

  // Find the right asset for this platform
  const assetPattern = process.platform === 'win32'
    ? /llama-.*-bin-win-cuda-.*-x64\.zip/
    : /llama-.*-bin-ubuntu-.*-x64\.tar\.gz/
  const asset = release.assets.find(a => assetPattern.test(a.name))
  if (!asset) {
    const available = release.assets.map(a => a.name).join(', ')
    throw new Error(
      `No matching llama-server binary found in release ${release.tag_name}. ` +
      `Pattern: ${assetPattern}. Available: ${available}`
    )
  }

  log(`[llama-cpp] Downloading ${asset.name} (${release.tag_name})...`)
  const downloadResp = await fetch(asset.browser_download_url)
  if (!downloadResp.ok) {
    throw new Error(`Download failed: ${downloadResp.status}`)
  }
  const arrayBuffer = await downloadResp.arrayBuffer()
  const zipPath = path.join(binDir, asset.name)

  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(zipPath, Buffer.from(arrayBuffer))

  log(`[llama-cpp] Extracting ${LLAMA_SERVER_BINARY}...`)

  // Extract using system tools
  const destPath = path.join(binDir, LLAMA_SERVER_BINARY)
  if (process.platform === 'win32') {
    // Use PowerShell to extract on Windows
    const { execSync } = require('child_process')
    const extractDir = path.join(binDir, '_extract')
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { timeout: 60000 },
    )
    // Find llama-server.exe in extracted contents (may be nested)
    const found = findFileRecursive(extractDir, LLAMA_SERVER_BINARY)
    if (!found) {
      throw new Error(`${LLAMA_SERVER_BINARY} not found in extracted archive`)
    }
    fs.copyFileSync(found, destPath)
    // Also copy DLLs that llama-server needs (CUDA, etc.)
    const extractedDir = path.dirname(found)
    for (const f of fs.readdirSync(extractedDir)) {
      if (f.endsWith('.dll')) {
        fs.copyFileSync(path.join(extractedDir, f), path.join(binDir, f))
      }
    }
    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true })
  } else {
    const { execSync } = require('child_process')
    execSync(`tar xzf '${zipPath}' -C '${binDir}'`, { timeout: 60000 })
    const found = findFileRecursive(binDir, LLAMA_SERVER_BINARY)
    if (found && found !== destPath) {
      fs.renameSync(found, destPath)
      fs.chmodSync(destPath, 0o755)
    }
  }

  // Cleanup archive
  fs.rmSync(zipPath, { force: true })

  writeVersionInfo(binDir, release.tag_name)
  log(`[llama-cpp] Downloaded llama-server ${release.tag_name} to ${binDir}`)

  return destPath
}

function findFileRecursive(dir: string, filename: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename)
      if (found) return found
    } else if (entry.name === filename) {
      return full
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/llama/binaryManager.test.ts`
Expected: PASS — all 6 tests (the download function is not unit-tested — it hits the network)

- [ ] **Step 5: Commit**

```bash
git add engine/llama/binaryManager.ts engine/__tests__/llama/binaryManager.test.ts
git commit -m "feat(llama): add binary manager — resolve, version, download llama-server"
```

---

### Task 4: Process Manager

**Files:**
- Create: `engine/llama/processManager.ts`
- Test: `engine/__tests__/llama/processManager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/llama/processManager.test.ts
import { describe, expect, it } from 'bun:test'
import { buildServerArgs, ProcessManager } from '../../llama/processManager.js'

describe('buildServerArgs', () => {
  it('builds default args', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(args).toContain('--model')
    expect(args).toContain('/models/qwen.gguf')
    expect(args).toContain('--port')
    expect(args).toContain('8081')
    expect(args).toContain('--n-gpu-layers')
    expect(args).toContain('999')
    expect(args).toContain('--flash-attn')
    expect(args).toContain('--ctx-size')
    expect(args).toContain('32768')
    expect(args).toContain('--batch-size')
    expect(args).toContain('2048')
    expect(args).toContain('--host')
    expect(args).toContain('127.0.0.1')
  })

  it('respects custom config', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 9090,
      ctxSize: 65536,
      batchSize: 4096,
      gpuLayers: 40,
      flashAttn: false,
      threads: 8,
    })
    expect(args).toContain('9090')
    expect(args).toContain('65536')
    expect(args).toContain('4096')
    expect(args).toContain('40')
    expect(args).not.toContain('--flash-attn')
    expect(args).toContain('--threads')
    expect(args).toContain('8')
  })

  it('adds --lora flag when adapter specified', () => {
    const args = buildServerArgs({
      modelPath: '/models/qwen.gguf',
      port: 8081,
      loraPath: '/adapters/s3-lora.gguf',
    })
    expect(args).toContain('--lora')
    expect(args).toContain('/adapters/s3-lora.gguf')
  })
})

describe('ProcessManager', () => {
  it('constructs with config', () => {
    const pm = new ProcessManager({
      binaryPath: '/bin/llama-server',
      modelPath: '/models/qwen.gguf',
      port: 8081,
    })
    expect(pm.port).toBe(8081)
    expect(pm.isRunning()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/llama/processManager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
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

  if (config.flashAttn !== false) {
    args.push('--flash-attn')
  }

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

    this.child = spawn(this.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/llama/processManager.test.ts`
Expected: PASS — all 4 tests

- [ ] **Step 5: Commit**

```bash
git add engine/llama/processManager.ts engine/__tests__/llama/processManager.test.ts
git commit -m "feat(llama): add process manager — start/stop/restart llama-server"
```

---

### Task 5: LlamaCppProvider

**Files:**
- Create: `engine/llama/provider.ts`
- Test: `engine/__tests__/llama/provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/llama/provider.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { LlamaCppProvider } from '../../llama/provider.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('LlamaCppProvider', () => {
  it('has correct name', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.name).toBe('llama-cpp')
  })

  it('getBaseUrl returns primary when no adapter active', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.getBaseUrl()).toBe('http://127.0.0.1:8081')
  })

  it('activeAdapter returns null by default', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.activeAdapter()).toBeNull()
  })

  it('getBaseUrl returns adapterUrl when adapter is active and URL configured', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      adapterUrl: 'http://192.168.1.50:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    // Simulate adapter being active by calling the internal setter
    p._setActiveAdapter('s3-lora')
    expect(p.getBaseUrl()).toBe('http://192.168.1.50:8081')
    expect(p.activeAdapter()).toBe('s3-lora')
  })

  it('getBaseUrl returns primary after unloadAdapter', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      adapterUrl: 'http://192.168.1.50:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    p._setActiveAdapter('s3-lora')
    expect(p.getBaseUrl()).toBe('http://192.168.1.50:8081')
    p._clearActiveAdapter()
    expect(p.getBaseUrl()).toBe('http://127.0.0.1:8081')
    expect(p.activeAdapter()).toBeNull()
  })

  it('listModels scans modelsDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-list-'))
    try {
      // Create two model dirs
      fs.mkdirSync(path.join(tmpDir, 'qwen3.6'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'qwen3.6', 'model.gguf'), 'x')
      fs.mkdirSync(path.join(tmpDir, 'llama3'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'llama3', 'model.gguf'), 'x')

      const p = new LlamaCppProvider({
        primaryUrl: 'http://127.0.0.1:8081',
        modelName: 'qwen3.6',
        modelsDir: tmpDir,
      })

      const models = p.listModelsSync()
      expect(models).toHaveLength(2)
      const names = models.map(m => m.name)
      expect(names).toContain('qwen3.6')
      expect(names).toContain('llama3')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getCompletionsUrl uses getBaseUrl', () => {
    const p = new LlamaCppProvider({
      primaryUrl: 'http://127.0.0.1:8081',
      modelName: 'qwen3.6',
      modelsDir: '/fake/models',
    })
    expect(p.getCompletionsUrl()).toBe('http://127.0.0.1:8081/v1/chat/completions')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test engine/__tests__/llama/provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// engine/llama/provider.ts
import type {
  Provider, CompletionRequest, ModelCapabilities, ModelInfo, PullProgress,
} from '../provider.js'
import type { CompletionResponse, StreamEvent } from '../types.js'
import {
  toOpenAIMessages, toOpenAITools, fromOpenAIResponse,
  fromOpenAIStreamChunk, parseSSELine,
} from '../ollama/format.js'
import { resolveCapabilities } from '../ollama/probe.js'
import type { ProcessManager } from './processManager.js'
import { resolveAdapter } from './modelResolver.js'
import * as fs from 'fs'
import * as path from 'path'

export type LlamaCppProviderConfig = {
  primaryUrl: string
  adapterUrl?: string
  modelName: string
  modelsDir: string
  adaptersDir?: string
  processManager?: ProcessManager
}

export class LlamaCppProvider implements Provider {
  readonly name = 'llama-cpp'
  private primaryUrl: string
  private adapterUrl: string | undefined
  private activeAdapterId: string | null = null
  private modelName: string
  private modelsDir: string
  private adaptersDir: string
  private processManager: ProcessManager | undefined

  constructor(config: LlamaCppProviderConfig) {
    this.primaryUrl = config.primaryUrl.replace(/\/$/, '')
    this.adapterUrl = config.adapterUrl?.replace(/\/$/, '')
    this.modelName = config.modelName
    this.modelsDir = config.modelsDir
    this.adaptersDir = config.adaptersDir ?? path.join(path.dirname(config.modelsDir), 'adapters')
    this.processManager = config.processManager
  }

  // ─── URL routing ─────────────────────────────────────────────

  getBaseUrl(): string {
    if (this.activeAdapterId && this.adapterUrl) {
      return this.adapterUrl
    }
    return this.primaryUrl
  }

  getCompletionsUrl(): string {
    return `${this.getBaseUrl()}/v1/chat/completions`
  }

  // Test helpers for adapter state (not part of Provider interface)
  _setActiveAdapter(id: string): void { this.activeAdapterId = id }
  _clearActiveAdapter(): void { this.activeAdapterId = null }

  // ─── Provider interface ──────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.getBaseUrl()}/health`, {
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.listModelsSync()
  }

  listModelsSync(): ModelInfo[] {
    try {
      const entries = fs.readdirSync(this.modelsDir, { withFileTypes: true })
      return entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const modelDir = path.join(this.modelsDir, e.name)
          const files = fs.readdirSync(modelDir)
          return files.some(f => f.endsWith('.gguf'))
        })
        .map(e => ({
          name: e.name,
          capabilities: resolveCapabilities(e.name),
        }))
    } catch {
      return []
    }
  }

  async probeCapabilities(model: string): Promise<ModelCapabilities> {
    return resolveCapabilities(model)
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request, false)
    const resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const oai = await resp.json()
    return fromOpenAIResponse(oai as any)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request, true)

    const resp = await fetch(this.getCompletionsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    yield {
      type: 'message_start',
      message: { id: '', model: request.model, usage: { input_tokens: 0, output_tokens: 0 } },
    }

    const reader = resp.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = parseSSELine(trimmed)
        if (parsed === null) break // [DONE]
        if (parsed === undefined) continue
        const events = fromOpenAIStreamChunk(parsed as any)
        for (const event of events) yield event
      }
    }

    yield { type: 'message_stop' }
  }

  // ─── Adapter methods ─────────────────────────────────────────

  async loadAdapter(adapterId: string): Promise<void> {
    if (this.adapterUrl) {
      // Dual-machine mode: just switch URL, no restart
      this.activeAdapterId = adapterId
      console.log(`[llama-cpp] Routed adapter '${adapterId}' to ${this.adapterUrl}`)
      return
    }

    // Single-machine mode: restart server with --lora
    if (!this.processManager) {
      throw new Error('Cannot load adapter: no ProcessManager configured and no LOCALCODE_ADAPTER_URL set')
    }

    const adapterPath = resolveAdapter(adapterId, this.adaptersDir)
    console.log(`[llama-cpp] Restarting server with adapter '${adapterId}'...`)
    await this.processManager.restartWithAdapter(adapterPath)
    this.activeAdapterId = adapterId
    console.log(`[llama-cpp] Adapter '${adapterId}' loaded`)
  }

  async unloadAdapter(): Promise<void> {
    if (!this.activeAdapterId) return

    if (this.adapterUrl) {
      // Dual-machine: just switch back
      this.activeAdapterId = null
      console.log(`[llama-cpp] Routed back to primary server`)
      return
    }

    // Single-machine: restart without adapter
    if (this.processManager) {
      console.log(`[llama-cpp] Restarting server without adapter...`)
      await this.processManager.restartWithoutAdapter()
    }
    this.activeAdapterId = null
  }

  activeAdapter(): string | null {
    return this.activeAdapterId
  }

  // ─── Private ─────────────────────────────────────────────────

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream,
    }

    if (request.max_tokens) body.max_tokens = request.max_tokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stop_sequences) body.stop = request.stop_sequences
    if (request.tools?.length) body.tools = toOpenAITools(request.tools)
    if (request.system) {
      body.messages = [
        { role: 'system', content: request.system },
        ...(body.messages as unknown[]),
      ]
    }

    return body
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test engine/__tests__/llama/provider.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Commit**

```bash
git add engine/llama/provider.ts engine/__tests__/llama/provider.test.ts
git commit -m "feat(llama): add LlamaCppProvider — stream, complete, adapter routing"
```

---

### Task 6: Config Changes

**Files:**
- Modify: `engine/config.ts`
- Modify: `engine/__tests__/providers/factory.test.ts`

- [ ] **Step 1: Add new config fields to `LocalCodeConfig`**

In `engine/config.ts`, add the new fields to the type and the loader:

```typescript
// Add to LocalCodeConfig type (after existing fields):
  llamaServer: string | undefined
  modelPath: string | undefined
  adapterUrl: string | undefined
  port: number
  batchSize: number
  gpuLayers: number
  flashAttn: boolean
  threads: number | undefined

// Add to loadConfig() function (before the return statement):
  // --- llama-cpp provider settings ---
  const llamaServer = process.env.LOCALCODE_LLAMA_SERVER || undefined
  const modelPath = process.env.LOCALCODE_MODEL_PATH || undefined
  const adapterUrl = process.env.LOCALCODE_ADAPTER_URL || undefined
  const port = parseInt(process.env.LOCALCODE_PORT ?? '8081', 10)
  const batchSize = parseInt(process.env.LOCALCODE_BATCH_SIZE ?? '2048', 10)
  const gpuLayers = parseInt(process.env.LOCALCODE_GPU_LAYERS ?? '999', 10)
  const flashAttn = (process.env.LOCALCODE_FLASH_ATTN ?? 'true') !== 'false'
  const threads = process.env.LOCALCODE_THREADS ? parseInt(process.env.LOCALCODE_THREADS, 10) : undefined

// Add to return object:
  llamaServer,
  modelPath,
  adapterUrl,
  port,
  batchSize,
  gpuLayers,
  flashAttn,
  threads,

// Change provider default from 'ollama' to 'llama-cpp':
  const provider = (process.env.LOCALCODE_PROVIDER ?? 'llama-cpp') as ProviderType
```

- [ ] **Step 2: Run existing config tests to verify nothing breaks**

Run: `bun test engine/__tests__/`
Expected: All existing tests still pass

- [ ] **Step 3: Commit**

```bash
git add engine/config.ts
git commit -m "feat(config): add llama-cpp provider settings, default to llama-cpp"
```

---

### Task 7: Factory + Provider Type Update

**Files:**
- Modify: `engine/providers/factory.ts`
- Modify: `engine/__tests__/providers/factory.test.ts`

- [ ] **Step 1: Update factory to create LlamaCppProvider**

In `engine/providers/factory.ts`:

```typescript
import type { Provider } from '../provider.js'
import type { LocalCodeConfig } from '../config.js'
import { OllamaProvider } from '../ollama/client.js'
import { OpenAICompatProvider } from './openaiCompat.js'
import { LlamaCppProvider } from '../llama/provider.js'

export type ProviderType = 'ollama' | 'llama-cpp' | 'lmstudio' | 'llamacpp' | 'vllm' | 'openai-compat'

export function createProvider(type: ProviderType, baseUrl: string, apiKey?: string, contextLength?: number): Provider {
  switch (type) {
    case 'ollama':
      return new OllamaProvider({ baseUrl, contextLength })
    case 'lmstudio':
      return new OpenAICompatProvider({ name: 'lmstudio', baseUrl, apiKey: apiKey ?? '' })
    case 'llamacpp':
      return new OpenAICompatProvider({ name: 'llamacpp', baseUrl, apiKey: apiKey ?? '' })
    case 'vllm':
      return new OpenAICompatProvider({ name: 'vllm', baseUrl, apiKey: apiKey ?? '' })
    case 'openai-compat':
      return new OpenAICompatProvider({ name: 'custom', baseUrl, apiKey: apiKey ?? '' })
    case 'llama-cpp':
      // LlamaCppProvider requires more config than the simple factory signature.
      // Return a placeholder — main.ts creates the real one with full config.
      // This keeps backward compat for code that calls createProvider() directly.
      return new LlamaCppProvider({
        primaryUrl: baseUrl || 'http://127.0.0.1:8081',
        modelName: 'unknown',
        modelsDir: '',
      })
    default:
      return new OllamaProvider({ baseUrl })
  }
}
```

- [ ] **Step 2: Update factory test**

In `engine/__tests__/providers/factory.test.ts`, add:

```typescript
import { LlamaCppProvider } from '../../llama/provider.js'

// Add this test:
  it('creates LlamaCppProvider for llama-cpp type', () => {
    const p = createProvider('llama-cpp', 'http://127.0.0.1:8081')
    expect(p).toBeInstanceOf(LlamaCppProvider)
    expect(p.name).toBe('llama-cpp')
  })
```

- [ ] **Step 3: Run tests**

Run: `bun test engine/__tests__/providers/factory.test.ts`
Expected: PASS — all tests including the new one

- [ ] **Step 4: Commit**

```bash
git add engine/providers/factory.ts engine/__tests__/providers/factory.test.ts
git commit -m "feat(factory): add llama-cpp provider type to factory"
```

---

### Task 8: Main.ts Startup Flow

**Files:**
- Modify: `engine/main.ts`

This is the integration wiring. The startup flow needs to branch on `LOCALCODE_PROVIDER`.

- [ ] **Step 1: Add llama-cpp startup path to main.ts**

Replace the provider creation and context length sections in `engine/main.ts`. The changes are:

1. When `config.provider === 'llama-cpp'`:
   - Wrap entire setup in try/catch — on any error, fall back to Ollama
   - Resolve binary via `BinaryManager` (download if missing)
   - Resolve model via `ModelResolver`
   - Create `ProcessManager` and call `ensureRunning()`
   - Create `LlamaCppProvider` with all config
   - Context length comes from config (set at server startup), no Ollama `/api/ps` query

2. When `config.provider === 'ollama'` (or other):
   - Existing Ollama flow unchanged

Replace the block from `// Probe model capabilities` (line 97) through `const provider = createProvider(...)` (line 146) with:

```typescript
// ─── Provider Setup ──────────────────────────────────────────
import type { Provider } from './provider.js'
import { resolveCapabilities } from './ollama/probe.js'
const modelCaps = config.model ? resolveCapabilities(config.model) : null

let provider: Provider
let contextLength: number

async function createOllamaFallback(): Promise<{ provider: Provider; contextLength: number }> {
  const contextLengthExplicit = process.env.LOCALCODE_CONTEXT_LENGTH
    ? parseInt(process.env.LOCALCODE_CONTEXT_LENGTH, 10)
    : undefined

  let ctx: number
  if (contextLengthExplicit && !Number.isNaN(contextLengthExplicit)) {
    ctx = contextLengthExplicit
    console.log(`[context] Using explicit LOCALCODE_CONTEXT_LENGTH=${ctx}`)
  } else {
    let ollamaNumCtx: number | null = null
    try {
      const resp = await fetch(`${config.baseUrl}/api/ps`)
      const data = await resp.json() as any
      const running = data.models?.find((m: any) => m.name?.startsWith(config.model?.split(':')[0] ?? ''))
      if (running?.details?.num_ctx) {
        ollamaNumCtx = running.details.num_ctx
      }
    } catch {}

    if (ollamaNumCtx) {
      ctx = ollamaNumCtx
      console.log(`[context] Detected Ollama num_ctx=${ctx} from /api/ps`)
    } else {
      const OLLAMA_DEFAULT_CTX = 32768
      const modelMax = modelCaps?.contextLength ?? OLLAMA_DEFAULT_CTX
      ctx = Math.min(modelMax, OLLAMA_DEFAULT_CTX)
      console.log(`[context] Using Ollama default ${ctx} (model theoretical max: ${modelMax})`)
    }
  }

  const { createProvider } = await import('./providers/factory.js')
  return { provider: createProvider('ollama', config.baseUrl, config.apiKey, ctx), contextLength: ctx }
}

if (config.provider === 'llama-cpp') {
  // ─── llama-cpp provider path ─────────────────────────────
  try {
    const os = require('os')
    const path = require('path')

    const cyncoDir = path.join(os.homedir(), '.cynco')
    const binDir = path.join(cyncoDir, 'bin')
    const modelsDir = path.join(cyncoDir, 'models')
    const adaptersDir = path.join(cyncoDir, 'adapters')

    // 1. Resolve llama-server binary
    const { resolveBinary, downloadBinary } = await import('./llama/binaryManager.js')
    let binaryPath = resolveBinary(config.llamaServer, binDir)
    if (!binaryPath) {
      console.log('[llama-cpp] llama-server not found — downloading...')
      binaryPath = await downloadBinary(binDir, (msg) => console.log(msg))
    }
    console.log(`[llama-cpp] Binary: ${binaryPath}`)

    // 2. Resolve GGUF model
    const { resolveModel } = await import('./llama/modelResolver.js')
    const modelPath = resolveModel(config.model ?? 'unknown', modelsDir, config.modelPath)
    console.log(`[llama-cpp] Model: ${modelPath}`)

    // 3. Start/connect to llama-server
    const { ProcessManager } = await import('./llama/processManager.js')
    const processManager = new ProcessManager({
      binaryPath,
      modelPath,
      port: config.port,
      ctxSize: config.contextLength ?? 32768,
      batchSize: config.batchSize,
      gpuLayers: config.gpuLayers,
      flashAttn: config.flashAttn,
      threads: config.threads,
    })
    await processManager.ensureRunning()

    // 4. Create provider
    const { LlamaCppProvider } = await import('./llama/provider.js')
    provider = new LlamaCppProvider({
      primaryUrl: `http://127.0.0.1:${config.port}`,
      adapterUrl: config.adapterUrl,
      modelName: config.model ?? 'unknown',
      modelsDir,
      adaptersDir,
      processManager,
    })

    contextLength = config.contextLength ?? 32768
    config.contextLength = contextLength

    // Cleanup on exit
    const cleanup = () => { processManager.stop() }
    process.on('SIGTERM', cleanup)
    process.on('SIGINT', cleanup)

  } catch (err) {
    console.error(`[llama-cpp] Setup failed: ${err instanceof Error ? err.message : err}`)
    console.log('[llama-cpp] Falling back to Ollama provider')
    const fallback = await createOllamaFallback()
    provider = fallback.provider
    contextLength = fallback.contextLength
    config.contextLength = contextLength
  }

} else {
  // ─── Ollama provider path (existing) ───────────────────────
  const fallback = await createOllamaFallback()
  provider = fallback.provider
  contextLength = fallback.contextLength
  config.contextLength = contextLength
}

console.log(`[localcode] Context budget: ${contextLength} tokens`)
```

- [ ] **Step 2: Fix the provider type import**

At the top of `engine/main.ts`, the existing import `import { createProvider } from './providers/factory.js'` should be removed since we now import conditionally inside the if/else. Add:

```typescript
import type { Provider } from './provider.js'
```

- [ ] **Step 3: Update health check message**

Near the bottom of `main.ts`, change:

```typescript
console.log(`[localcode] Ollama is reachable ✓`)
```

to:

```typescript
console.log(`[localcode] ${config.provider} is reachable`)
```

And change:

```typescript
console.error(`[localcode] ✗ Ollama NOT reachable at ${config.baseUrl}`)
```

to:

```typescript
const providerUrl = config.provider === 'llama-cpp' ? `http://127.0.0.1:${config.port}` : config.baseUrl
console.error(`[localcode] ${config.provider} NOT reachable at ${providerUrl}`)
```

- [ ] **Step 4: Run the engine to verify it starts**

Run: `LOCALCODE_PROVIDER=ollama LOCALCODE_MODEL=qwen3.6 bun engine/main.ts`
Expected: Engine starts normally with Ollama provider (regression check)

- [ ] **Step 5: Run all engine tests**

Run: `bun test engine/__tests__/`
Expected: All existing tests pass

- [ ] **Step 6: Commit**

```bash
git add engine/main.ts
git commit -m "feat(main): add llama-cpp startup path with binary/model/process management"
```

---

### Task 9: Wire Check

**Files:** None created — this is a verification-only task.

- [ ] **Step 1: Verify all new symbols are imported and used**

Run these greps to confirm nothing is orphaned:

```bash
# errors.ts exports are used
bun run -e "import './engine/llama/errors.js'" 2>&1
grep -r "from.*llama/errors" engine/ --include="*.ts" | grep -v __tests__ | grep -v node_modules

# modelResolver exports are used
grep -r "from.*llama/modelResolver" engine/ --include="*.ts" | grep -v __tests__ | grep -v node_modules

# binaryManager exports are used
grep -r "from.*llama/binaryManager" engine/ --include="*.ts" | grep -v __tests__ | grep -v node_modules

# processManager exports are used
grep -r "from.*llama/processManager" engine/ --include="*.ts" | grep -v __tests__ | grep -v node_modules

# provider.ts exports are used
grep -r "from.*llama/provider" engine/ --include="*.ts" | grep -v __tests__ | grep -v node_modules

# LlamaCppProvider is in the factory
grep "LlamaCppProvider" engine/providers/factory.ts

# New config fields are read in main.ts
grep "config.llamaServer\|config.modelPath\|config.adapterUrl\|config.port\|config.batchSize\|config.gpuLayers\|config.flashAttn\|config.threads" engine/main.ts
```

Expected: Every new module is imported by at least one non-test file. Every new config field is read in main.ts.

- [ ] **Step 2: Verify no unused imports**

```bash
# Check that format.ts, simulated.ts, probe.ts are still imported by both providers
grep "from.*ollama/format" engine/llama/provider.ts
grep "from.*ollama/probe" engine/llama/provider.ts
```

Expected: LlamaCppProvider imports from `ollama/format.ts` and `ollama/probe.ts`.

- [ ] **Step 3: Run full test suite**

```bash
bun test engine/__tests__/
```

Expected: All tests pass — old and new.

- [ ] **Step 4: Verify the directory structure matches the spec**

```bash
ls engine/llama/
```

Expected output:
```
binaryManager.ts
errors.ts
modelResolver.ts
processManager.ts
provider.ts
```

- [ ] **Step 5: Commit (if any fixups were needed)**

```bash
git add -A && git commit -m "fix: wire check fixups for llama-cpp provider"
```

Only commit if Step 1 or Step 2 revealed issues that needed fixing.
