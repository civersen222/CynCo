import { describe, expect, it } from 'bun:test'
import { validateToolCall } from '../../decoding/postValidator.js'
import type { ToolImpl } from '../../tools/types.js'

// ─── Test Fixtures ────────────────────────────────────────────────

/** Build a minimal ToolImpl for testing */
function makeTool(overrides: Partial<ToolImpl> & { name: string }): ToolImpl {
  return {
    name: overrides.name,
    description: overrides.description ?? 'A test tool',
    inputSchema: overrides.inputSchema ?? {
      type: 'object',
      properties: {},
      required: [],
    },
    tier: overrides.tier ?? 'auto',
    execute: overrides.execute ?? (async () => ({ output: '', isError: false })),
  }
}

/** Build a Map<string, ToolImpl> from an array of tools */
function makeRegistry(...tools: ToolImpl[]): Map<string, ToolImpl> {
  return new Map(tools.map(t => [t.name, t]))
}

// ─── Fixtures ─────────────────────────────────────────────────────

const readTool = makeTool({
  name: 'Read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
    required: ['file_path'],
  },
})

const bashTool = makeTool({
  name: 'Bash',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
      background: { type: 'boolean' },
      args: { type: 'array' },
      env: { type: 'object' },
    },
    required: ['command'],
  },
})

// ─── Tests: valid call passes ──────────────────────────────────────

describe('validateToolCall — valid calls', () => {
  it('returns valid=true and empty errors for a correct call', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/tmp/foo.ts' } },
      registry,
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.correctionMessage).toBe('')
  })

  it('passes with all required and optional fields provided', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/tmp/foo.ts', limit: 100, offset: 0 } },
      registry,
    )
    expect(result.valid).toBe(true)
  })

  it('passes when no required fields are declared', () => {
    const noReqTool = makeTool({
      name: 'NoReq',
      inputSchema: {
        type: 'object',
        properties: { optional_field: { type: 'string' } },
      },
    })
    const result = validateToolCall(
      { name: 'NoReq', input: {} },
      makeRegistry(noReqTool),
    )
    expect(result.valid).toBe(true)
  })
})

// ─── Tests: unknown tool name ──────────────────────────────────────

describe('validateToolCall — unknown tool name', () => {
  it('fails when the tool is not in the registry', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'NonExistent', input: {} },
      registry,
    )
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('error message mentions the unknown tool name', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'GhostTool', input: {} },
      registry,
    )
    expect(result.errors[0]).toContain('GhostTool')
  })

  it('error message lists available tools', () => {
    const registry = makeRegistry(readTool, bashTool)
    const result = validateToolCall(
      { name: 'MissingTool', input: {} },
      registry,
    )
    expect(result.errors[0]).toContain('Read')
    expect(result.errors[0]).toContain('Bash')
  })
})

// ─── Tests: missing required field ────────────────────────────────

describe('validateToolCall — missing required field', () => {
  it('fails when a required field is absent', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'Read', input: {} }, // file_path missing
      registry,
    )
    expect(result.valid).toBe(false)
  })

  it('error message mentions the missing field name', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'Read', input: {} },
      registry,
    )
    expect(result.errors[0]).toContain('file_path')
  })

  it('reports each missing required field separately', () => {
    const multiReqTool = makeTool({
      name: 'MultiReq',
      inputSchema: {
        type: 'object',
        properties: {
          alpha: { type: 'string' },
          beta: { type: 'string' },
          gamma: { type: 'string' },
        },
        required: ['alpha', 'beta', 'gamma'],
      },
    })
    const result = validateToolCall(
      { name: 'MultiReq', input: { alpha: 'x' } }, // beta and gamma missing
      makeRegistry(multiReqTool),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBe(2)
    const errorText = result.errors.join('\n')
    expect(errorText).toContain('beta')
    expect(errorText).toContain('gamma')
  })
})

// ─── Tests: extra fields are allowed ──────────────────────────────

describe('validateToolCall — extra fields', () => {
  it('extra fields not in schema are allowed and do not cause failure', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/tmp/x.ts', unknownExtraField: 42 } },
      registry,
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('extra fields produce no errors even when required fields missing from schema', () => {
    const noReqTool = makeTool({
      name: 'NoReq',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    })
    const result = validateToolCall(
      { name: 'NoReq', input: { totally_unknown: 'whatever', another: 99 } },
      makeRegistry(noReqTool),
    )
    expect(result.valid).toBe(true)
  })
})

// ─── Tests: wrong type for required field ─────────────────────────

describe('validateToolCall — type checking', () => {
  it('fails when a string field receives a number', () => {
    const registry = makeRegistry(readTool)
    const result = validateToolCall(
      { name: 'Read', input: { file_path: 123 } }, // number instead of string
      registry,
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('file_path')
    expect(result.errors[0]).toContain('string')
    expect(result.errors[0]).toContain('number')
  })

  it('fails when a boolean field receives a string', () => {
    const result = validateToolCall(
      { name: 'Bash', input: { command: 'echo hi', background: 'yes' } },
      makeRegistry(bashTool),
    )
    expect(result.valid).toBe(false)
    const errText = result.errors.join('\n')
    expect(errText).toContain('background')
    expect(errText).toContain('boolean')
    expect(errText).toContain('string')
  })

  it('fails when an array field receives an object', () => {
    const result = validateToolCall(
      { name: 'Bash', input: { command: 'ls', args: { not: 'an array' } } },
      makeRegistry(bashTool),
    )
    expect(result.valid).toBe(false)
    const errText = result.errors.join('\n')
    expect(errText).toContain('args')
    expect(errText).toContain('array')
  })

  it('accepts integer for integer-typed field', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/tmp/x.ts', limit: 50 } },
      makeRegistry(readTool),
    )
    expect(result.valid).toBe(true)
  })

  it('fails when integer field receives a string', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/tmp/x.ts', limit: 'fifty' } },
      makeRegistry(readTool),
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('limit')
  })

  it('skips type check for anyOf fields (union types)', () => {
    const unionTool = makeTool({
      name: 'Union',
      inputSchema: {
        type: 'object',
        properties: {
          value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['value'],
      },
    })
    // Both string and number should pass without errors
    const r1 = validateToolCall(
      { name: 'Union', input: { value: 'hello' } },
      makeRegistry(unionTool),
    )
    expect(r1.valid).toBe(true)

    const r2 = validateToolCall(
      { name: 'Union', input: { value: 42 } },
      makeRegistry(unionTool),
    )
    expect(r2.valid).toBe(true)
  })
})

// ─── Tests: correctionMessage includes schema ──────────────────────

describe('validateToolCall — correctionMessage', () => {
  it('correctionMessage is empty when valid', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/tmp/x.ts' } },
      makeRegistry(readTool),
    )
    expect(result.correctionMessage).toBe('')
  })

  it('correctionMessage includes the specific error when invalid', () => {
    const result = validateToolCall(
      { name: 'Read', input: {} }, // missing file_path
      makeRegistry(readTool),
    )
    expect(result.correctionMessage).toContain('file_path')
  })

  it('correctionMessage includes the full schema JSON when invalid', () => {
    const result = validateToolCall(
      { name: 'Read', input: {} },
      makeRegistry(readTool),
    )
    // The schema JSON should include properties and required arrays
    expect(result.correctionMessage).toContain('"file_path"')
    expect(result.correctionMessage).toContain('"required"')
    expect(result.correctionMessage).toContain('"properties"')
  })

  it('correctionMessage includes schema even for type errors', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: 999 } },
      makeRegistry(readTool),
    )
    expect(result.correctionMessage).toContain('"type"')
    expect(result.correctionMessage).toContain('"string"')
  })

  it('correctionMessage for unknown tool does not crash (no schema available)', () => {
    const result = validateToolCall(
      { name: 'Ghost', input: {} },
      makeRegistry(readTool),
    )
    expect(result.valid).toBe(false)
    expect(result.correctionMessage).toContain('Ghost')
    // No schema to include for unknown tool — just check it doesn't throw
    expect(typeof result.correctionMessage).toBe('string')
  })
})
