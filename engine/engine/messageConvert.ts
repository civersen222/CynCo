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

// ─── Convert Options ────────────────────────────────────────────

export type ConvertOptions = {
  simulatedToolUse?: boolean
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
 *
 * When `simulatedToolUse` is true, tool_use blocks are serialized
 * to `<tool_call>` XML text and tool_result blocks become plain text.
 * This preserves full conversation history when using simulated tool
 * calling (Ollama strips native tool blocks).
 */
export function convertMessages(messages: Message[], options?: ConvertOptions): Message[] {
  if (options?.simulatedToolUse) {
    return messages.map(msg => convertMessageSimulated(msg))
  }
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content.filter(
      (block: ContentBlock) => ALLOWED_BLOCK_TYPES.has(block.type)
    ),
  }))
}

/**
 * Convert a single message for simulated tool use mode.
 *
 * - text blocks → preserved as text parts
 * - tool_use blocks (assistant) → `<tool_call>` XML with JSON payload
 * - tool_result blocks (user) → `[Tool Result: id]\ncontent` text
 * - thinking blocks → `<think>text</think>` text
 * - image blocks → `[Image omitted — not supported in simulated tool mode]` placeholder text
 * - All other block types (redacted_thinking, connector_text, document) → dropped
 */
function convertMessageSimulated(msg: Message): Message {
  const textParts: string[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push((block as any).text)
    } else if (block.type === 'tool_use' && msg.role === 'assistant') {
      const tc = block as any
      textParts.push(`<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.input }, null, 2)}\n</tool_call>`)
    } else if (block.type === 'tool_result' && msg.role === 'user') {
      const tr = block as any
      const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)
      textParts.push(`[Tool Result: ${tr.tool_use_id}]\n${content}`)
    } else if (block.type === 'thinking') {
      textParts.push(`<think>${(block as any).text}</think>`)
    } else if (block.type === 'image') {
      textParts.push('[Image omitted — not supported in simulated tool mode]')
    }
    // redacted_thinking, connector_text, document → dropped
  }

  return {
    role: msg.role,
    content: textParts.length > 0
      ? [{ type: 'text', text: textParts.join('\n\n') } as ContentBlock]
      : [],
  }
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
