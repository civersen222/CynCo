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
import { repairToolCall, parseNativeToolCalls, MALFORMED_KEY } from './toolCallRepair.js'

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
  // Kind of the currently open block:
  //   'text'     — synthesized text block
  //   'thinking' — synthesized thinking block
  //   'provider' — provider-emitted block (tool_use or other); also used for
  //                provider-emitted text/thinking starts that were already open
  let openKind: 'text' | 'thinking' | 'provider' | null = null
  let activeBlockIndex = -1
  let nextSynthIndex = 0
  let hasToolBlocks = false
  let totalText = ''

  // Issue 1: map provider raw index → output index for provider-emitted blocks.
  // Needed because provider tool_use starts arrive at raw indices that may
  // collide with synthesized indices (e.g. synth thinking=0, synth text=1,
  // provider tool at raw index 1 would collide without re-addressing).
  const providerIndexMap = new Map<number, number>()

  for await (const event of source) {
    switch (event.type) {
      case 'message_start': {
        yield enrichMessageStart(event, options)
        break
      }

      case 'content_block_delta': {
        const kind = event.delta.type === 'text_delta' ? 'text'
          : event.delta.type === 'thinking_delta' ? 'thinking'
          : null

        // Synthesize block boundaries when the delta kind changes
        // (llama-server with --jinja streams reasoning_content before content,
        // both at index 0 — without this, thinking deltas have no open block
        // and the assembler drops them).
        if (kind && openKind !== kind) {
          if (activeBlockIndex >= 0) {
            yield { type: 'content_block_stop', index: activeBlockIndex }
          }
          activeBlockIndex = nextSynthIndex++
          yield {
            type: 'content_block_start',
            index: activeBlockIndex,
            content_block: kind === 'text'
              ? { type: 'text', text: '' }
              : { type: 'thinking', text: '' },
          }
          openKind = kind
        }

        if (event.delta.type === 'text_delta') {
          totalText += event.delta.text
        }

        // Re-address synthesized-kind deltas to the open block.
        // For provider-addressed deltas (input_json_delta), look up the
        // re-addressed output index via providerIndexMap; fall back to raw
        // index if not mapped (e.g. provider opened a text/thinking start).
        if (kind) {
          yield { ...event, index: activeBlockIndex }
        } else {
          // Issue 1 fix: use mapped output index for provider-addressed deltas
          const mappedIndex = providerIndexMap.get(event.index) ?? event.index
          activeBlockIndex = mappedIndex
          yield { ...event, index: mappedIndex }
        }
        break
      }

      case 'content_block_start': {
        // Provider-emitted block. Close any open synthesized block first.
        if (activeBlockIndex >= 0) {
          yield { type: 'content_block_stop', index: activeBlockIndex }
        }

        // Issue 1 fix: re-address the provider block to the next synth index
        // so all output indices are unique and monotonically increasing.
        const outIndex = nextSynthIndex++
        providerIndexMap.set(event.index, outIndex)
        activeBlockIndex = outIndex

        if (event.content_block.type === 'tool_use') {
          hasToolBlocks = true
          openKind = 'provider'
        } else if (event.content_block.type === 'text') {
          // Provider emitted a text block start (e.g., re-translated stream);
          // track it so subsequent text deltas don't trigger re-synthesis.
          openKind = 'text'
        } else if (event.content_block.type === 'thinking') {
          openKind = 'thinking'
        } else {
          openKind = 'provider'
        }

        yield { ...event, index: outIndex }
        break
      }

      case 'message_stop': {
        if (activeBlockIndex >= 0) {
          yield { type: 'content_block_stop', index: activeBlockIndex }
        }
        yield {
          type: 'message_delta',
          delta: { stop_reason: hasToolBlocks ? 'tool_use' : 'end_turn' },
          usage: { output_tokens: estimateOutputTokens(totalText) },
        }
        yield { type: 'message_stop' }
        break
      }

      case 'error': {
        yield event
        break
      }

      default: {
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
  // Issue 2 fix: buffer provider-parsed thinking_delta so it isn't dropped.
  let bufferedThinking = ''
  // Native tool blocks parsed server-side (--jinja) can arrive even in
  // simulated mode; dropping them loses the model's action. Collect and
  // append them after the extracted blocks.
  const nativeToolBlocks: Array<{ id: string; name: string; partialJson: string }> = []

  for await (const event of source) {
    switch (event.type) {
      case 'message_start': {
        yield enrichMessageStart(event, options)
        break
      }

      case 'content_block_start': {
        if (event.content_block.type === 'tool_use') {
          nativeToolBlocks.push({
            id: (event.content_block as any).id ?? '',
            name: (event.content_block as any).name ?? 'unknown',
            partialJson: '',
          })
        }
        break
      }

      case 'content_block_delta': {
        if (event.delta.type === 'text_delta') {
          bufferedText += event.delta.text
        } else if (event.delta.type === 'thinking_delta') {
          // Issue 2 fix: capture provider-parsed thinking instead of dropping it
          bufferedThinking += event.delta.thinking
        } else if (event.delta.type === 'input_json_delta' && nativeToolBlocks.length > 0) {
          nativeToolBlocks[nativeToolBlocks.length - 1].partialJson += event.delta.partial_json
        }
        break
      }

      case 'message_stop': {
        yield* emitSimulatedBlocks(bufferedText, nativeToolBlocks, bufferedThinking)
        break
      }

      case 'error': {
        yield event
        break
      }

      default:
        break
    }
  }
}

/**
 * Process buffered text from simulated mode and emit the full block lifecycle.
 *
 * Block emission order:
 *   0. Provider-parsed thinking block (bufferedThinking) — emitted FIRST,
 *      as it arrived on the wire before content
 *   1. Text block (cleanText after removing <think> tags and tool XML)
 *   2. Extracted thinking blocks (from <think> tags in bufferedText)
 *   3. Extracted tool_use blocks (from <tool_call> XML in bufferedText)
 *   3b. Native tool blocks captured from the provider (server-side parsed)
 *   4. message_delta
 *   5. message_stop
 */
function* emitSimulatedBlocks(
  bufferedText: string,
  nativeToolBlocks: Array<{ id: string; name: string; partialJson: string }> = [],
  bufferedThinking = '',
): Generator<StreamEvent, void> {
  if (bufferedText.length === 0 && nativeToolBlocks.length === 0 && bufferedThinking.length === 0) {
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

  // 0. Emit provider-parsed thinking FIRST (arrived before content on the wire)
  if (bufferedThinking.length > 0) {
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', text: bufferedThinking },
    }
    yield { type: 'content_block_stop', index: blockIndex }
    blockIndex++
  }

  // 1. Emit text block — if there is clean text
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

  // 2. Emit thinking blocks extracted from <think> tags
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

  // 3b. Emit native tool blocks captured from the provider (server-side parsed).
  // Minor #4: use parseNativeToolCalls to keep malformed-marker shape in one place.
  for (const nb of nativeToolBlocks) {
    hasToolCalls = true
    const [block] = parseNativeToolCalls([{ id: nb.id, type: 'function', function: { name: nb.name, arguments: nb.partialJson } }])
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
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
