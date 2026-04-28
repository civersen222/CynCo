/**
 * OpenAI format translation layer.
 *
 * Translates between LocalCode's internal types and the OpenAI
 * chat completions format used by Ollama's /v1/chat/completions endpoint.
 */

import type {
  ContentBlock, Message, ToolDefinition, CompletionResponse,
  StreamEvent, StopReason, TokenUsage,
} from '../types.js'

// ─── Internal → OpenAI ──────────────────────────────────────────

/**
 * Convert internal Messages to OpenAI chat messages.
 *
 * Text blocks → concatenated string content
 * Tool use blocks → tool_calls array
 * Tool result blocks → separate role:'tool' messages
 * Thinking/image/document/connector blocks → stripped
 */
export function toOpenAIMessages(messages: Message[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    // Check if this message contains tool results — they become separate messages
    const toolResults = msg.content.filter(b => b.type === 'tool_result')
    const otherBlocks = msg.content.filter(b => b.type !== 'tool_result')

    // Convert tool results to individual tool role messages
    for (const block of toolResults) {
      if (block.type === 'tool_result') {
        const textContent = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
            : String(block.content ?? '')
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: textContent,
        })
      }
    }

    if (otherBlocks.length === 0 && toolResults.length > 0) continue

    // Extract text content
    const textParts: string[] = []
    const toolCalls: unknown[] = []

    for (const block of otherBlocks) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text)
          break
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })
          break
        // thinking, image, document, connector, redacted_thinking → stripped
      }
    }

    const oaiMsg: Record<string, unknown> = {
      role: msg.role,
    }
    // OpenAI spec: content should be null (not empty string) when tool_calls are present
    if (textParts.length > 0) {
      oaiMsg.content = textParts.join('')
    } else if (toolCalls.length > 0) {
      oaiMsg.content = null
    } else {
      oaiMsg.content = ''
    }
    if (toolCalls.length > 0) {
      oaiMsg.tool_calls = toolCalls
    }
    result.push(oaiMsg)
  }

  return result
}

/**
 * Convert internal ToolDefinitions to OpenAI function tool format.
 */
export function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

// ─── OpenAI → Internal ──────────────────────────────────────────

/**
 * Convert an OpenAI chat completion response to internal CompletionResponse.
 */
export function fromOpenAIResponse(oai: {
  id: string
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}): CompletionResponse {
  const choice = oai.choices[0]
  const content: ContentBlock[] = []

  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = { _raw: tc.function.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  return {
    id: oai.id,
    model: oai.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason) ?? 'end_turn',
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  }
}

/**
 * Convert an OpenAI streaming chunk to StreamEvents.
 *
 * Each chunk may produce 0 or more events. A text delta produces
 * a content_block_delta. A tool call with id+name produces
 * content_block_start, subsequent argument chunks produce input_json_delta.
 */
export function fromOpenAIStreamChunk(chunk: {
  id: string
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}): StreamEvent[] {
  const events: StreamEvent[] = []
  const choice = chunk.choices[0]
  if (!choice) return events

  // Text delta
  if (choice.delta.content) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: choice.delta.content },
    })
  }

  // Reasoning delta (Gemma 4 and other models with chain-of-thought)
  // Treat reasoning tokens as thinking blocks so the TUI can display them
  if ((choice.delta as any).reasoning) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: (choice.delta as any).reasoning },
    })
  }

  // Tool call deltas
  if (choice.delta.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      // First chunk for a tool call has id + name → content_block_start
      if (tc.id && tc.function?.name) {
        events.push({
          type: 'content_block_start',
          index: tc.index + 1, // offset by 1 since text is index 0
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: {},
          },
        })
      }
      // Argument fragments → input_json_delta
      if (tc.function?.arguments) {
        events.push({
          type: 'content_block_delta',
          index: tc.index + 1,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        })
      }
    }
  }

  return events
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Map OpenAI finish_reason to internal StopReason.
 */
export function mapFinishReason(reason: string | null): StopReason | undefined {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    default: return undefined
  }
}

/**
 * Parse a Server-Sent Events line.
 * Returns parsed JSON for data lines, null for [DONE], undefined for non-data.
 */
export function parseSSELine(line: string): unknown | null | undefined {
  if (!line.startsWith('data: ')) return undefined
  const data = line.slice(6)
  if (data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}
