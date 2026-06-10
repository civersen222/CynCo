import { describe, expect, it } from 'bun:test'
import {
  buildSimulatedToolPrompt, extractSimulatedToolCalls, extractThinkingBlocks,
} from '../../ollama/simulated.js'
import type { ToolDefinition } from '../../types.js'

describe('buildSimulatedToolPrompt', () => {
  it('includes tool names, descriptions, and format instructions', () => {
    const tools: ToolDefinition[] = [{
      name: 'bash',
      description: 'Run a shell command',
      input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
    }]
    const prompt = buildSimulatedToolPrompt(tools)
    expect(prompt).toContain('bash')
    expect(prompt).toContain('Run a shell command')
    expect(prompt).toContain('<tool_call>')
    expect(prompt).toContain('</tool_call>')
    expect(prompt).toContain('"name"')
    expect(prompt).toContain('"arguments"')
  })
})

describe('extractSimulatedToolCalls', () => {
  it('extracts a single tool call', () => {
    const text = `I'll check the files.
<tool_call>
{"name": "Bash", "arguments": {"command": "ls -la"}}
</tool_call>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('Bash')
    expect(result.toolCalls[0].input).toEqual({ command: 'ls -la' })
    expect(result.toolCalls[0].id).toMatch(/^sim_/)
    expect(result.remainingText).toBe("I'll check the files.")
  })

  it('extracts multiple tool calls', () => {
    const text = `Let me do two things.
<tool_call>
{"name": "Bash", "arguments": {"command": "ls"}}
</tool_call>
<tool_call>
{"name": "Read", "arguments": {"file_path": "file.ts"}}
</tool_call>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe('Bash')
    expect(result.toolCalls[1].name).toBe('Read')
  })

  it('handles malformed JSON with trailing commas', () => {
    const text = `<tool_call>
{"name": "Bash", "arguments": {"command": "ls",}}
</tool_call>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].input).toEqual({ command: 'ls' })
  })

  it('discards completely unparseable tool calls', () => {
    const text = `<tool_call>
this is not json at all
</tool_call>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(0)
  })

  it('ignores tool calls nested inside <think> tags', () => {
    const text = `<think>
Maybe I should run bash...
<tool_call>
{"name": "bash", "arguments": {"command": "rm -rf /"}}
</tool_call>
No, that's dangerous.
</think>
Here is my safe response.`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.remainingText).toContain('Here is my safe response.')
  })

  it('returns empty array for text with no tool calls', () => {
    const result = extractSimulatedToolCalls('Just a normal response.')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.remainingText).toBe('Just a normal response.')
  })

  it('extracts Hermes-style <function=name> tool calls', () => {
    const text = `Let me read that file.
<function=Read>{"file_path": "/src/main.ts"}</function>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('Read')
    expect(result.toolCalls[0].input).toEqual({ file_path: '/src/main.ts' })
    expect(result.remainingText).toBe('Let me read that file.')
  })

  it('extracts Hermes-style with whitespace inside tags', () => {
    const text = `<function=Bash>
{"command": "git status"}
</function>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('Bash')
    expect(result.toolCalls[0].input).toEqual({ command: 'git status' })
  })

  it('extracts tool calls from fenced JSON code blocks', () => {
    const text = "I'll check the files.\n```json\n{\"name\": \"Bash\", \"arguments\": {\"command\": \"ls -la\"}}\n```"
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('Bash')
    expect(result.toolCalls[0].input).toEqual({ command: 'ls -la' })
  })

  it('ignores fenced JSON blocks that are not tool calls', () => {
    const text = "Here's a config example:\n```json\n{\"port\": 8080, \"host\": \"localhost\"}\n```"
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.remainingText).toContain('config example')
  })

  it('extracts tool calls from mixed formats in one response', () => {
    const text = `Reading first.
<tool_call>
{"name": "Read", "arguments": {"file_path": "a.ts"}}
</tool_call>
Then editing.
<function=Edit>{"file_path": "a.ts", "old_string": "x", "new_string": "y"}</function>`
    const result = extractSimulatedToolCalls(text)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe('Read')
    expect(result.toolCalls[1].name).toBe('Edit')
  })
})

describe('extractThinkingBlocks', () => {
  it('extracts think blocks into ThinkingBlock array', () => {
    const text = `<think>
Let me reason about this.
</think>
Here is my answer.`
    const result = extractThinkingBlocks(text)
    expect(result.thinkingBlocks).toHaveLength(1)
    expect(result.thinkingBlocks[0].type).toBe('thinking')
    expect(result.thinkingBlocks[0].text).toContain('Let me reason about this.')
    expect(result.remainingText).toBe('Here is my answer.')
  })

  it('handles multiple think blocks', () => {
    const text = `<think>First thought.</think>
Some text.
<think>Second thought.</think>
Final answer.`
    const result = extractThinkingBlocks(text)
    expect(result.thinkingBlocks).toHaveLength(2)
    expect(result.thinkingBlocks[0].text).toContain('First thought.')
    expect(result.thinkingBlocks[1].text).toContain('Second thought.')
  })

  it('returns empty array for text with no thinking', () => {
    const result = extractThinkingBlocks('Just a normal response.')
    expect(result.thinkingBlocks).toHaveLength(0)
    expect(result.remainingText).toBe('Just a normal response.')
  })
})
