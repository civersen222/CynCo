/**
 * Capability probing and known model table.
 *
 * Determines what a model can do (tool use, thinking, vision, etc.)
 * by first checking a built-in table of known model families, then
 * falling back to safe defaults for unknown models.
 */

import type { ModelCapabilities, CapabilityTier, ToolUseCapability, ThinkingCapability } from '../provider.js'
import { deriveTier } from '../provider.js'

// ─── Known Model Table ───────────────────────────────────────────

type KnownEntry = {
  toolUse: ToolUseCapability
  thinking: ThinkingCapability
  vision: boolean
  contextLength: number
}

/**
 * Known model capabilities indexed by family name.
 *
 * 7 entries from the design spec + 12 plan additions for broader coverage.
 * Use Map for .get() lookups.
 */
export const KNOWN_MODEL_CAPABILITIES: Map<string, KnownEntry> = new Map([
  // ── Spec-defined entries ──
  ['qwen3.6',     { toolUse: 'native',    thinking: 'native',    vision: true,  contextLength: 262144 }],
  ['qwen3',       { toolUse: 'native',    thinking: 'native',    vision: false, contextLength: 32768 }],
  ['llama4',      { toolUse: 'native',    thinking: 'native',    vision: true,  contextLength: 131072 }],
  ['mistral',     { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 32768 }],
  ['phi4',        { toolUse: 'simulated', thinking: 'none',      vision: false, contextLength: 16384 }],
  ['llama3.1',    { toolUse: 'simulated', thinking: 'none',      vision: false, contextLength: 131072 }],
  ['deepseek-r1', { toolUse: 'none',      thinking: 'native',    vision: false, contextLength: 65536 }],
  ['gemma',       { toolUse: 'none',      thinking: 'none',      vision: false, contextLength: 8192 }],

  // ── Plan additions (broader coverage) ──
  ['qwen2.5',       { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 32768 }],
  ['mistral-large',  { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 32768 }],
  ['mistral-nemo',   { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 128000 }],
  ['command-r',      { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 131072 }],
  ['command-r-plus', { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 131072 }],
  ['llama3.3',       { toolUse: 'simulated', thinking: 'none',      vision: false, contextLength: 131072 }],
  ['llama3.2',       { toolUse: 'simulated', thinking: 'none',      vision: true,  contextLength: 131072 }],
  ['phi3',           { toolUse: 'simulated', thinking: 'none',      vision: false, contextLength: 4096 }],
  ['deepseek-v3',    { toolUse: 'simulated', thinking: 'native',    vision: false, contextLength: 65536 }],
  ['gemma2',         { toolUse: 'simulated', thinking: 'none',      vision: false, contextLength: 8192 }],
  ['codellama',      { toolUse: 'none',      thinking: 'none',      vision: false, contextLength: 16384 }],
  ['starcoder2',     { toolUse: 'none',      thinking: 'none',      vision: false, contextLength: 16384 }],

  // ── 2025-2026 additions ──
  ['qwen3.5',         { toolUse: 'native',    thinking: 'native',    vision: false, contextLength: 32768 }],
  ['qwen2.5-coder',   { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 32768 }],
  ['qwen3-coder',     { toolUse: 'native',    thinking: 'native',    vision: false, contextLength: 32768 }],
  ['deepseek-v3.2',   { toolUse: 'simulated', thinking: 'native',    vision: false, contextLength: 65536 }],
  ['glm4',            { toolUse: 'native',    thinking: 'native',    vision: false, contextLength: 131072 }],
  ['glm-5',           { toolUse: 'native',    thinking: 'native',    vision: false, contextLength: 131072 }],
  ['kimi-k2.5',       { toolUse: 'native',    thinking: 'native',    vision: false, contextLength: 131072 }],
  ['gemma4',          { toolUse: 'native',    thinking: 'none',      vision: true,  contextLength: 256000 }],
  ['mistral-small',   { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 32768 }],
  ['devstral-small',  { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 131072 }],
  ['devstral',        { toolUse: 'native',    thinking: 'none',      vision: false, contextLength: 131072 }],
  ['phi4-mini',       { toolUse: 'simulated', thinking: 'none',      vision: false, contextLength: 16384 }],
])

// ─── Family Parsing ──────────────────────────────────────────────

/**
 * Extract the model family from an Ollama model name.
 *
 * Examples:
 *   'qwen3:32b' → 'qwen3'
 *   'llama3.1:8b-instruct-q4_0' → 'llama3.1'
 *   'deepseek-r1:14b' → 'deepseek-r1'
 *   'phi4' → 'phi4'
 */
export function parseModelFamily(modelName: string): string {
  // Strip everything after the first colon (tag/quantization)
  return modelName.split(':')[0]
}

// ─── Capability Lookup ───────────────────────────────────────────

/**
 * Look up known capabilities for a model family.
 * Returns null if the family is not in the known table.
 */
export function lookupKnownCapabilities(family: string): KnownEntry | null {
  // Exact match first
  const exact = KNOWN_MODEL_CAPABILITIES.get(family)
  if (exact) return exact

  // Try progressively shorter prefixes: devstral-small-2 → devstral-small → devstral
  const parts = family.split('-')
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('-')
    const match = KNOWN_MODEL_CAPABILITIES.get(prefix)
    if (match) return match
  }

  return null
}

/**
 * Resolve capabilities for a model, using known table → probe result → safe defaults.
 */
export function resolveCapabilities(
  modelName: string,
  probeResult?: { toolUse: ToolUseCapability; thinking: ThinkingCapability; contextLength?: number },
): ModelCapabilities {
  const family = parseModelFamily(modelName)
  const known = lookupKnownCapabilities(family)

  if (known) {
    return {
      tier: deriveTier(known.toolUse, known.thinking),
      toolUse: known.toolUse,
      thinking: known.thinking,
      vision: known.vision,
      jsonMode: known.toolUse !== 'none',
      contextLength: known.contextLength,
      streaming: true,
    }
  }

  if (probeResult) {
    return {
      tier: deriveTier(probeResult.toolUse, probeResult.thinking),
      toolUse: probeResult.toolUse,
      thinking: probeResult.thinking,
      vision: false,
      jsonMode: probeResult.toolUse !== 'none',
      contextLength: probeResult.contextLength ?? 4096,
      streaming: true,
    }
  }

  // Safe defaults — basic tier, no capabilities
  return {
    tier: 'basic',
    toolUse: 'none',
    thinking: 'none',
    vision: false,
    jsonMode: false,
    contextLength: 4096,
    streaming: true,
  }
}
