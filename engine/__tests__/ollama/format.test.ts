import { describe, expect, it } from 'bun:test'
import {
  toOpenAIMessages, toOpenAITools, fromOpenAIResponse,
  fromOpenAIStreamChunk, mapFinishReason, parseSSELine,
} from '../../ollama/format.js'
import type { Message, ToolDefinition } from '../../types.js'

describe('toOpenAIMessages', () => {
  it('converts text content to string', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const result = toOpenAIMessages(msgs) as any[]
    expect(result).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('concatenates multiple text blocks', () => {
    const msgs: Message[] = [
      { role: 'user', content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ]},
    ]
    const result = toOpenAIMessages(msgs) as any[]
    expect(result).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('converts tool_use blocks to tool_calls', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me run that.' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ]},
    ]
    const result = toOpenAIMessages(msgs) as any[]
    expect(result[0].role).toBe('assistant')
    expect(result[0].content).toBe('Let me run that.')
    expect(result[0].tool_calls).toEqual([{
      id: 'tu_1', type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    }])
  })

  it('converts tool_result blocks to tool role messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.ts' }] },
      ]},
    ]
    const result = toOpenAIMessages(msgs) as any[]
    expect(result[0]).toEqual({
      role: 'tool', tool_call_id: 'tu_1', content: 'file.ts',
    })
  })

  it('strips thinking blocks (not sent to API)', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: 'internal reasoning' },
        { type: 'text', text: 'visible response' },
      ]},
    ]
    const result = toOpenAIMessages(msgs) as any[]
    expect(result[0].content).toBe('visible response')
  })
})

describe('toOpenAITools', () => {
  it('converts ToolDefinition to OpenAI function format', () => {
    const tools: ToolDefinition[] = [{
      name: 'bash',
      description: 'Run a shell command',
      input_schema: {
        type: 'object' as const,
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }]
    const result = toOpenAITools(tools)
    expect(result).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }])
  })
})

describe('fromOpenAIResponse', () => {
  it('converts text-only response', () => {
    const oai = {
      id: 'chatcmpl-1', model: 'qwen3:32b',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    const result = fromOpenAIResponse(oai)
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('converts response with tool_calls', () => {
    const oai = {
      id: 'chatcmpl-2', model: 'qwen3:32b',
      choices: [{ index: 0, message: {
        role: 'assistant', content: "I'll check.",
        tool_calls: [{
          id: 'tc_1', type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls"}' },
        }],
      }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }
    const result = fromOpenAIResponse(oai)
    expect(result.content).toEqual([
      { type: 'text', text: "I'll check." },
      { type: 'tool_use', id: 'tc_1', name: 'bash', input: { command: 'ls' } },
    ])
    expect(result.stop_reason).toBe('tool_use')
  })
})

describe('fromOpenAIStreamChunk', () => {
  it('converts text delta chunk to StreamEvent', () => {
    const chunk = {
      id: 'chatcmpl-1', model: 'qwen3:32b',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    }
    const events = fromOpenAIStreamChunk(chunk)
    expect(events).toEqual([{
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    }])
  })

  it('converts tool call chunk to content_block_start + input_json_delta', () => {
    const chunk = {
      id: 'chatcmpl-2', model: 'qwen3:32b',
      choices: [{ index: 0, delta: {
        tool_calls: [{
          index: 0, id: 'tc_1', type: 'function',
          function: { name: 'bash', arguments: '{"com' },
        }],
      }, finish_reason: null }],
    }
    const events = fromOpenAIStreamChunk(chunk)
    expect(events.length).toBeGreaterThanOrEqual(1)
    const startEvent = events.find((e: any) => e.type === 'content_block_start')
    expect(startEvent).toBeDefined()
  })
})

describe('mapFinishReason', () => {
  it('maps OpenAI finish reasons to internal StopReason', () => {
    expect(mapFinishReason('stop')).toBe('end_turn')
    expect(mapFinishReason('tool_calls')).toBe('tool_use')
    expect(mapFinishReason('length')).toBe('max_tokens')
    expect(mapFinishReason(null)).toBeUndefined()
  })
})

describe('parseSSELine', () => {
  it('parses data: prefixed lines', () => {
    const result = parseSSELine('data: {"id":"1"}')
    expect(result).toEqual({ id: '1' })
  })

  it('returns null for [DONE] sentinel', () => {
    expect(parseSSELine('data: [DONE]')).toBeNull()
  })

  it('returns undefined for non-data lines', () => {
    expect(parseSSELine('')).toBeUndefined()
    expect(parseSSELine(': comment')).toBeUndefined()
  })
})

describe('fromOpenAIStreamChunk — reasoning_content (llama-server --jinja)', () => {
  it('emits thinking_delta for delta.reasoning_content', () => {
    const events = fromOpenAIStreamChunk({
      id: 'c1', model: 'qwen3.6',
      choices: [{ index: 0, delta: { reasoning_content: 'pondering...' } as any, finish_reason: null }],
    })
    expect(events).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering...' } },
    ])
  })

  it('still emits thinking_delta for legacy delta.reasoning', () => {
    const events = fromOpenAIStreamChunk({
      id: 'c1', model: 'gemma4',
      choices: [{ index: 0, delta: { reasoning: 'hmm' } as any, finish_reason: null }],
    })
    expect(events[0].type).toBe('content_block_delta')
    expect((events[0] as any).delta).toEqual({ type: 'thinking_delta', thinking: 'hmm' })
  })
})

describe('fromOpenAIResponse — malformed tool arguments', () => {
  it('repairs trailing-comma arguments', () => {
    const resp = fromOpenAIResponse({
      id: 'r1', model: 'qwen3.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts",}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    const tool = resp.content.find((b: any) => b.type === 'tool_use') as any
    expect(tool.input).toEqual({ file_path: 'a.ts' })
  })

  it('marks unrepairable arguments as malformed (no silent _raw)', () => {
    // fixture: '<tool_call>blah</tool_call>' is verified to throw in jsonrepair
    // ('{oops <<' gets salvaged by jsonrepair — P1.8 fixture caveat)
    const resp = fromOpenAIResponse({
      id: 'r1', model: 'qwen3.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Write', arguments: '<tool_call>blah</tool_call>' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    const tool = resp.content.find((b: any) => b.type === 'tool_use') as any
    expect(tool.input.__malformed).toBe(true)
    expect(tool.input.raw).toBe('<tool_call>blah</tool_call>')
  })
})
