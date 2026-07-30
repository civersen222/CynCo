import { describe, expect, it } from 'bun:test'
import {
  buildSimulatedToolPrompt, extractProseToolCalls, extractSimulatedToolCalls, extractThinkingBlocks,
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

// qwen2.5-coder:32b and devstral-small-2 write the call as ordinary code
// instead of the <tool_call> XML the prompt asks for. Every such call used to
// be dropped, producing a run with zero tool calls that still reported success.
describe('extractProseToolCalls (bare call syntax)', () => {
  const KNOWN = new Set(['Glob', 'Read', 'Bash', 'Edit', 'Grep'])

  it('reads the object-literal form with an unquoted key', () => {
    const r = extractProseToolCalls('Let me look. Glob({ pattern: "*.py" })', KNOWN)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].name).toBe('Glob')
    expect(r.calls[0].input).toEqual({ pattern: '*.py' })
  })

  it('reads the keyword form', () => {
    const r = extractProseToolCalls('Read(file_path="/x/y.py", limit=50)', KNOWN)
    expect(r.calls[0].input).toEqual({ file_path: '/x/y.py', limit: 50 })
  })

  it('reads Python-flavoured literals', () => {
    const r = extractProseToolCalls("Grep(pattern='def foo', multiline=True)", KNOWN)
    expect(r.calls[0].input).toEqual({ pattern: 'def foo', multiline: true })
  })

  it('a Bash command full of commas, quotes and parens survives intact', () => {
    const cmd = 'python -c "print(1, 2)" && ls -la'
    const r = extractProseToolCalls(`Bash({ command: ${JSON.stringify(cmd)} })`, KNOWN)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].input.command).toBe(cmd)
  })

  it('extracts several calls and strips each from the text', () => {
    const r = extractProseToolCalls('First Glob({ pattern: "*.ts" }) then Read(file_path="a.ts") done', KNOWN)
    expect(r.calls.map(c => c.name)).toEqual(['Glob', 'Read'])
    expect(r.remaining).not.toContain('Glob(')
    expect(r.remaining).toContain('done')
  })

  // The name check is the whole defence against mining prose for calls.
  it('ignores names that are not tools', () => {
    expect(extractProseToolCalls('Promise({ a: 1 }) and Array(3)', KNOWN).calls).toHaveLength(0)
  })

  it('ignores a method call on an object', () => {
    expect(extractProseToolCalls('fs.Read(file_path="x")', KNOWN).calls).toHaveLength(0)
  })

  it('an unreadable argument list yields no call rather than a wrong one', () => {
    expect(extractProseToolCalls('Read("just a positional")', KNOWN).calls).toHaveLength(0)
    expect(extractProseToolCalls('Glob({ pattern: "*.py"', KNOWN).calls).toHaveLength(0)
  })
})

describe('bare call syntax through extractSimulatedToolCalls', () => {
  it('rescues a run whose only tool call was written as prose', () => {
    const r = extractSimulatedToolCalls('I will search the project.\n\nGlob({ pattern: "**/*.py" })')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('Glob')
    expect(r.toolCalls[0].input).toEqual({ pattern: '**/*.py' })
  })

  // A model that emits the XML correctly must not also have its narration
  // mined — "I ran Bash(...) earlier" would become a second, unintended call.
  it('does not mine narration when a structured call was found', () => {
    const text = [
      'Earlier I ran Bash({ command: "ls" }).',
      '<tool_call>',
      '{"name": "Read", "arguments": {"file_path": "a.ts"}}',
      '</tool_call>',
    ].join('\n')
    const r = extractSimulatedToolCalls(text)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('Read')
  })

  it('leaves ordinary prose alone', () => {
    expect(extractSimulatedToolCalls('The function foo(bar) returns a list.').toolCalls).toHaveLength(0)
  })
})
