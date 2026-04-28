import { describe, expect, it } from 'bun:test'
import type {
  ContentBlock, ContentDelta, CompletionResponse, Message,
  StreamEvent, TextBlock, ThinkingBlock, RedactedThinkingBlock,
  ToolUseBlock, ToolResultBlock, ImageBlock, DocumentBlock,
  ConnectorTextBlock, TokenUsage, ToolDefinition, StopReason,
} from '../types.js'
import {
  isTextBlock, isThinkingBlock, isRedactedThinkingBlock,
  isToolUseBlock, isToolResultBlock, isConnectorTextBlock,
} from '../types.js'

describe('types', () => {
  it('ContentBlock union accepts all block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', text: 'reasoning' },
      { type: 'redacted_thinking', data: 'base64' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
      { type: 'tool_result', tool_use_id: 'tu_1', content: [] },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'abc' } },
      { type: 'document', source: { type: 'text', text: 'plain text doc' } },
      { type: 'document', source: { type: 'url', url: 'https://example.com/doc.pdf' } },
      { type: 'connector_text', text: 'summary' },
    ]
    expect(blocks).toHaveLength(10)
  })

  it('Message has role and content', () => {
    const msg: Message = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    expect(msg.role).toBe('assistant')
  })

  it('CompletionResponse has required fields', () => {
    const resp: CompletionResponse = {
      id: 'r1', model: 'qwen3:32b',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    expect(resp.stop_reason).toBe('end_turn')
  })

  it('StreamEvent discriminated union works', () => {
    const event: StreamEvent = {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    }
    expect(event.type).toBe('content_block_delta')
  })

  it('StopReason union is exported', () => {
    const r: StopReason = 'end_turn'
    expect(r).toBe('end_turn')
    const r2: StopReason = 'tool_use'
    expect(r2).toBe('tool_use')
  })

  it('type guards work correctly', () => {
    const text: ContentBlock = { type: 'text', text: 'hi' }
    const tool: ContentBlock = { type: 'tool_use', id: '1', name: 'bash', input: {} }
    expect(isTextBlock(text)).toBe(true)
    expect(isTextBlock(tool)).toBe(false)
    expect(isToolUseBlock(tool)).toBe(true)
    expect(isToolUseBlock(text)).toBe(false)

    const thinking: ContentBlock = { type: 'thinking', text: 'hmm' }
    expect(isThinkingBlock(thinking)).toBe(true)
    expect(isThinkingBlock(text)).toBe(false)

    const redacted: ContentBlock = { type: 'redacted_thinking', data: 'x' }
    expect(isRedactedThinkingBlock(redacted)).toBe(true)

    const result: ContentBlock = { type: 'tool_result', tool_use_id: '1', content: [] }
    expect(isToolResultBlock(result)).toBe(true)

    const connector: ContentBlock = { type: 'connector_text', text: 'x' }
    expect(isConnectorTextBlock(connector)).toBe(true)
    expect(isConnectorTextBlock(text)).toBe(false)
  })
})
