/**
 * Error types for the Ollama provider.
 *
 * Each error includes actionable messages to help users diagnose
 * and fix common issues with local model serving.
 */

export class ConnectionError extends Error {
  readonly name = 'ConnectionError' as const
  readonly baseUrl: string

  constructor(baseUrl: string) {
    super(
      `Cannot connect to Ollama at ${baseUrl}. ` +
      `Is Ollama running? Try: ollama serve`
    )
    this.baseUrl = baseUrl
  }
}

export class ModelNotFoundError extends Error {
  readonly name = 'ModelNotFoundError' as const
  readonly model: string
  readonly available: string[]

  constructor(model: string, available: string[]) {
    const availableList = available.length > 0
      ? `\nAvailable models: ${available.join(', ')}`
      : '\nNo models currently installed.'
    super(
      `Model "${model}" not found.${availableList}\n` +
      `To install it, run: ollama pull ${model}`
    )
    this.model = model
    this.available = available
  }
}

export class ModelLoadError extends Error {
  readonly name = 'ModelLoadError' as const
  readonly model: string
  readonly reason: string

  constructor(model: string, reason: string) {
    super(`Failed to load model "${model}": ${reason}`)
    this.model = model
    this.reason = reason
  }
}

export class TimeoutError extends Error {
  readonly name = 'TimeoutError' as const
  readonly durationMs: number

  constructor(durationMs: number) {
    super(`Request timed out after ${durationMs}ms`)
    this.durationMs = durationMs
  }
}

export class GenerationError extends Error {
  readonly name = 'GenerationError' as const

  constructor(message: string, options?: { cause?: Error }) {
    super(`Generation failed: ${message}`, options)
  }
}

// ─── Type Guards ─────────────────────────────────────────────────

export function isConnectionError(err: unknown): err is ConnectionError {
  return err instanceof ConnectionError
}

export function isModelNotFoundError(err: unknown): err is ModelNotFoundError {
  return err instanceof ModelNotFoundError
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError
}
