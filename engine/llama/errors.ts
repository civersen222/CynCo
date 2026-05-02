/**
 * Error types for the llama-cpp provider.
 *
 * Each error includes actionable messages to help users diagnose
 * and fix common issues with local llama.cpp model serving.
 */

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

// ─── Type Guards ─────────────────────────────────────────────────

export function isBinaryNotFoundError(err: unknown): err is BinaryNotFoundError {
  return err instanceof BinaryNotFoundError
}

export function isModelNotFoundError(err: unknown): err is ModelNotFoundError {
  return err instanceof ModelNotFoundError
}
