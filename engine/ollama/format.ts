/**
 * OpenAI format translation layer.
 *
 * Translates between LocalCode's internal types and the OpenAI
 * chat completions format used by Ollama's /v1/chat/completions endpoint.
 */

import type {
  ContentBlock, Message, ToolDefinition, CompletionResponse,
  StreamEvent, StopReason, TokenUsage, TokenLogprob, TurnCost,
} from '../types.js'
import { parseNativeToolCalls } from '../engine/toolCallRepair.js'

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
  usage?: {
    prompt_tokens: number; completion_tokens: number; total_tokens: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  timings?: Record<string, unknown>
}): CompletionResponse {
  if (!oai.choices || oai.choices.length === 0) {
    return { content: [], model: oai.model, stopReason: 'error', usage: { inputTokens: 0, outputTokens: 0 } }
  }
  const choice = oai.choices[0]
  const content: ContentBlock[] = []

  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  if (choice.message.tool_calls) {
    content.push(...parseNativeToolCalls(choice.message.tool_calls))
  }

  return {
    id: oai.id,
    model: oai.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason) ?? 'end_turn',
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
      cost: parseTurnCost(oai),
    },
  }
}

/**
 * Extract what the turn cost from a server response.
 *
 * llama-server attaches a `timings` block to the final chunk (and to non-stream
 * responses); OpenAI-compatible servers generally do not, and Ollama's shim does
 * not. Anything the server did not report stays null — a missing timing is not a
 * timing of zero.
 */
export function parseTurnCost(payload: {
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  timings?: Record<string, unknown>
}): TurnCost {
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const t = payload.timings

  if (t && (n(t.prompt_n) !== null || n(t.predicted_n) !== null)) {
    return {
      // prompt_n is the work; usage.prompt_tokens is the size. They differ by
      // exactly the cache hit, which is the number this ledger exists to expose.
      prefillTokens: n(t.prompt_n),
      cachedTokens: n(t.cache_n) ?? n(payload.usage?.prompt_tokens_details?.cached_tokens),
      decodeTokens: n(t.predicted_n) ?? n(payload.usage?.completion_tokens),
      prefillMs: n(t.prompt_ms),
      decodeMs: n(t.predicted_ms),
      wallMs: null, // filled by the caller, which is the only one holding a clock
      slot: null,   // absent from the OpenAI-compatible response
      source: 'server-timings',
    }
  }

  if (payload.usage) {
    return {
      // No timings block: the token counts are known but how they split between
      // fresh prefill and cache is not, so prefillTokens stays null rather than
      // being set to the prompt size it is not.
      prefillTokens: null,
      cachedTokens: n(payload.usage.prompt_tokens_details?.cached_tokens),
      decodeTokens: n(payload.usage.completion_tokens),
      prefillMs: null,
      decodeMs: null,
      wallMs: null,
      slot: null,
      source: 'usage-only',
    }
  }

  return {
    prefillTokens: null, cachedTokens: null, decodeTokens: null,
    prefillMs: null, decodeMs: null, wallMs: null, slot: null,
    source: 'none',
  }
}

/** Parse OpenAI-compat `choices[].logprobs.content` into TokenLogprob[]; undefined if absent/malformed. */
function parseChunkLogprobs(choice: unknown): TokenLogprob[] | undefined {
  const content = (choice as any)?.logprobs?.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  return content.map((e: any) => ({
    token: String(e?.token ?? ''),
    logprob: Number(e?.logprob ?? 0),
    top: Array.isArray(e?.top_logprobs)
      ? e.top_logprobs.map((t: any) => ({ token: String(t?.token ?? ''), logprob: Number(t?.logprob ?? 0) }))
      : [],
  }))
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
  usage?: {
    prompt_tokens: number; completion_tokens: number; total_tokens: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  timings?: Record<string, unknown>
}): StreamEvent[] {
  const events: StreamEvent[] = []
  const choice = chunk.choices?.[0]

  // Usage is the ONE number in the context-management path that the server
  // measured rather than the engine guessed: prompt_tokens is what llama-server
  // actually evaluated. It arrives on a chunk with an EMPTY choices array, so
  // the early return below — written to swallow error payloads — used to
  // discard it before anything could read it. Finding (n): the engine's
  // chars/4 estimate read 75% while the request was 67733 of 65536 tokens, the
  // 80% compaction trigger never fired, and the run died mid-task.
  //
  // Emitted before the content events so a consumer that stops at the first
  // message_delta still sees it.
  if (chunk.usage) {
    events.push({
      type: 'message_delta',
      // An empty stop_reason means "this chunk says nothing about how the turn
      // ended" — a usage-only chunk genuinely doesn't. Consumers must not read
      // it as a stop.
      delta: { stop_reason: mapFinishReason(choice?.finish_reason ?? null) ?? '' },
      usage: {
        input_tokens: chunk.usage.prompt_tokens,
        output_tokens: chunk.usage.completion_tokens,
        // Rides the same chunk that carries the token counts, because
        // llama-server attaches `timings` to exactly that chunk.
        cost: parseTurnCost(chunk),
      },
    })
  }

  if (!choice) return events

  const lp = parseChunkLogprobs(choice)

  // Text delta
  if (choice.delta.content) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: choice.delta.content, ...(lp ? { logprobs: lp } : {}) },
    })
  }

  // Reasoning delta. llama-server with --jinja parses <think> out of content
  // into delta.reasoning_content; some backends use delta.reasoning. Both map
  // to thinking blocks so the TUI can display them and the assembler keeps them.
  const reasoningText = (choice.delta as any).reasoning_content ?? (choice.delta as any).reasoning
  if (reasoningText) {
    const thinkLp = lp && !choice.delta.content ? lp : undefined
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: reasoningText, ...(thinkLp ? { logprobs: thinkLp } : {}) },
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
            ...(lp ? { logprobs: lp } : {}),
          },
        })
      }
      // Argument fragments → input_json_delta
      if (tc.function?.arguments) {
        events.push({
          type: 'content_block_delta',
          index: tc.index + 1,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments, ...(lp ? { logprobs: lp } : {}) },
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
