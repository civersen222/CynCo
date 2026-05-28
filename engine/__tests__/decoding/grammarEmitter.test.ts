import { describe, expect, it } from 'bun:test'
import { generateGBNF, slugify } from '../../decoding/grammarEmitter.js'
import type { ToolImpl } from '../../tools/types.js'

// ─── Fixtures ────────────────────────────────────────────────────

const readTool: ToolImpl = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to read' },
      offset: { type: 'number', description: 'Start line' },
      limit: { type: 'number', description: 'Max lines' },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async () => ({ output: '', isError: false }),
}

const bashTool: ToolImpl = {
  name: 'Bash',
  description: 'Run a shell command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command' },
      timeout: { type: 'number', description: 'Timeout ms' },
    },
    required: ['command'],
  },
  tier: 'approval',
  execute: async () => ({ output: '', isError: false }),
}

const noArgsTool: ToolImpl = {
  name: 'Status',
  description: 'Get status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  tier: 'auto',
  execute: async () => ({ output: '', isError: false }),
}

const allRequiredTool: ToolImpl = {
  name: 'Write',
  description: 'Write a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
  },
  tier: 'approval',
  execute: async () => ({ output: '', isError: false }),
}

// ─── Tests ────────────────────────────────────────────────────────

describe('generateGBNF', () => {
  it('returns empty string for empty tool list', () => {
    expect(generateGBNF([])).toBe('')
  })

  it('produces a grammar with a root rule', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('root ::=')
  })

  it('includes all tool names in alternation', () => {
    const grammar = generateGBNF([readTool, bashTool])
    expect(grammar).toContain('"Read"')
    expect(grammar).toContain('"Bash"')
  })

  it('generates per-tool call rules', () => {
    const grammar = generateGBNF([readTool, bashTool])
    expect(grammar).toContain('read-call ::=')
    expect(grammar).toContain('bash-call ::=')
  })

  it('generates per-tool argument rules', () => {
    const grammar = generateGBNF([readTool, bashTool])
    expect(grammar).toContain('read-args ::=')
    expect(grammar).toContain('bash-args ::=')
  })

  it('handles required fields — required field has no ? wrapper', () => {
    const grammar = generateGBNF([readTool])
    // file_path is required: appears as a plain key-value, not optional
    const lines = grammar.split('\n')
    const argsLine = lines.find(l => l.startsWith('read-args ::='))
    expect(argsLine).toBeDefined()
    // Must include file_path without wrapping in ( ... )?
    expect(argsLine).toContain('"file_path"')
  })

  it('wraps optional fields in ( ... )? groups', () => {
    const grammar = generateGBNF([readTool])
    const lines = grammar.split('\n')
    const argsLine = lines.find(l => l.startsWith('read-args ::='))
    expect(argsLine).toBeDefined()
    // offset and limit are optional — they should appear inside ( ... )?
    expect(argsLine).toMatch(/\(\s*.*"offset".*\)\?/)
    expect(argsLine).toMatch(/\(\s*.*"limit".*\)\?/)
  })

  it('handles tool with all required fields — no optional groups', () => {
    const grammar = generateGBNF([allRequiredTool])
    const lines = grammar.split('\n')
    const argsLine = lines.find(l => l.startsWith('write-args ::='))
    expect(argsLine).toBeDefined()
    // Neither field should be wrapped in ( ... )?
    expect(argsLine).not.toContain(')?')
    expect(argsLine).toContain('"file_path"')
    expect(argsLine).toContain('"content"')
  })

  it('handles tool with no properties', () => {
    const grammar = generateGBNF([noArgsTool])
    const lines = grammar.split('\n')
    const argsLine = lines.find(l => l.startsWith('status-args ::='))
    expect(argsLine).toBeDefined()
    expect(argsLine).toContain('"{" ws "}"')
  })

  it('includes json-string primitive rule', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('json-string ::=')
  })

  it('includes json-number primitive rule', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('json-number ::=')
  })

  it('includes json-boolean primitive rule', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('json-boolean ::=')
  })

  it('includes json-null primitive rule', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('json-null ::=')
  })

  it('includes json-value composite rule', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('json-value ::=')
  })

  it('per-tool call rule contains tool_call XML tags', () => {
    const grammar = generateGBNF([readTool])
    expect(grammar).toContain('<tool_call>')
    expect(grammar).toContain('</tool_call>')
  })

  it('per-tool call rule contains "name" and "arguments" keys', () => {
    const grammar = generateGBNF([readTool])
    const lines = grammar.split('\n')
    const callLine = lines.find(l => l.startsWith('read-call ::='))
    expect(callLine).toBeDefined()
    expect(callLine).toContain('"name"')
    expect(callLine).toContain('"arguments"')
  })

  it('json-call dispatches to all per-tool call rules', () => {
    const grammar = generateGBNF([readTool, bashTool])
    // json-call may span multiple lines when using alternation
    expect(grammar).toContain('json-call ::=')
    // Both tool call variants must appear somewhere after json-call
    const callSection = grammar.slice(grammar.indexOf('json-call ::='))
    expect(callSection).toContain('read-call')
    expect(callSection).toContain('bash-call')
  })

  it('maps string schema to json-string rule', () => {
    const grammar = generateGBNF([readTool])
    const lines = grammar.split('\n')
    const argsLine = lines.find(l => l.startsWith('read-args ::='))
    expect(argsLine).toContain('json-string')
  })

  it('maps number schema to json-number rule', () => {
    const grammar = generateGBNF([readTool])
    const lines = grammar.split('\n')
    const argsLine = lines.find(l => l.startsWith('read-args ::='))
    expect(argsLine).toContain('json-number')
  })

  it('works with a single tool', () => {
    const grammar = generateGBNF([bashTool])
    expect(grammar).toContain('root ::=')
    expect(grammar).toContain('bash-call ::=')
    expect(grammar).toContain('bash-args ::=')
    expect(grammar).toContain('"Bash"')
  })

  it('produces deterministic output for same input', () => {
    const g1 = generateGBNF([readTool, bashTool])
    const g2 = generateGBNF([readTool, bashTool])
    expect(g1).toBe(g2)
  })
})

describe('slugify', () => {
  it('lowercases names', () => {
    expect(slugify('Read')).toBe('read')
  })

  it('converts CamelCase to lowercase', () => {
    expect(slugify('CodeIndex')).toBe('codeindex')
  })

  it('preserves hyphens', () => {
    expect(slugify('web-search')).toBe('web-search')
  })

  it('replaces spaces with hyphens', () => {
    expect(slugify('my tool')).toBe('my-tool')
  })

  it('collapses multiple hyphens', () => {
    expect(slugify('my--tool')).toBe('my-tool')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugify('-tool-')).toBe('tool')
  })
})
