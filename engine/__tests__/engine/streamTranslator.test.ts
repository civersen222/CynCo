import { describe, expect, it } from 'bun:test'
import { translateStream, estimateOutputTokens } from '../../engine/streamTranslator.js'
import type { StreamEvent } from '../../types.js'

// ─── Test Helpers ───────────────────────────────────────────────

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

/** Collect all events from the translator into an array. */
async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of source) {
    events.push(event)
  }
  return events
}

/** Find all events of a given type from the collected array. */
function eventsOfType<T extends StreamEvent['type']>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter(e => e.type === type) as Extract<StreamEvent, { type: T }>[]
}

// ─── estimateOutputTokens ───────────────────────────────────────

describe('estimateOutputTokens', () => {
  it('estimates ~4 chars per token', () => {
    // 20 chars => ceil(20/4) = 5 tokens
    expect(estimateOutputTokens('12345678901234567890')).toBe(5)
  })

  it('returns 0 for empty string', () => {
    expect(estimateOutputTokens('')).toBe(0)
  })

  it('rounds up for non-divisible lengths', () => {
    // 5 chars => ceil(5/4) = 2
    expect(estimateOutputTokens('hello')).toBe(2)
  })
})

// ─── Native Mode ────────────────────────────────────────────────

describe('translateStream — native mode', () => {
  describe('text only response', () => {
    it('produces the full event lifecycle for text content', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'qwen2.5-coder', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source)))

      // Should be: message_start, content_block_start, delta, delta, content_block_stop, message_delta, message_stop
      expect(events).toHaveLength(7)

      // 1. message_start
      expect(events[0].type).toBe('message_start')

      // 2. content_block_start (synthesized for text block at index 0)
      expect(events[1].type).toBe('content_block_start')
      const blockStart = events[1] as Extract<StreamEvent, { type: 'content_block_start' }>
      expect(blockStart.index).toBe(0)
      expect(blockStart.content_block.type).toBe('text')

      // 3-4. content_block_delta (passed through)
      expect(events[2].type).toBe('content_block_delta')
      expect(events[3].type).toBe('content_block_delta')

      // 5. content_block_stop for text block
      expect(events[4].type).toBe('content_block_stop')
      const blockStop = events[4] as Extract<StreamEvent, { type: 'content_block_stop' }>
      expect(blockStop.index).toBe(0)

      // 6. message_delta with stop_reason end_turn
      expect(events[5].type).toBe('message_delta')
      const msgDelta = events[5] as Extract<StreamEvent, { type: 'message_delta' }>
      expect(msgDelta.delta.stop_reason).toBe('end_turn')
      expect(msgDelta.usage.output_tokens).toBeGreaterThan(0)

      // 7. message_stop
      expect(events[6].type).toBe('message_stop')
    })
  })

  describe('with tool calls', () => {
    it('closes text block before tool_use starts and produces correct lifecycle', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'qwen2.5-coder', usage: { input_tokens: 0, output_tokens: 0 } } },
        // Text delta at index 0
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read that.' } },
        // Tool call start (from fromOpenAIStreamChunk)
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} } },
        // Tool call argument delta
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"foo.ts"}' } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source)))

      // Expected event order:
      // 1. message_start (enriched)
      // 2. content_block_start (text, index 0) — synthesized
      // 3. content_block_delta (text, index 0) — passed through
      // 4. content_block_stop (index 0) — synthesized before tool
      // 5. content_block_start (tool_use, index 1) — passed through
      // 6. content_block_delta (input_json, index 1) — passed through
      // 7. content_block_delta (input_json, index 1) — passed through
      // 8. content_block_stop (index 1) — synthesized at end
      // 9. message_delta (stop_reason: tool_use) — synthesized
      // 10. message_stop

      expect(events).toHaveLength(10)

      expect(events[0].type).toBe('message_start')
      expect(events[1].type).toBe('content_block_start')
      expect(events[2].type).toBe('content_block_delta')

      // content_block_stop for text at index 0 BEFORE tool_use starts
      expect(events[3].type).toBe('content_block_stop')
      expect((events[3] as Extract<StreamEvent, { type: 'content_block_stop' }>).index).toBe(0)

      // tool_use start at index 1
      expect(events[4].type).toBe('content_block_start')
      const toolStart = events[4] as Extract<StreamEvent, { type: 'content_block_start' }>
      expect(toolStart.content_block.type).toBe('tool_use')
      expect(toolStart.index).toBe(1)

      // tool deltas
      expect(events[5].type).toBe('content_block_delta')
      expect(events[6].type).toBe('content_block_delta')

      // content_block_stop for tool
      expect(events[7].type).toBe('content_block_stop')
      expect((events[7] as Extract<StreamEvent, { type: 'content_block_stop' }>).index).toBe(1)

      // message_delta with tool_use stop reason
      expect(events[8].type).toBe('message_delta')
      const msgDelta = events[8] as Extract<StreamEvent, { type: 'message_delta' }>
      expect(msgDelta.delta.stop_reason).toBe('tool_use')

      // message_stop
      expect(events[9].type).toBe('message_stop')
    })
  })

  describe('empty response', () => {
    it('handles message_start followed immediately by message_stop', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'qwen2.5-coder', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source)))

      // Should be: message_start, message_delta, message_stop
      expect(events).toHaveLength(3)
      expect(events[0].type).toBe('message_start')
      expect(events[1].type).toBe('message_delta')
      const msgDelta = events[1] as Extract<StreamEvent, { type: 'message_delta' }>
      expect(msgDelta.delta.stop_reason).toBe('end_turn')
      expect(events[2].type).toBe('message_stop')
    })
  })

  describe('message_start id enrichment', () => {
    it('replaces empty id with a UUID', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'test-model', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source)))
      const msgStart = events[0] as Extract<StreamEvent, { type: 'message_start' }>
      expect(msgStart.message.id).not.toBe('')
      // UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(msgStart.message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('preserves non-empty id', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: 'existing-id-123', model: 'test-model', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source)))
      const msgStart = events[0] as Extract<StreamEvent, { type: 'message_start' }>
      expect(msgStart.message.id).toBe('existing-id-123')
    })
  })

  describe('model option enrichment', () => {
    it('uses options.model when provided', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: '', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source), { model: 'my-model' }))
      const msgStart = events[0] as Extract<StreamEvent, { type: 'message_start' }>
      expect(msgStart.message.model).toBe('my-model')
    })
  })
})

// ─── Simulated Mode ─────────────────────────────────────────────

describe('translateStream — simulated mode', () => {
  describe('text only', () => {
    it('buffers text and emits a single text block lifecycle', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'llama3', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source), { simulatedToolUse: true }))

      // message_start, content_block_start(text,0), content_block_delta(text,0), content_block_stop(0), message_delta, message_stop
      expect(events).toHaveLength(6)
      expect(events[0].type).toBe('message_start')

      // Text block
      expect(events[1].type).toBe('content_block_start')
      const blockStart = events[1] as Extract<StreamEvent, { type: 'content_block_start' }>
      expect(blockStart.index).toBe(0)
      expect(blockStart.content_block.type).toBe('text')

      expect(events[2].type).toBe('content_block_delta')
      const delta = events[2] as Extract<StreamEvent, { type: 'content_block_delta' }>
      expect(delta.index).toBe(0)
      expect(delta.delta).toEqual({ type: 'text_delta', text: 'Hello world!' })

      expect(events[3].type).toBe('content_block_stop')
      expect((events[3] as Extract<StreamEvent, { type: 'content_block_stop' }>).index).toBe(0)

      // message_delta with end_turn
      expect(events[4].type).toBe('message_delta')
      const msgDelta = events[4] as Extract<StreamEvent, { type: 'message_delta' }>
      expect(msgDelta.delta.stop_reason).toBe('end_turn')

      expect(events[5].type).toBe('message_stop')
    })
  })

  describe('with simulated tool calls', () => {
    it('extracts tool calls from buffered XML and emits tool_use blocks', async () => {
      const toolCallXml = '<tool_call>\n{"name": "Read", "arguments": {"path": "foo.ts"}}\n</tool_call>'
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'llama3', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `I will read the file.\n${toolCallXml}` } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source), { simulatedToolUse: true }))

      // message_start
      expect(events[0].type).toBe('message_start')

      // Text block: "I will read the file."
      const textBlockStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'text')
      expect(textBlockStarts).toHaveLength(1)
      expect(textBlockStarts[0].index).toBe(0)

      // Verify text delta contains clean text (no XML)
      const textDeltas = eventsOfType(events, 'content_block_delta')
        .filter(e => e.index === 0 && e.delta.type === 'text_delta')
      expect(textDeltas).toHaveLength(1)
      expect((textDeltas[0].delta as { type: 'text_delta'; text: string }).text).toBe('I will read the file.')

      // Tool use block
      const toolBlockStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'tool_use')
      expect(toolBlockStarts).toHaveLength(1)
      const toolBlock = toolBlockStarts[0].content_block
      expect(toolBlock.type).toBe('tool_use')
      if (toolBlock.type === 'tool_use') {
        expect(toolBlock.name).toBe('Read')
        expect(toolBlock.input).toEqual({ path: 'foo.ts' })
        expect(toolBlock.id).toMatch(/^sim_/)
      }

      // message_delta with stop_reason tool_use
      const msgDeltas = eventsOfType(events, 'message_delta')
      expect(msgDeltas).toHaveLength(1)
      expect(msgDeltas[0].delta.stop_reason).toBe('tool_use')

      // message_stop at end
      expect(events[events.length - 1].type).toBe('message_stop')
    })
  })

  describe('with thinking blocks', () => {
    it('extracts thinking from buffered text and emits thinking blocks', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'llama3', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<think>Let me reason about this.</think>\nHere is my answer.' } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source), { simulatedToolUse: true }))

      // message_start
      expect(events[0].type).toBe('message_start')

      // Text block with clean text "Here is my answer."
      const textStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'text')
      expect(textStarts).toHaveLength(1)

      const textDeltas = eventsOfType(events, 'content_block_delta')
        .filter(e => e.delta.type === 'text_delta')
      expect(textDeltas).toHaveLength(1)
      expect((textDeltas[0].delta as { type: 'text_delta'; text: string }).text).toBe('Here is my answer.')

      // Thinking block
      const thinkingStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'thinking')
      expect(thinkingStarts).toHaveLength(1)
      const thinkBlock = thinkingStarts[0].content_block
      if (thinkBlock.type === 'thinking') {
        expect(thinkBlock.text).toBe('Let me reason about this.')
      }

      // Each thinking block gets start + stop
      const thinkingStops = eventsOfType(events, 'content_block_stop')
        .filter(e => e.index === thinkingStarts[0].index)
      expect(thinkingStops).toHaveLength(1)

      // message_delta with end_turn (no tool calls)
      const msgDeltas = eventsOfType(events, 'message_delta')
      expect(msgDeltas[0].delta.stop_reason).toBe('end_turn')

      expect(events[events.length - 1].type).toBe('message_stop')
    })
  })

  describe('with thinking AND tool calls', () => {
    it('extracts both thinking and tool calls from buffered text', async () => {
      const text = '<think>I should check the file.</think>\nLet me read it.\n<tool_call>\n{"name": "Read", "arguments": {"path": "bar.ts"}}\n</tool_call>'
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'llama3', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source), { simulatedToolUse: true }))

      // Should have text block, thinking block, and tool_use block
      const textStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'text')
      const thinkingStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'thinking')
      const toolStarts = eventsOfType(events, 'content_block_start')
        .filter(e => e.content_block.type === 'tool_use')

      expect(textStarts).toHaveLength(1)
      expect(thinkingStarts).toHaveLength(1)
      expect(toolStarts).toHaveLength(1)

      // stop_reason should be tool_use since tool calls present
      const msgDeltas = eventsOfType(events, 'message_delta')
      expect(msgDeltas[0].delta.stop_reason).toBe('tool_use')
    })
  })

  describe('empty text in simulated mode', () => {
    it('handles no text deltas gracefully', async () => {
      const source: StreamEvent[] = [
        { type: 'message_start', message: { id: '', model: 'llama3', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'message_stop' },
      ]

      const events = await collect(translateStream(fromArray(source), { simulatedToolUse: true }))

      // message_start, message_delta(end_turn), message_stop
      expect(events).toHaveLength(3)
      expect(events[0].type).toBe('message_start')
      expect(events[1].type).toBe('message_delta')
      expect(events[2].type).toBe('message_stop')
    })
  })
})

// ─── Edge Cases ─────────────────────────────────────────────────

describe('translateStream — edge cases', () => {
  it('handles multiple tool calls in native mode', async () => {
    const source: StreamEvent[] = [
      { type: 'message_start', message: { id: 'test-id', model: 'qwen', usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Two tools.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_2', name: 'Write', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' } },
      { type: 'message_stop' },
    ]

    const events = await collect(translateStream(fromArray(source)))

    // Verify both tool blocks get content_block_stop
    const stops = eventsOfType(events, 'content_block_stop')
    expect(stops).toHaveLength(3) // text block + 2 tool blocks

    // Verify indices: 0, 1, 2
    expect(stops[0].index).toBe(0)
    expect(stops[1].index).toBe(1)
    expect(stops[2].index).toBe(2)

    // stop_reason should be tool_use
    const msgDelta = eventsOfType(events, 'message_delta')
    expect(msgDelta[0].delta.stop_reason).toBe('tool_use')
  })

  it('passes through error events unchanged', async () => {
    const source: StreamEvent[] = [
      { type: 'message_start', message: { id: '', model: 'test', usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'error', error: { type: 'server_error', message: 'Something went wrong' } },
      { type: 'message_stop' },
    ]

    const events = await collect(translateStream(fromArray(source)))

    const errors = eventsOfType(events, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error.message).toBe('Something went wrong')
  })
})
