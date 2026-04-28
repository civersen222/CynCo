/**
 * Simulated tool use and thinking extraction for the Standard tier.
 *
 * Models without native function calling can still use tools via
 * prompt-engineered XML tags. Models that emit <think> tags get
 * thinking blocks extracted into the conversation.
 */

import { randomUUID } from 'crypto'
import type { ToolDefinition, ToolUseBlock, ThinkingBlock } from '../types.js'

// ─── Simulated Tool Prompt ───────────────────────────────────────

/**
 * Build a system prompt addendum instructing the model to use
 * <tool_call> XML tags when it wants to invoke a tool.
 */
export function buildSimulatedToolPrompt(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map(t => {
    const params = t.input_schema.properties
      ? Object.entries(t.input_schema.properties)
          .map(([k, v]) => `    "${k}": ${JSON.stringify(v)}`)
          .join(',\n')
      : ''
    const required = t.input_schema.required?.length
      ? `  Required: ${t.input_schema.required.join(', ')}`
      : ''
    return `- **${t.name}**: ${t.description}\n  Parameters:\n${params}\n${required}`
  }).join('\n\n')

  return `You have access to the following tools. To use a tool, output a <tool_call> XML block with a JSON object containing "name" and "arguments":

<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

You may use multiple tool calls in a single response. Only use the tools listed below.

Available tools:

${toolDescriptions}`
}

// ─── Tool Call Extraction ────────────────────────────────────────

type SimulatedToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

type ExtractToolCallsResult = {
  toolCalls: SimulatedToolCall[]
  remainingText: string
}

/**
 * Extract <tool_call> blocks from model output text.
 *
 * - Tool calls inside <think> blocks are ignored (thinking, not action)
 * - JSON repair: strips trailing commas, retries parse
 * - Unparseable tool calls are silently discarded
 * - Each extracted call gets a sim_ prefixed UUID
 */
export function extractSimulatedToolCalls(text: string): ExtractToolCallsResult {
  // First strip think blocks to avoid extracting tool calls from thinking
  const { remainingText: textWithoutThinking } = extractThinkingBlocks(text)

  const toolCalls: SimulatedToolCall[] = []
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

  let remaining = textWithoutThinking
  let match: RegExpExecArray | null

  while ((match = toolCallRegex.exec(textWithoutThinking)) !== null) {
    const jsonStr = match[1].trim()
    const parsed = tryParseJSON(jsonStr)
    if (parsed && typeof parsed.name === 'string') {
      toolCalls.push({
        id: `sim_${randomUUID()}`,
        name: parsed.name,
        input: parsed.arguments ?? {},
      })
    }
    // Remove the tool call from the remaining text
    remaining = remaining.replace(match[0], '')
  }

  return {
    toolCalls,
    remainingText: remaining.trim(),
  }
}

// ─── Thinking Extraction ─────────────────────────────────────────

type ExtractThinkingResult = {
  thinkingBlocks: ThinkingBlock[]
  remainingText: string
}

/**
 * Extract <think> blocks from model output into ThinkingBlock array.
 */
export function extractThinkingBlocks(text: string): ExtractThinkingResult {
  const thinkingBlocks: ThinkingBlock[] = []
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g

  let remaining = text
  let match: RegExpExecArray | null

  while ((match = thinkRegex.exec(text)) !== null) {
    thinkingBlocks.push({
      type: 'thinking',
      text: match[1].trim(),
    })
    remaining = remaining.replace(match[0], '')
  }

  return {
    thinkingBlocks,
    remainingText: remaining.trim(),
  }
}

// ─── JSON Repair ─────────────────────────────────────────────────

function tryParseJSON(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str)
  } catch {
    // Try repair: strip trailing commas before } or ]
    const repaired = str.replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(repaired)
    } catch {
      return null
    }
  }
}
