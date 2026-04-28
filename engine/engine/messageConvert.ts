/**
 * Message conversion layer for the CynCo conversation engine.
 *
 * Translates between internal message types and the Provider's
 * CompletionRequest format for Ollama's OpenAI-compatible endpoint.
 */

import type {
  ContentBlock, Message, ToolDefinition, ToolInputSchema,
} from '../types.js'
import type { SystemPrompt } from '../types.js'

// ─── Block Types ────────────────────────────────────────────────

/** Block types that the provider can handle. */
const ALLOWED_BLOCK_TYPES = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'image',
])

/** Block types stripped before sending to the provider. */
// redacted_thinking, connector_text, document

// ─── ToolLike ───────────────────────────────────────────────────

/**
 * Minimal shape for a tool that can be converted.
 * Accepts either pre-resolved tool objects (with string description)
 * or objects with an inputJSONSchema.
 */
export type ToolLike = {
  name: string
  description: string
  inputJSONSchema?: ToolInputSchema
}

// ─── convertMessages ────────────────────────────────────────────

/**
 * Convert internal messages for the Provider.
 *
 * Since localcode's Message type is structurally the same as what
 * Both use ContentBlock arrays, so this is mostly a
 * pass-through with unsupported block types stripped:
 * - Strips: redacted_thinking, connector_text, document
 * - Preserves: text, tool_use, tool_result, thinking, image
 */
export function convertMessages(messages: Message[]): Message[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content.filter(
      (block: ContentBlock) => ALLOWED_BLOCK_TYPES.has(block.type)
    ),
  }))
}

// ─── convertTools ───────────────────────────────────────────────

/**
 * Convert tool definitions for the Provider.
 *
 * Takes an array of tool-like objects (with name, description, and
 * optional inputJSONSchema) and produces ToolDefinition[] for the
 * Provider's CompletionRequest.
 *
 * The caller is responsible for resolving description strings before
 * calling this function (e.g. from tool.prompt() or a pre-built map).
 */
export function convertTools(tools: readonly ToolLike[]): ToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJSONSchema
      ? {
          type: tool.inputJSONSchema.type,
          ...(tool.inputJSONSchema.properties !== undefined
            ? { properties: tool.inputJSONSchema.properties }
            : {}),
          ...(tool.inputJSONSchema.required !== undefined
            ? { required: tool.inputJSONSchema.required }
            : {}),
        }
      : { type: 'object' as const },
  }))
}

// ─── buildSystemPrompt ──────────────────────────────────────────

/**
 * Concatenate a branded SystemPrompt array into a single string.
 *
 * The SystemPrompt type is a readonly string[] with a brand marker.
 * We join with double newlines.
 */
export function buildSystemPrompt(systemPrompt: SystemPrompt): string {
  return (systemPrompt as readonly string[]).join('\n\n')
}
