/**
 * Stream Translator for the CynCo conversation engine.
 *
 * Wraps a Provider's raw stream and emits a structured event lifecycle.
 * Handles both native tool use (pass-through with gap-filling) and
 * simulated tool use (buffer + extract from XML).
 *
 * Event lifecycle:
 *   message_start -> content_block_start -> content_block_delta* ->
 *   content_block_stop -> ... -> message_delta -> message_stop
 */

import { randomUUID } from 'crypto'
import type { StreamEvent } from '../types.js'
import { extractSimulatedToolCalls, extractThinkingBlocks } from '../ollama/simulated.js'

// ─── Public API ─────────────────────────────────────────────────

export type TranslateStreamOptions = {
  /** If true, buffer all text and extract simulated tool calls + thinking at end */
  simulatedToolUse?: boolean
  /** Model name for the message_start enrichment */
  model?: string
}

/**
 * Translate a Provider stream into the structured event lifecycle.
 *
 * Native mode (default): Pass through events, synthesize missing
 * content_block_start/stop and message_delta events.
 *
 * Simulated mode: Buffer all text, then at message_stop, extract
 * thinking blocks and simulated tool calls, emit proper block lifecycle.
 */
export async function* translateStream(
  source: AsyncIterable<StreamEvent>,
  options?: TranslateStreamOptions,
): AsyncGenerator<StreamEvent, void> {
  if (options?.simulatedToolUse) {
    yield* translateSimulated(source, options)
  } else {
    yield* translateNative(source, options)
  }
}

/**
 * Estimate output token count from text length.
 * Rough approximation: ~4 chars per token.
 */
export function estimateOutputTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

// ─── Native Mode ────────────────────────────────────────────────

async function* translateNative(
  source: AsyncIterable<StreamEvent>,
  options?: TranslateStreamOptions,
): AsyncGenerator<StreamEvent, void> {
  let textBlockStarted = false
  let activeBlockIndex = -1
  let hasToolBlocks = false
  let totalText = ''

  for await (const event of source) {
    switch (event.type) {
      case 'message_start': {
        yield enrichMessageStart(event, options)
        break
      }

      case 'content_block_delta': {
        // If this is a text delta and we haven't started the text block yet,
        // synthesize a content_block_start first
        if (event.delta.type === 'text_delta' && !textBlockStarted) {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }
          textBlockStarted = true
          activeBlockIndex = 0
        }

        // Track text for token estimation
        if (event.delta.type === 'text_delta') {
          totalText += event.delta.text
        }

        // Update active block index
        activeBlockIndex = event.index

        yield event
        break
      }

      case 'content_block_start': {
        // This comes from the provider for tool_use blocks.
        // Close the previous block first.
        if (activeBlockIndex >= 0) {
          yield { type: 'content_block_stop', index: activeBlockIndex }
        }

        if (event.content_block.type === 'tool_use') {
          hasToolBlocks = true
        }

        activeBlockIndex = event.index
        yield event
        break
      }

      case 'message_stop': {
        // Close the last active block if any
        if (activeBlockIndex >= 0) {
          yield { type: 'content_block_stop', index: activeBlockIndex }
        }

        // Synthesize message_delta
        yield {
          type: 'message_delta',
          delta: { stop_reason: hasToolBlocks ? 'tool_use' : 'end_turn' },
          usage: { output_tokens: estimateOutputTokens(totalText) },
        }

        yield { type: 'message_stop' }
        break
      }

      case 'error': {
        // Pass through error events unchanged
        yield event
        break
      }

      default: {
        // Pass through any other events
        yield event
        break
      }
    }
  }
}

// ─── Simulated Mode ─────────────────────────────────────────────

async function* translateSimulated(
  source: AsyncIterable<StreamEvent>,
  options?: TranslateStreamOptions,
): AsyncGenerator<StreamEvent, void> {
  let bufferedText = ''

  for await (const event of source) {
    switch (event.type) {
      case 'message_start': {
        yield enrichMessageStart(event, options)
        break
      }

      case 'content_block_delta': {
        // Buffer all text deltas instead of emitting them
        if (event.delta.type === 'text_delta') {
          bufferedText += event.delta.text
        }
        break
      }

      case 'message_stop': {
        // Process the buffered text and emit proper block lifecycle
        yield* emitSimulatedBlocks(bufferedText)
        break
      }

      case 'error': {
        yield event
        break
      }

      default:
        // Ignore other events in simulated mode (e.g., content_block_start
        // from the provider for tool blocks — we handle everything ourselves)
        break
    }
  }
}

/**
 * Process buffered text from simulated mode and emit the full block lifecycle.
 */
function* emitSimulatedBlocks(bufferedText: string): Generator<StreamEvent, void> {
  if (bufferedText.length === 0) {
    // Empty response — just emit message_delta + message_stop
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 0 },
    }
    yield { type: 'message_stop' }
    return
  }

  let blockIndex = 0
  let hasToolCalls = false

  // Extract thinking blocks
  const { thinkingBlocks, remainingText: textAfterThinking } = extractThinkingBlocks(bufferedText)

  // Extract simulated tool calls from text (excluding thinking blocks)
  const { toolCalls, remainingText: cleanText } = extractSimulatedToolCalls(textAfterThinking)

  // 1. Emit text block (index 0) — if there is clean text
  if (cleanText.length > 0) {
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: cleanText },
    }
    yield { type: 'content_block_stop', index: blockIndex }
    blockIndex++
  }

  // 2. Emit thinking blocks
  for (const thinkBlock of thinkingBlocks) {
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', text: thinkBlock.text },
    }
    yield { type: 'content_block_stop', index: blockIndex }
    blockIndex++
  }

  // 3. Emit tool_use blocks
  for (const tc of toolCalls) {
    hasToolCalls = true
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      },
    }
    yield { type: 'content_block_stop', index: blockIndex }
    blockIndex++
  }

  // 4. Emit message_delta
  yield {
    type: 'message_delta',
    delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: estimateOutputTokens(bufferedText) },
  }

  // 5. Emit message_stop
  yield { type: 'message_stop' }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Enrich a message_start event: fill in empty id with UUID,
 * optionally set model from options.
 */
function enrichMessageStart(
  event: Extract<StreamEvent, { type: 'message_start' }>,
  options?: TranslateStreamOptions,
): StreamEvent {
  const message = { ...event.message }
  if (!message.id) {
    message.id = randomUUID()
  }
  if (options?.model) {
    message.model = options.model
  }
  return { type: 'message_start', message }
}
