import { describe, expect, it } from 'bun:test'
import {
  convertMessages, convertTools, buildSystemPrompt,
} from '../../engine/messageConvert.js'
import type { Message } from '../../types.js'
import { asSystemPrompt } from '../../types.js'

// ─── convertMessages ────────────────────────────────────────────

describe('convertMessages', () => {
  it('preserves text-only user message', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('preserves assistant message with tool_use', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ]},
    ])
  })

  it('preserves user message with tool_result', () => {
    const msgs: Message[] = [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.ts' }] },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.ts' }] },
      ]},
    ])
  })

  it('preserves thinking blocks', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: 'let me reason about this' },
        { type: 'text', text: 'Here is my answer.' },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'assistant', content: [
        { type: 'thinking', text: 'let me reason about this' },
        { type: 'text', text: 'Here is my answer.' },
      ]},
    ])
  })

  it('strips redacted_thinking blocks', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'secret stuff' },
        { type: 'text', text: 'visible response' },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'visible response' },
      ]},
    ])
  })

  it('strips connector_text blocks', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'connector_text', text: 'bridging text' },
        { type: 'text', text: 'real content' },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'real content' },
      ]},
    ])
  })

  it('strips document blocks', () => {
    const msgs: Message[] = [
      { role: 'user', content: [
        { type: 'document', source: { type: 'text', text: 'pdf content' } },
        { type: 'text', text: 'Summarize the above.' },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'user', content: [
        { type: 'text', text: 'Summarize the above.' },
      ]},
    ])
  })

  it('preserves image blocks', () => {
    const msgs: Message[] = [
      { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        { type: 'text', text: 'What is in this image?' },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        { type: 'text', text: 'What is in this image?' },
      ]},
    ])
  })

  it('handles empty content array gracefully', () => {
    const msgs: Message[] = [
      { role: 'user', content: [] },
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'user', content: [] },
    ])
  })

  it('handles message where all blocks are stripped', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'secret' },
        { type: 'connector_text', text: 'bridge' },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'assistant', content: [] },
    ])
  })

  it('handles multiple messages with mixed block types', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [
        { type: 'thinking', text: 'reasoning' },
        { type: 'redacted_thinking', data: 'redacted' },
        { type: 'connector_text', text: 'connector' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/a.ts' } },
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
        { type: 'document', source: { type: 'url', url: 'http://example.com' } },
      ]},
    ]
    const result = convertMessages(msgs)
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [
        { type: 'thinking', text: 'reasoning' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/a.ts' } },
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
      ]},
    ])
  })
})

// ─── convertTools ───────────────────────────────────────────────

describe('convertTools', () => {
  it('converts a single tool', () => {
    const tools = [{
      name: 'bash',
      description: 'Run a shell command',
      inputJSONSchema: {
        type: 'object' as const,
        properties: { command: { type: 'string', description: 'The command' } },
        required: ['command'],
      },
    }]

    const result = convertTools(tools)
    expect(result).toEqual([{
      name: 'bash',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command' } },
        required: ['command'],
      },
    }])
  })

  it('converts multiple tools', () => {
    const tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputJSONSchema: {
          type: 'object' as const,
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
      {
        name: 'write',
        description: 'Write a file',
        inputJSONSchema: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['file_path', 'content'],
        },
      },
    ]

    const result = convertTools(tools)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('read')
    expect(result[1]!.name).toBe('write')
    expect(result[1]!.input_schema.required).toEqual(['file_path', 'content'])
  })

  it('handles tool with empty schema (no params)', () => {
    const tools = [{
      name: 'status',
      description: 'Show status',
      inputJSONSchema: { type: 'object' as const },
    }]

    const result = convertTools(tools)
    expect(result).toEqual([{
      name: 'status',
      description: 'Show status',
      input_schema: { type: 'object' },
    }])
  })

  it('handles tool with required params', () => {
    const tools = [{
      name: 'grep',
      description: 'Search files',
      inputJSONSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          include: { type: 'string' },
        },
        required: ['pattern'],
      },
    }]

    const result = convertTools(tools)
    expect(result[0]!.input_schema.required).toEqual(['pattern'])
    expect(result[0]!.input_schema.properties).toHaveProperty('path')
    expect(result[0]!.input_schema.properties).toHaveProperty('include')
  })

  it('uses empty object schema when inputJSONSchema is missing', () => {
    const tools = [{
      name: 'noop',
      description: 'Does nothing',
    }]

    const result = convertTools(tools)
    expect(result).toEqual([{
      name: 'noop',
      description: 'Does nothing',
      input_schema: { type: 'object' },
    }])
  })
})

// ─── buildSystemPrompt ──────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('returns single string as-is', () => {
    const prompt = asSystemPrompt(['You are a helpful assistant.'])
    const result = buildSystemPrompt(prompt)
    expect(result).toBe('You are a helpful assistant.')
  })

  it('joins multiple strings with double newlines', () => {
    const prompt = asSystemPrompt([
      'You are a helpful assistant.',
      'Follow these rules:',
      'Be concise.',
    ])
    const result = buildSystemPrompt(prompt)
    expect(result).toBe(
      'You are a helpful assistant.\n\nFollow these rules:\n\nBe concise.'
    )
  })

  it('returns empty string for empty array', () => {
    const prompt = asSystemPrompt([])
    const result = buildSystemPrompt(prompt)
    expect(result).toBe('')
  })
})
