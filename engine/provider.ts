/**
 * Provider interface and capability types for LocalCode.
 *
 * This is the abstraction layer between the conversation engine and
 * the underlying model backend. Currently only OllamaProvider implements
 * this, but the interface allows future backends.
 */

import type { CompletionResponse, Message, StreamEvent, TokenUsage, ToolDefinition } from './types.js'

// ─── Capability Types ────────────────────────────────────────────

export type ToolUseCapability = 'native' | 'simulated' | 'none'
export type ThinkingCapability = 'native' | 'simulated' | 'none'
export type CapabilityTier = 'basic' | 'standard' | 'advanced'

export type ModelCapabilities = {
  tier: CapabilityTier
  toolUse: ToolUseCapability
  thinking: ThinkingCapability
  vision: boolean
  jsonMode: boolean
  contextLength: number
  streaming: boolean
}

export type ModelInfo = {
  name: string
  size_bytes?: number
  parameter_count?: string
  context_length?: number
  family?: string
  quantization?: string
  capabilities: ModelCapabilities
}

export type PullProgress = {
  status: string
  completed?: number
  total?: number
}

// ─── Request Types ───────────────────────────────────────────────

export type CompletionRequest = {
  model: string
  messages: Message[]
  system?: string
  tools?: ToolDefinition[]
  max_tokens?: number
  temperature?: number
  stop_sequences?: string[]
  thinking?: { enabled: boolean; budget_tokens?: number }
}

// ─── Provider Interface ──────────────────────────────────────────

export interface Provider {
  name: string
  listModels(): Promise<ModelInfo[]>
  pullModel?(name: string): AsyncIterable<PullProgress>
  probeCapabilities(model: string): Promise<ModelCapabilities>
  complete(request: CompletionRequest): Promise<CompletionResponse>
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>
  healthCheck(): Promise<boolean>
  /** Load a LoRA adapter by name (e.g., 's3-lora'). Optional — not all backends support this. */
  loadAdapter?(adapterId: string): Promise<void>
  /** Unload the current LoRA adapter. */
  unloadAdapter?(): Promise<void>
  /** Return the currently loaded adapter ID, or null if none. */
  activeAdapter?(): string | null
}

// ─── Tier Derivation ─────────────────────────────────────────────

/**
 * Derive capability tier from tool use and thinking capabilities.
 * Tier is driven by tool use — thinking is secondary.
 */
export function deriveTier(
  toolUse: ToolUseCapability,
  thinking: ThinkingCapability,
): CapabilityTier {
  if (toolUse === 'native') return 'advanced'
  if (toolUse === 'simulated') return 'standard'
  return 'basic'
}
