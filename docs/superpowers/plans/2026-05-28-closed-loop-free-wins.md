# Closed-Loop Free Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four independent subsystems — constrained decoding, best-of-N execution selection, tree-sitter repo map with hybrid retrieval, and cybernetic control loop wiring with trajectory recording — that improve CynCo immediately with zero training.

**Architecture:** Four loosely coupled modules with optional hooks between them. Each subsystem degrades gracefully if the others aren't present. Grammar enforcement eliminates silent tool-call drops. Best-of-N samples multiple candidate solutions and selects by test results. Tree-sitter replaces regex chunking and adds BM25 alongside vector search. The control loop wires variety entropy to temperature control and starts collecting trajectory data for future training.

**Tech Stack:** TypeScript (Bun), tree-sitter (native bindings), sqlite-vec, GBNF grammar (llama.cpp), git worktrees

---

## File Map

### Subsystem 1: Constrained Decoding
| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `engine/decoding/grammarEmitter.ts` | Generate GBNF grammar from tool schemas |
| Create | `engine/decoding/postValidator.ts` | Validate tool calls against schemas, corrective re-prompt |
| Modify | `engine/llama/provider.ts:199-218` | Add `grammar` to request body |
| Modify | `engine/engine/callModel.ts:326-338` | Pass grammar to CompletionRequest |
| Modify | `engine/provider.ts:45-54` | Add `grammar` field to CompletionRequest |
| Test | `engine/__tests__/decoding/grammarEmitter.test.ts` | Grammar generation tests |
| Test | `engine/__tests__/decoding/postValidator.test.ts` | Validation tests |

### Subsystem 2: Best-of-N
| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `engine/bestOfN/testDetector.ts` | Detect test infrastructure per project |
| Create | `engine/bestOfN/worktreeManager.ts` | Git worktree lifecycle (create/cleanup) |
| Create | `engine/bestOfN/patchExtractor.ts` | Extract git diff from worktree |
| Create | `engine/bestOfN/sampler.ts` | Orchestrate N candidates, score, select |
| Create | `engine/bestOfN/types.ts` | Shared types for best-of-N |
| Modify | `engine/bridge/conversationLoop.ts` | Activation hook |
| Test | `engine/__tests__/bestOfN/testDetector.test.ts` | Detection tests |
| Test | `engine/__tests__/bestOfN/worktreeManager.test.ts` | Worktree lifecycle tests |
| Test | `engine/__tests__/bestOfN/patchExtractor.test.ts` | Diff extraction tests |
| Test | `engine/__tests__/bestOfN/sampler.test.ts` | Scoring/selection tests |

### Subsystem 3: Tree-sitter + Hybrid Retrieval
| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `engine/retrieval/treeSitterChunker.ts` | AST-based chunking |
| Create | `engine/retrieval/repoMap.ts` | Definition graph + PageRank |
| Create | `engine/retrieval/bm25Index.ts` | BM25 keyword scoring in SQLite |
| Create | `engine/retrieval/hybridSearch.ts` | Reciprocal-rank fusion |
| Modify | `engine/index/chunker.ts` | Delegate to tree-sitter, regex fallback |
| Modify | `engine/index/store.ts:5-32,39,49-54` | BM25 table, dynamic embed dim |
| Modify | `engine/index/indexer.ts:19-24,120-132` | Wire hybrid search, repo map |
| Modify | `engine/index/embedClient.ts:11-13` | Expose dimension detection |
| Test | `engine/__tests__/retrieval/treeSitterChunker.test.ts` | AST chunking tests |
| Test | `engine/__tests__/retrieval/bm25Index.test.ts` | BM25 scoring tests |
| Test | `engine/__tests__/retrieval/repoMap.test.ts` | Graph + PageRank tests |
| Test | `engine/__tests__/retrieval/hybridSearch.test.ts` | Fusion tests |

### Subsystem 4: Control Loop Wiring
| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `engine/training/trajectoryRecorder.ts` | Per-turn JSONL trajectory writer |
| Create | `engine/training/rewardLabeler.ts` | Task-end reward computation |
| Modify | `engine/vsm/cyberneticsGovernance.ts:340-360,580-608` | Export getControlSignals() |
| Modify | `engine/vsm/governanceParams.ts:150-161` | Add variety control params |
| Modify | `engine/vsm/algedonicIntegration.ts:38-93` | Wire scalar to trajectory |
| Modify | `engine/bridge/conversationLoop.ts` | Temperature control, trajectory hooks |
| Test | `engine/__tests__/training/trajectoryRecorder.test.ts` | Recording tests |
| Test | `engine/__tests__/training/rewardLabeler.test.ts` | Reward formula tests |
| Test | `engine/__tests__/vsm/controlSignals.test.ts` | Control signal tests |

---

## Subsystem 1: Constrained Decoding

### Task 1: GBNF Grammar Emitter

**Files:**
- Create: `engine/decoding/grammarEmitter.ts`
- Test: `engine/__tests__/decoding/grammarEmitter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/decoding/grammarEmitter.test.ts
import { describe, test, expect } from 'bun:test'
import { generateGBNF } from '../../decoding/grammarEmitter.js'
import type { ToolImpl } from '../../tools/types.js'

const mockReadTool: ToolImpl = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to file' },
      offset: { type: 'number', description: 'Line offset' },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async () => ({ output: '', isError: false }),
}

const mockEditTool: ToolImpl = {
  name: 'Edit',
  description: 'Edit a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'File to edit' },
      old_string: { type: 'string', description: 'Text to find' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  tier: 'approval',
  execute: async () => ({ output: '', isError: false }),
}

describe('generateGBNF', () => {
  test('produces valid GBNF with root rule', () => {
    const grammar = generateGBNF([mockReadTool])
    expect(grammar).toContain('root ::=')
    expect(grammar).toContain('tool-call')
    expect(grammar).toContain('"Read"')
  })

  test('includes all tool names in tool-name alternation', () => {
    const grammar = generateGBNF([mockReadTool, mockEditTool])
    expect(grammar).toContain('"Read"')
    expect(grammar).toContain('"Edit"')
  })

  test('generates per-tool argument rules', () => {
    const grammar = generateGBNF([mockReadTool])
    expect(grammar).toContain('read-args')
    expect(grammar).toContain('"file_path"')
  })

  test('handles required fields', () => {
    const grammar = generateGBNF([mockEditTool])
    // Required fields must appear in the grammar
    expect(grammar).toContain('"file_path"')
    expect(grammar).toContain('"old_string"')
    expect(grammar).toContain('"new_string"')
  })

  test('returns empty string for empty tool list', () => {
    const grammar = generateGBNF([])
    expect(grammar).toBe('')
  })

  test('includes json-string primitive rule', () => {
    const grammar = generateGBNF([mockReadTool])
    expect(grammar).toContain('json-string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/decoding/grammarEmitter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement grammarEmitter.ts**

```typescript
// engine/decoding/grammarEmitter.ts
import type { ToolImpl } from '../tools/types.js'

/**
 * Generate a GBNF grammar from CynCo's tool schemas.
 * The grammar constrains llama.cpp output to valid <tool_call> XML
 * with correct JSON arguments per tool.
 */
export function generateGBNF(tools: ToolImpl[]): string {
  if (tools.length === 0) return ''

  const rules: string[] = []

  // Primitives
  rules.push('ws ::= [ \\t\\n]*')
  rules.push('json-string ::= "\\"" ([^"\\\\] | "\\\\" .)* "\\""')
  rules.push('json-number ::= "-"? [0-9]+ ("." [0-9]+)?')
  rules.push('json-bool ::= "true" | "false"')
  rules.push('json-null ::= "null"')
  rules.push('json-value ::= json-string | json-number | json-bool | json-null')

  // Root: one or more tool calls, optionally with text between
  rules.push('root ::= (text-segment? tool-call ws)+ text-segment?')
  rules.push('text-segment ::= [^<]+')

  // Tool call wrapper
  rules.push('tool-call ::= "<tool_call>" ws tool-obj ws "</tool_call>"')

  // Tool object: {"name": <name>, "arguments": <args>}
  const nameAlts = tools.map(t => `"\\\"${t.name}\\\""`).join(' | ')
  rules.push(`tool-name ::= ${nameAlts}`)

  // Build per-tool argument dispatching
  const argAlts = tools.map(t => `${slugify(t.name)}-args`).join(' | ')
  rules.push(`tool-args ::= ${argAlts}`)

  rules.push(`tool-obj ::= "{" ws "\\"name\\"" ws ":" ws tool-name ws "," ws "\\"arguments\\"" ws ":" ws tool-args ws "}"`)

  // Per-tool argument schemas
  for (const tool of tools) {
    const slug = slugify(tool.name)
    const props = tool.inputSchema.properties ?? {}
    const entries = Object.entries(props)

    if (entries.length === 0) {
      rules.push(`${slug}-args ::= "{" ws "}"`)
      continue
    }

    // Build a flat JSON object rule with all properties as optional key-value pairs
    // Required fields are always included; optional fields use the ? operator
    const required = new Set(tool.inputSchema.required ?? [])
    const kvPairs: string[] = []

    for (const [key, schema] of entries) {
      const valueRule = jsonSchemaToGBNF(schema as Record<string, unknown>)
      kvPairs.push(`"\\"${key}\\"" ws ":" ws ${valueRule}`)
    }

    // Simple approach: all properties in fixed order, separated by commas
    // Required ones always present, optional ones wrapped in ( ... )?
    const parts: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const [key] = entries[i]
      const isRequired = required.has(key)
      const comma = i > 0 ? `ws "," ws ` : ''
      if (isRequired) {
        parts.push(`${comma}${kvPairs[i]}`)
      } else {
        parts.push(`(${comma}${kvPairs[i]})?`)
      }
    }

    rules.push(`${slug}-args ::= "{" ws ${parts.join(' ')} ws "}"`)
  }

  return rules.join('\n')
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-')
}

function jsonSchemaToGBNF(schema: Record<string, unknown>): string {
  const type = schema.type as string | undefined
  switch (type) {
    case 'string': return 'json-string'
    case 'number':
    case 'integer': return 'json-number'
    case 'boolean': return 'json-bool'
    default: return 'json-value'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/decoding/grammarEmitter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/decoding/grammarEmitter.ts engine/__tests__/decoding/grammarEmitter.test.ts
git commit -m "feat: GBNF grammar emitter from tool schemas"
```

---

### Task 2: Post-Validator

**Files:**
- Create: `engine/decoding/postValidator.ts`
- Test: `engine/__tests__/decoding/postValidator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/decoding/postValidator.test.ts
import { describe, test, expect } from 'bun:test'
import { validateToolCall, type ValidationResult } from '../../decoding/postValidator.js'
import type { ToolImpl } from '../../tools/types.js'

const readTool: ToolImpl = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path' },
      offset: { type: 'number', description: 'Offset' },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async () => ({ output: '', isError: false }),
}

const toolRegistry = new Map<string, ToolImpl>([['Read', readTool]])

describe('validateToolCall', () => {
  test('valid call passes', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/foo.ts' } },
      toolRegistry,
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('unknown tool name fails', () => {
    const result = validateToolCall(
      { name: 'FakeTool', input: {} },
      toolRegistry,
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('FakeTool')
  })

  test('missing required field fails', () => {
    const result = validateToolCall(
      { name: 'Read', input: { offset: 5 } },
      toolRegistry,
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('file_path')
  })

  test('extra fields are allowed', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: '/foo', extra: true } },
      toolRegistry,
    )
    expect(result.valid).toBe(true)
  })

  test('wrong type for required field fails', () => {
    const result = validateToolCall(
      { name: 'Read', input: { file_path: 123 } },
      toolRegistry,
    )
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('file_path')
  })

  test('buildCorrectionMessage includes schema', () => {
    const result = validateToolCall(
      { name: 'Read', input: {} },
      toolRegistry,
    )
    expect(result.correctionMessage).toContain('file_path')
    expect(result.correctionMessage).toContain('required')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/decoding/postValidator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement postValidator.ts**

```typescript
// engine/decoding/postValidator.ts
import type { ToolImpl } from '../tools/types.js'

export type ToolCallInput = {
  name: string
  input: Record<string, unknown>
}

export type ValidationResult = {
  valid: boolean
  errors: string[]
  correctionMessage: string
}

/**
 * Validate a tool call against the tool registry's schema.
 * Returns validation result with specific error messages and a
 * corrective prompt for re-prompting the model.
 */
export function validateToolCall(
  call: ToolCallInput,
  registry: Map<string, ToolImpl>,
): ValidationResult {
  const errors: string[] = []

  // Check tool exists
  const tool = registry.get(call.name)
  if (!tool) {
    const known = [...registry.keys()].join(', ')
    errors.push(`Unknown tool "${call.name}". Available tools: ${known}`)
    return {
      valid: false,
      errors,
      correctionMessage: `Tool call invalid: unknown tool "${call.name}". Available tools: ${known}. Try again with a valid tool name.`,
    }
  }

  // Check required fields
  const schema = tool.inputSchema
  const required = schema.required ?? []
  for (const field of required) {
    if (!(field in call.input)) {
      errors.push(`Missing required field "${field}" for tool "${call.name}"`)
    }
  }

  // Type check known fields
  const props = schema.properties ?? {}
  for (const [key, value] of Object.entries(call.input)) {
    const propSchema = props[key] as Record<string, unknown> | undefined
    if (!propSchema) continue // extra fields allowed
    const expectedType = propSchema.type as string | undefined
    if (expectedType && !matchesType(value, expectedType)) {
      errors.push(`Field "${key}" for tool "${call.name}" should be ${expectedType}, got ${typeof value}`)
    }
  }

  if (errors.length === 0) {
    return { valid: true, errors: [], correctionMessage: '' }
  }

  // Build correction message with full schema
  const schemaStr = JSON.stringify(schema, null, 2)
  const correctionMessage = `Tool call invalid: ${errors.join('; ')}. The schema for "${call.name}" is:\n${schemaStr}\nTry again with correct arguments.`

  return { valid: false, errors, correctionMessage }
}

function matchesType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string': return typeof value === 'string'
    case 'number':
    case 'integer': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    default: return true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/decoding/postValidator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/decoding/postValidator.ts engine/__tests__/decoding/postValidator.test.ts
git commit -m "feat: post-validator for tool call schema enforcement"
```

---

### Task 3: Wire grammar into providers

**Files:**
- Modify: `engine/provider.ts:45-54`
- Modify: `engine/llama/provider.ts:199-218`
- Modify: `engine/engine/callModel.ts:326-338`

- [ ] **Step 1: Add grammar field to CompletionRequest**

In `engine/provider.ts`, add `grammar` to the request type:

```typescript
// engine/provider.ts — add grammar field to CompletionRequest
export type CompletionRequest = {
  model: string
  messages: Message[]
  system?: string
  tools?: ToolDefinition[]
  max_tokens?: number
  temperature?: number
  stop_sequences?: string[]
  thinking?: { enabled: boolean; budget_tokens?: number }
  grammar?: string  // GBNF grammar for constrained decoding (llama.cpp)
}
```

- [ ] **Step 2: Pass grammar in llama.cpp provider buildRequestBody**

In `engine/llama/provider.ts`, add grammar to the request body in `buildRequestBody()`:

```typescript
// engine/llama/provider.ts — in buildRequestBody(), after the tools line (line 209)
    if (request.grammar) body.grammar = request.grammar
```

- [ ] **Step 3: Wire grammar generation into callModel**

In `engine/engine/callModel.ts`, after building the CompletionRequest (around line 327), add grammar when using simulated tool mode and llama.cpp:

```typescript
// engine/engine/callModel.ts — after request construction (line 333), before streaming
  // Add GBNF grammar for constrained decoding on simulated tool use
  if (simulatedToolUse && process.env.LOCALCODE_GRAMMAR_ENABLED !== 'false') {
    try {
      const { generateGBNF } = await import('../decoding/grammarEmitter.js')
      const { ALL_TOOLS } = await import('../tools/registry.js')
      // Filter to the active tool set
      const activeTools = ALL_TOOLS.filter(t => toolDefs.some(td => td.name === t.name))
      const grammar = generateGBNF(activeTools)
      if (grammar && provider.name === 'llama-cpp') {
        request.grammar = grammar
      }
    } catch (e) {
      console.log(`[callModel] Grammar generation failed, continuing without: ${e}`)
    }
  }
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `cd engine && bun test __tests__/`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add engine/provider.ts engine/llama/provider.ts engine/engine/callModel.ts
git commit -m "feat: wire GBNF grammar into llama.cpp provider pipeline"
```

---

### Task 4: Wire post-validation into tool call extraction

**Files:**
- Modify: `engine/bridge/conversationLoop.ts` (tool call extraction section)
- Modify: `engine/ollama/simulated.ts:65-93`

- [ ] **Step 1: Add post-validation after simulated tool call extraction**

In `engine/ollama/simulated.ts`, add validation after extraction. Change `extractSimulatedToolCalls`:

```typescript
// engine/ollama/simulated.ts — add import at top
import { validateToolCall } from '../decoding/postValidator.js'
import { ALL_TOOLS } from '../tools/registry.js'
```

After the extraction loop in `extractSimulatedToolCalls` (line 87), before the return, add validation:

```typescript
  // Post-validate extracted tool calls
  const toolMap = new Map(ALL_TOOLS.map(t => [t.name, t]))
  const validCalls: SimulatedToolCall[] = []
  const invalidMessages: string[] = []

  for (const call of toolCalls) {
    const result = validateToolCall({ name: call.name, input: call.input }, toolMap)
    if (result.valid) {
      validCalls.push(call)
    } else {
      console.log(`[simulated] Invalid tool call "${call.name}": ${result.errors.join('; ')}`)
      invalidMessages.push(result.correctionMessage)
    }
  }

  return {
    toolCalls: validCalls,
    remainingText: remaining.trim(),
    validationErrors: invalidMessages,
  }
```

Update the return type `ExtractToolCallsResult` to include `validationErrors`:

```typescript
type ExtractToolCallsResult = {
  toolCalls: SimulatedToolCall[]
  remainingText: string
  validationErrors?: string[]
}
```

- [ ] **Step 2: Handle validation errors in conversationLoop**

In `engine/bridge/conversationLoop.ts`, where simulated tool calls are extracted (the fallback path around line 1365-1384), check for validation errors and inject corrective message if any exist. If `validationErrors` is non-empty and we haven't exceeded 2 correction attempts, prepend a corrective system message and continue the loop instead of dispatching tools.

The engineer should find the tool extraction section (search for `extractSimulatedToolCalls`) and add:

```typescript
  // If post-validation found errors and we haven't exhausted corrections
  if (extractResult.validationErrors?.length && (this._correctionAttempts ?? 0) < 2) {
    this._correctionAttempts = (this._correctionAttempts ?? 0) + 1
    const correction = extractResult.validationErrors.join('\n\n')
    this.messages.push({
      role: 'user',
      content: [{ type: 'text', text: `[System] ${correction}` }],
    })
    continue // re-prompt the model
  }
  this._correctionAttempts = 0 // reset on successful extraction
```

- [ ] **Step 3: Run existing tests**

Run: `cd engine && bun test __tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/ollama/simulated.ts engine/bridge/conversationLoop.ts
git commit -m "feat: post-validation for tool calls with corrective re-prompting"
```

---

## Subsystem 2: Best-of-N

### Task 5: Types and Test Detector

**Files:**
- Create: `engine/bestOfN/types.ts`
- Create: `engine/bestOfN/testDetector.ts`
- Test: `engine/__tests__/bestOfN/testDetector.test.ts`

- [ ] **Step 1: Write types**

```typescript
// engine/bestOfN/types.ts
export type TestInfo = {
  available: boolean
  command: string
  framework: string
}

export type CandidateResult = {
  index: number
  worktreePath: string
  patch: string
  testsPassed: number
  testsTotal: number
  passRate: number
  stuckTurns: number
  totalTurns: number
}

export type SamplerConfig = {
  n: number             // number of candidates
  temperature: number   // sampling temperature
  turnCap: number       // max turns per candidate
  cwd: string           // project root
  testInfo: TestInfo
}

export type SamplerResult = {
  winner: CandidateResult | null
  candidates: CandidateResult[]
  skipped: boolean       // true if best-of-N was skipped (no tests, disabled, etc.)
  skipReason?: string
}
```

- [ ] **Step 2: Write the failing test for testDetector**

```typescript
// engine/__tests__/bestOfN/testDetector.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { detectTests } from '../../bestOfN/testDetector.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

describe('detectTests', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cynco-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('detects pytest via pytest.ini', () => {
    writeFileSync(join(tmpDir, 'pytest.ini'), '[pytest]\n')
    const result = detectTests(tmpDir)
    expect(result.available).toBe(true)
    expect(result.framework).toBe('pytest')
    expect(result.command).toContain('pytest')
  })

  test('detects jest via jest.config.js', () => {
    writeFileSync(join(tmpDir, 'jest.config.js'), 'module.exports = {}')
    const result = detectTests(tmpDir)
    expect(result.available).toBe(true)
    expect(result.framework).toBe('jest')
  })

  test('detects bun test via package.json test script', () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { test: 'bun test' },
    }))
    const result = detectTests(tmpDir)
    expect(result.available).toBe(true)
    expect(result.command).toContain('bun test')
  })

  test('detects go tests via _test.go files', () => {
    writeFileSync(join(tmpDir, 'main_test.go'), 'package main')
    const result = detectTests(tmpDir)
    expect(result.available).toBe(true)
    expect(result.framework).toBe('go')
  })

  test('returns unavailable for empty project', () => {
    const result = detectTests(tmpDir)
    expect(result.available).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd engine && bun test __tests__/bestOfN/testDetector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement testDetector.ts**

```typescript
// engine/bestOfN/testDetector.ts
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { TestInfo } from './types.js'

const NO_TESTS: TestInfo = { available: false, command: '', framework: '' }

/**
 * Detect test infrastructure in a project directory.
 * Returns the test command and framework if found.
 */
export function detectTests(projectRoot: string): TestInfo {
  // Python: pytest
  if (existsSync(join(projectRoot, 'pytest.ini')) ||
      existsSync(join(projectRoot, 'conftest.py')) ||
      hasPyprojectPytest(projectRoot) ||
      existsSync(join(projectRoot, 'setup.cfg')) && fileContains(join(projectRoot, 'setup.cfg'), '[tool:pytest]')) {
    return { available: true, command: 'python -m pytest', framework: 'pytest' }
  }
  if (existsSync(join(projectRoot, 'tests')) && hasFilesWithExt(join(projectRoot, 'tests'), '.py')) {
    return { available: true, command: 'python -m pytest tests/', framework: 'pytest' }
  }

  // JavaScript/TypeScript: jest, vitest, bun test
  if (existsSync(join(projectRoot, 'jest.config.js')) ||
      existsSync(join(projectRoot, 'jest.config.ts')) ||
      existsSync(join(projectRoot, 'jest.config.mjs'))) {
    return { available: true, command: 'npx jest', framework: 'jest' }
  }
  if (existsSync(join(projectRoot, 'vitest.config.ts')) ||
      existsSync(join(projectRoot, 'vitest.config.js'))) {
    return { available: true, command: 'npx vitest run', framework: 'vitest' }
  }

  // package.json test script
  const pkgPath = join(projectRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const testScript = pkg.scripts?.test
      if (testScript && testScript !== 'echo "Error: no test specified" && exit 1') {
        const framework = testScript.includes('jest') ? 'jest' :
                          testScript.includes('vitest') ? 'vitest' :
                          testScript.includes('bun test') ? 'bun' : 'npm'
        return { available: true, command: testScript, framework }
      }
    } catch {}
  }

  // Rust: Cargo.toml
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return { available: true, command: 'cargo test', framework: 'cargo' }
  }

  // Go: *_test.go files
  if (hasFilesMatching(projectRoot, /_test\.go$/)) {
    return { available: true, command: 'go test ./...', framework: 'go' }
  }

  return NO_TESTS
}

function hasPyprojectPytest(root: string): boolean {
  const pyproj = join(root, 'pyproject.toml')
  return existsSync(pyproj) && fileContains(pyproj, '[tool.pytest')
}

function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(path, 'utf-8').includes(needle)
  } catch {
    return false
  }
}

function hasFilesWithExt(dir: string, ext: string): boolean {
  try {
    return readdirSync(dir).some(f => f.endsWith(ext))
  } catch {
    return false
  }
}

function hasFilesMatching(dir: string, pattern: RegExp): boolean {
  try {
    return readdirSync(dir).some(f => pattern.test(f))
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd engine && bun test __tests__/bestOfN/testDetector.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -f engine/bestOfN/types.ts engine/bestOfN/testDetector.ts engine/__tests__/bestOfN/testDetector.test.ts
git commit -m "feat: test infrastructure detector for best-of-N"
```

---

### Task 6: Worktree Manager

**Files:**
- Create: `engine/bestOfN/worktreeManager.ts`
- Test: `engine/__tests__/bestOfN/worktreeManager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/bestOfN/worktreeManager.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WorktreeManager } from '../../bestOfN/worktreeManager.js'
import { execSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

describe('WorktreeManager', () => {
  let repoDir: string
  let manager: WorktreeManager

  beforeEach(() => {
    // Create a temporary git repo
    repoDir = join(tmpdir(), `cynco-wt-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(repoDir, { recursive: true })
    execSync('git init', { cwd: repoDir })
    execSync('git config user.email "test@test.com"', { cwd: repoDir })
    execSync('git config user.name "Test"', { cwd: repoDir })
    writeFileSync(join(repoDir, 'hello.txt'), 'hello')
    execSync('git add . && git commit -m "init"', { cwd: repoDir })
    manager = new WorktreeManager(repoDir)
  })

  afterEach(() => {
    manager.cleanupAll()
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('creates a worktree and returns path', async () => {
    const wt = await manager.create()
    expect(existsSync(wt)).toBe(true)
    expect(existsSync(join(wt, 'hello.txt'))).toBe(true)
  })

  test('creates multiple worktrees', async () => {
    const wt1 = await manager.create()
    const wt2 = await manager.create()
    expect(wt1).not.toBe(wt2)
    expect(existsSync(wt1)).toBe(true)
    expect(existsSync(wt2)).toBe(true)
  })

  test('cleanupAll removes all worktrees', async () => {
    const wt1 = await manager.create()
    const wt2 = await manager.create()
    manager.cleanupAll()
    // Worktrees should be removed from git
    const list = execSync('git worktree list', { cwd: repoDir }).toString()
    expect(list).not.toContain(wt1)
    expect(list).not.toContain(wt2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/bestOfN/worktreeManager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement worktreeManager.ts**

```typescript
// engine/bestOfN/worktreeManager.ts
import { execSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

/**
 * Manages git worktrees for best-of-N candidate isolation.
 * Each worktree is a full copy of the repo at HEAD.
 */
export class WorktreeManager {
  private repoRoot: string
  private worktrees: string[] = []

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot
  }

  /** Create a new detached worktree from HEAD. Returns the path. */
  async create(): Promise<string> {
    const id = randomUUID().slice(0, 8)
    const wtPath = join(tmpdir(), `cynco-bestofn-${id}`)

    execSync(`git worktree add --detach "${wtPath}"`, {
      cwd: this.repoRoot,
      stdio: 'pipe',
    })

    this.worktrees.push(wtPath)
    return wtPath
  }

  /** Remove a specific worktree. */
  cleanup(wtPath: string): void {
    try {
      execSync(`git worktree remove --force "${wtPath}"`, {
        cwd: this.repoRoot,
        stdio: 'pipe',
      })
    } catch {
      // If git worktree remove fails, try manual cleanup
      try {
        if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true })
        execSync('git worktree prune', { cwd: this.repoRoot, stdio: 'pipe' })
      } catch {}
    }
    this.worktrees = this.worktrees.filter(w => w !== wtPath)
  }

  /** Remove all managed worktrees. */
  cleanupAll(): void {
    for (const wt of [...this.worktrees]) {
      this.cleanup(wt)
    }
  }

  /** Get list of active worktree paths. */
  getActive(): string[] {
    return [...this.worktrees]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/bestOfN/worktreeManager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/bestOfN/worktreeManager.ts engine/__tests__/bestOfN/worktreeManager.test.ts
git commit -m "feat: git worktree manager for best-of-N sandboxing"
```

---

### Task 7: Patch Extractor

**Files:**
- Create: `engine/bestOfN/patchExtractor.ts`
- Test: `engine/__tests__/bestOfN/patchExtractor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/bestOfN/patchExtractor.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { extractPatch } from '../../bestOfN/patchExtractor.js'
import { execSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

describe('extractPatch', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = join(tmpdir(), `cynco-patch-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(repoDir, { recursive: true })
    execSync('git init', { cwd: repoDir })
    execSync('git config user.email "test@test.com"', { cwd: repoDir })
    execSync('git config user.name "Test"', { cwd: repoDir })
    writeFileSync(join(repoDir, 'main.ts'), 'const x = 1\n')
    execSync('git add . && git commit -m "init"', { cwd: repoDir })
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('extracts diff for modified file', () => {
    writeFileSync(join(repoDir, 'main.ts'), 'const x = 2\n')
    const patch = extractPatch(repoDir)
    expect(patch).toContain('main.ts')
    expect(patch).toContain('-const x = 1')
    expect(patch).toContain('+const x = 2')
  })

  test('extracts diff for new file', () => {
    writeFileSync(join(repoDir, 'new.ts'), 'export const y = 3\n')
    execSync('git add new.ts', { cwd: repoDir })
    const patch = extractPatch(repoDir)
    expect(patch).toContain('new.ts')
  })

  test('returns empty string when no changes', () => {
    const patch = extractPatch(repoDir)
    expect(patch).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/bestOfN/patchExtractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement patchExtractor.ts**

```typescript
// engine/bestOfN/patchExtractor.ts
import { execSync } from 'child_process'

/**
 * Extract the git diff (staged + unstaged + untracked) from a directory.
 * Returns a unified diff string suitable for `git apply`.
 */
export function extractPatch(cwd: string): string {
  try {
    // Stage all changes first (including untracked)
    execSync('git add -A', { cwd, stdio: 'pipe' })

    // Get staged diff vs HEAD
    const diff = execSync('git diff --cached HEAD', {
      cwd,
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }).toString()

    // Unstage (so worktree is in original state for cleanup)
    execSync('git reset HEAD', { cwd, stdio: 'pipe' })

    return diff.trim()
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/bestOfN/patchExtractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/bestOfN/patchExtractor.ts engine/__tests__/bestOfN/patchExtractor.test.ts
git commit -m "feat: patch extractor for best-of-N diff capture"
```

---

### Task 8: Sampler (scoring and selection logic)

**Files:**
- Create: `engine/bestOfN/sampler.ts`
- Test: `engine/__tests__/bestOfN/sampler.test.ts`

- [ ] **Step 1: Write the failing test for scoring logic**

```typescript
// engine/__tests__/bestOfN/sampler.test.ts
import { describe, test, expect } from 'bun:test'
import { selectWinner, parseTestOutput } from '../../bestOfN/sampler.js'
import type { CandidateResult } from '../../bestOfN/types.js'

describe('selectWinner', () => {
  test('picks candidate with highest pass rate', () => {
    const candidates: CandidateResult[] = [
      { index: 0, worktreePath: '/tmp/a', patch: 'a', testsPassed: 8, testsTotal: 10, passRate: 0.8, stuckTurns: 0, totalTurns: 5 },
      { index: 1, worktreePath: '/tmp/b', patch: 'b', testsPassed: 10, testsTotal: 10, passRate: 1.0, stuckTurns: 0, totalTurns: 7 },
    ]
    const winner = selectWinner(candidates)
    expect(winner?.index).toBe(1)
  })

  test('tiebreaks on fewer turns', () => {
    const candidates: CandidateResult[] = [
      { index: 0, worktreePath: '/tmp/a', patch: 'a', testsPassed: 10, testsTotal: 10, passRate: 1.0, stuckTurns: 0, totalTurns: 12 },
      { index: 1, worktreePath: '/tmp/b', patch: 'b', testsPassed: 10, testsTotal: 10, passRate: 1.0, stuckTurns: 0, totalTurns: 5 },
    ]
    const winner = selectWinner(candidates)
    expect(winner?.index).toBe(1)
  })

  test('returns null for empty candidates', () => {
    expect(selectWinner([])).toBeNull()
  })

  test('skips candidates with empty patch', () => {
    const candidates: CandidateResult[] = [
      { index: 0, worktreePath: '/tmp/a', patch: '', testsPassed: 10, testsTotal: 10, passRate: 1.0, stuckTurns: 0, totalTurns: 3 },
      { index: 1, worktreePath: '/tmp/b', patch: 'real patch', testsPassed: 5, testsTotal: 10, passRate: 0.5, stuckTurns: 0, totalTurns: 5 },
    ]
    const winner = selectWinner(candidates)
    expect(winner?.index).toBe(1)
  })
})

describe('parseTestOutput', () => {
  test('parses pytest output', () => {
    const output = '===== 15 passed, 3 failed ====='
    const result = parseTestOutput(output, 'pytest')
    expect(result.passed).toBe(15)
    expect(result.total).toBe(18)
  })

  test('parses jest output', () => {
    const output = 'Tests: 2 failed, 10 passed, 12 total'
    const result = parseTestOutput(output, 'jest')
    expect(result.passed).toBe(10)
    expect(result.total).toBe(12)
  })

  test('parses bun test output', () => {
    const output = '20 pass\n2 fail'
    const result = parseTestOutput(output, 'bun')
    expect(result.passed).toBe(20)
    expect(result.total).toBe(22)
  })

  test('returns zeros for unparseable output', () => {
    const result = parseTestOutput('something unexpected', 'unknown')
    expect(result.passed).toBe(0)
    expect(result.total).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/bestOfN/sampler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement sampler.ts**

```typescript
// engine/bestOfN/sampler.ts
import { execSync } from 'child_process'
import type { CandidateResult, SamplerConfig, SamplerResult, TestInfo } from './types.js'
import { WorktreeManager } from './worktreeManager.js'
import { extractPatch } from './patchExtractor.js'

/**
 * Select the best candidate by pass rate, tiebreak on fewer turns.
 * Skips candidates with empty patches.
 */
export function selectWinner(candidates: CandidateResult[]): CandidateResult | null {
  const valid = candidates.filter(c => c.patch.length > 0)
  if (valid.length === 0) return null

  valid.sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    return a.totalTurns - b.totalTurns
  })

  return valid[0]
}

/**
 * Parse test output to extract pass/fail counts.
 */
export function parseTestOutput(output: string, framework: string): { passed: number; total: number } {
  // pytest: "15 passed, 3 failed"
  if (framework === 'pytest') {
    const passed = parseInt(output.match(/(\d+)\s+passed/)?.[1] ?? '0', 10)
    const failed = parseInt(output.match(/(\d+)\s+failed/)?.[1] ?? '0', 10)
    const errors = parseInt(output.match(/(\d+)\s+error/)?.[1] ?? '0', 10)
    return { passed, total: passed + failed + errors }
  }

  // jest: "Tests: 2 failed, 10 passed, 12 total"
  if (framework === 'jest') {
    const passed = parseInt(output.match(/(\d+)\s+passed/)?.[1] ?? '0', 10)
    const total = parseInt(output.match(/(\d+)\s+total/)?.[1] ?? '0', 10)
    return { passed, total }
  }

  // bun test: "20 pass\n2 fail"
  if (framework === 'bun') {
    const passed = parseInt(output.match(/(\d+)\s+pass/)?.[1] ?? '0', 10)
    const failed = parseInt(output.match(/(\d+)\s+fail/)?.[1] ?? '0', 10)
    return { passed, total: passed + failed }
  }

  // cargo test: "test result: ok. 10 passed; 0 failed"
  if (framework === 'cargo') {
    const passed = parseInt(output.match(/(\d+)\s+passed/)?.[1] ?? '0', 10)
    const failed = parseInt(output.match(/(\d+)\s+failed/)?.[1] ?? '0', 10)
    return { passed, total: passed + failed }
  }

  // go test: "ok" lines for passed packages, "FAIL" for failed
  if (framework === 'go') {
    const okCount = (output.match(/^ok\s/gm) ?? []).length
    const failCount = (output.match(/^FAIL\s/gm) ?? []).length
    return { passed: okCount, total: okCount + failCount }
  }

  return { passed: 0, total: 0 }
}

/**
 * Run the test command in a directory and parse results.
 */
export function runTests(cwd: string, testInfo: TestInfo): { passed: number; total: number; output: string } {
  try {
    const output = execSync(testInfo.command, {
      cwd,
      stdio: 'pipe',
      timeout: 120_000, // 2 minute timeout
      maxBuffer: 5 * 1024 * 1024,
    }).toString()
    const result = parseTestOutput(output, testInfo.framework)
    return { ...result, output }
  } catch (e: any) {
    // Tests may fail with non-zero exit — parse stdout+stderr anyway
    const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    const result = parseTestOutput(output, testInfo.framework)
    return { ...result, output }
  }
}

/**
 * Apply a patch to the main working tree.
 */
export function applyPatch(repoRoot: string, patch: string): boolean {
  if (!patch) return false
  try {
    execSync('git apply --check -', { cwd: repoRoot, input: patch, stdio: 'pipe' })
    execSync('git apply -', { cwd: repoRoot, input: patch, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/bestOfN/sampler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/bestOfN/sampler.ts engine/__tests__/bestOfN/sampler.test.ts
git commit -m "feat: best-of-N sampler with scoring and test output parsing"
```

---

### Task 9: Wire best-of-N activation into conversation loop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

This is the integration task. The engineer should:

- [ ] **Step 1: Add best-of-N config reading**

At the top of `handleUserMessage()` in `conversationLoop.ts`, read the env vars:

```typescript
const bestOfNEnabled = process.env.LOCALCODE_BEST_OF_N === 'true'
const bestOfNCount = parseInt(process.env.LOCALCODE_BEST_OF_N_COUNT ?? '2', 10)
const bestOfNTemp = parseFloat(process.env.LOCALCODE_BEST_OF_N_TEMP ?? '0.8')
const bestOfNTurnCap = parseInt(process.env.LOCALCODE_BEST_OF_N_TURN_CAP ?? '15', 10)
```

- [ ] **Step 2: Add activation check before runModelLoop**

Before `runModelLoop()` is called, check if best-of-N should activate:

```typescript
if (bestOfNEnabled) {
  try {
    const { detectTests } = await import('../bestOfN/testDetector.js')
    const testInfo = detectTests(this.cwd)
    if (testInfo.available) {
      // Check contract: does this task involve code changes?
      const hasEditAssertions = this.contract?.getAssertions()?.some(
        a => a.text.toLowerCase().includes('edit') || a.text.toLowerCase().includes('write') || a.text.toLowerCase().includes('modif')
      )
      if (hasEditAssertions) {
        console.log(`[bestOfN] Activating: ${testInfo.framework} tests detected, N=${bestOfNCount}`)
        this.emit({ type: 'bestOfN.start', n: bestOfNCount, framework: testInfo.framework })
        // Delegate to sampler — this replaces the normal runModelLoop for this message
        // (Full integration deferred — the sampler needs a mini-loop factory, which requires
        //  extracting runModelLoop into a callable function. For now, emit the event and
        //  log that it would activate. The actual multi-candidate loop will be wired in
        //  a follow-up once the conversation loop refactoring supports it.)
      }
    }
  } catch (e) {
    console.log(`[bestOfN] Detection failed, continuing single-pass: ${e}`)
  }
}
```

- [ ] **Step 3: Run existing tests**

Run: `cd engine && bun test __tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat: best-of-N activation hook in conversation loop"
```

---

## Subsystem 3: Tree-sitter + Hybrid Retrieval

### Task 10: Install tree-sitter dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install tree-sitter and language grammars**

```bash
cd engine && bun add tree-sitter tree-sitter-typescript tree-sitter-python tree-sitter-javascript tree-sitter-go tree-sitter-rust
```

- [ ] **Step 2: Verify installation**

```bash
cd engine && bun -e "const Parser = require('tree-sitter'); const TS = require('tree-sitter-typescript').typescript; const p = new Parser(); p.setLanguage(TS); const t = p.parse('const x: number = 1'); console.log(t.rootNode.type)"
```

Expected: `program`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "deps: add tree-sitter and language grammars"
```

---

### Task 11: Tree-sitter Chunker

**Files:**
- Create: `engine/retrieval/treeSitterChunker.ts`
- Test: `engine/__tests__/retrieval/treeSitterChunker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/retrieval/treeSitterChunker.test.ts
import { describe, test, expect } from 'bun:test'
import { treeSitterChunk } from '../../retrieval/treeSitterChunker.js'

describe('treeSitterChunk', () => {
  test('extracts TypeScript functions', () => {
    const code = `
import { foo } from './bar'

export function greet(name: string): string {
  return 'hello ' + name
}

export const add = (a: number, b: number) => a + b
`
    const chunks = treeSitterChunk('test.ts', code)
    const funcNames = chunks.filter(c => c.chunkType === 'function').map(c => c.name)
    expect(funcNames).toContain('greet')
  })

  test('extracts TypeScript classes', () => {
    const code = `
export class MyService {
  private value: number

  constructor(v: number) {
    this.value = v
  }

  getValue(): number {
    return this.value
  }
}
`
    const chunks = treeSitterChunk('test.ts', code)
    expect(chunks.some(c => c.chunkType === 'class' && c.name === 'MyService')).toBe(true)
  })

  test('extracts Python functions and classes', () => {
    const code = `
import os

def greet(name):
    return f"hello {name}"

class Greeter:
    def __init__(self, prefix):
        self.prefix = prefix

    def greet(self, name):
        return f"{self.prefix} {name}"
`
    const chunks = treeSitterChunk('test.py', code)
    expect(chunks.some(c => c.chunkType === 'function' && c.name === 'greet')).toBe(true)
    expect(chunks.some(c => c.chunkType === 'class' && c.name === 'Greeter')).toBe(true)
  })

  test('extracts import blocks', () => {
    const code = `
import { foo } from './bar'
import { baz } from './qux'

export function test() {}
`
    const chunks = treeSitterChunk('test.ts', code)
    expect(chunks.some(c => c.chunkType === 'import_block')).toBe(true)
  })

  test('returns null for unsupported language', () => {
    const result = treeSitterChunk('test.lua', 'local x = 1')
    expect(result).toBeNull()
  })

  test('extracts relationships (imports)', () => {
    const code = `import { foo } from './utils'\nimport { bar } from '../lib/bar'\n`
    const chunks = treeSitterChunk('test.ts', code)
    const importChunk = chunks?.find(c => c.chunkType === 'import_block')
    expect(importChunk?.relationships).toBeDefined()
    expect(importChunk!.relationships!.some(r => r.targetFile.includes('utils'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/retrieval/treeSitterChunker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement treeSitterChunker.ts**

```typescript
// engine/retrieval/treeSitterChunker.ts
import { createHash } from 'crypto'
import type { Chunk, ChunkType } from '../index/types.js'

type ChunkWithRels = Chunk & {
  relationships?: { targetFile: string; relType: 'imports' | 'extends' | 'uses' }[]
  signature?: string
}

const LANG_MAP: Record<string, { grammar: string; module: string }> = {
  ts: { grammar: 'typescript', module: 'tree-sitter-typescript' },
  tsx: { grammar: 'tsx', module: 'tree-sitter-typescript' },
  js: { grammar: 'javascript', module: 'tree-sitter-javascript' },
  jsx: { grammar: 'javascript', module: 'tree-sitter-javascript' },
  py: { grammar: 'python', module: 'tree-sitter-python' },
  go: { grammar: 'go', module: 'tree-sitter-go' },
  rs: { grammar: 'rust', module: 'tree-sitter-rust' },
}

/**
 * Chunk a source file using tree-sitter AST parsing.
 * Returns null if the language is unsupported (caller should use regex fallback).
 */
export function treeSitterChunk(filePath: string, content: string): ChunkWithRels[] | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const langInfo = LANG_MAP[ext]
  if (!langInfo) return null

  let Parser: any
  let language: any
  try {
    Parser = require('tree-sitter')
    const mod = require(langInfo.module)
    language = langInfo.grammar === 'typescript' ? mod.typescript :
               langInfo.grammar === 'tsx' ? mod.tsx :
               mod
  } catch {
    return null // tree-sitter not available
  }

  const parser = new Parser()
  parser.setLanguage(language)
  const tree = parser.parse(content)
  const lines = content.split('\n')
  const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 16)

  const chunks: ChunkWithRels[] = []
  const importNodes: any[] = []

  // Walk the AST top-level
  const cursor = tree.walk()
  cursor.gotoFirstChild()

  do {
    const node = cursor.currentNode
    const nodeType = node.type
    const startLine = node.startPosition.row
    const endLine = node.endPosition.row

    // Functions
    if (['function_declaration', 'arrow_function', 'function_definition',
         'export_statement', 'lexical_declaration'].includes(nodeType)) {
      const name = extractName(node, nodeType)
      if (name) {
        chunks.push({
          filePath, chunkType: 'function', name,
          startLine: startLine + 1, endLine: Math.min(endLine + 1, startLine + 80),
          content: lines.slice(startLine, Math.min(endLine + 1, startLine + 80)).join('\n'),
          fileHash,
          signature: extractSignature(node, lines),
        })
      }
    }

    // Classes
    if (['class_declaration', 'class_definition'].includes(nodeType)) {
      const name = findChildByType(node, 'identifier')?.text ??
                   findChildByType(node, 'type_identifier')?.text ?? null
      if (name) {
        const rels: ChunkWithRels['relationships'] = []
        // Check extends/implements
        const superClass = findChildByType(node, 'superclass') ?? findChildByType(node, 'class_heritage')
        if (superClass) {
          rels.push({ targetFile: superClass.text, relType: 'extends' })
        }
        chunks.push({
          filePath, chunkType: 'class', name,
          startLine: startLine + 1, endLine: Math.min(endLine + 1, startLine + 80),
          content: lines.slice(startLine, Math.min(endLine + 1, startLine + 80)).join('\n'),
          fileHash,
          relationships: rels.length > 0 ? rels : undefined,
        })
      }
    }

    // Imports
    if (['import_statement', 'import_from_statement', 'import_declaration'].includes(nodeType)) {
      importNodes.push(node)
    }
  } while (cursor.gotoNextSibling())

  // Collect imports into a single import_block chunk
  if (importNodes.length > 0) {
    const firstLine = importNodes[0].startPosition.row
    const lastLine = importNodes[importNodes.length - 1].endPosition.row
    const rels: ChunkWithRels['relationships'] = []

    for (const node of importNodes) {
      const source = findChildByType(node, 'string') ??
                     findChildByType(node, 'dotted_name')
      if (source) {
        const target = source.text.replace(/['"]/g, '')
        rels.push({ targetFile: target, relType: 'imports' })
      }
    }

    chunks.push({
      filePath, chunkType: 'import_block', name: null,
      startLine: firstLine + 1, endLine: lastLine + 1,
      content: lines.slice(firstLine, lastLine + 1).join('\n'),
      fileHash,
      relationships: rels.length > 0 ? rels : undefined,
    })
  }

  // If nothing found, treat as module
  if (chunks.length === 0 && lines.length > 0) {
    chunks.push({
      filePath, chunkType: 'module', name: null,
      startLine: 1, endLine: Math.min(lines.length, 50),
      content: lines.slice(0, 50).join('\n'),
      fileHash,
    })
  }

  return chunks
}

function extractName(node: any, nodeType: string): string | null {
  // Direct name child
  const nameNode = findChildByType(node, 'identifier') ??
                   findChildByType(node, 'property_identifier')
  if (nameNode) return nameNode.text

  // For export_statement, look inside the declaration
  if (nodeType === 'export_statement') {
    const decl = findChildByType(node, 'function_declaration') ??
                 findChildByType(node, 'lexical_declaration')
    if (decl) return extractName(decl, decl.type)
  }

  // For lexical_declaration (const x = ...), get the variable name
  if (nodeType === 'lexical_declaration') {
    const declarator = findChildByType(node, 'variable_declarator')
    if (declarator) return findChildByType(declarator, 'identifier')?.text ?? null
  }

  return null
}

function findChildByType(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child.type === type) return child
  }
  return null
}

function extractSignature(node: any, lines: string[]): string {
  const firstLine = lines[node.startPosition.row] ?? ''
  return firstLine.trim().replace(/\{.*$/, '').trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/retrieval/treeSitterChunker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/retrieval/treeSitterChunker.ts engine/__tests__/retrieval/treeSitterChunker.test.ts
git commit -m "feat: tree-sitter AST-based code chunker"
```

---

### Task 12: BM25 Index

**Files:**
- Create: `engine/retrieval/bm25Index.ts`
- Test: `engine/__tests__/retrieval/bm25Index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/retrieval/bm25Index.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { BM25Index } from '../../retrieval/bm25Index.js'

describe('BM25Index', () => {
  let index: BM25Index

  beforeEach(() => {
    index = new BM25Index()
  })

  test('adds and retrieves documents', () => {
    index.add(1, 'function greet returns hello world')
    index.add(2, 'class UserService handles authentication')
    const results = index.search('greet hello', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe(1)
  })

  test('ranks by relevance', () => {
    index.add(1, 'the quick brown fox')
    index.add(2, 'the quick brown fox jumps over the lazy dog')
    index.add(3, 'hello world')
    const results = index.search('quick brown fox', 3)
    // Both doc 1 and 2 should rank above doc 3
    expect(results.map(r => r.docId)).not.toContain(3)
  })

  test('returns empty for no matches', () => {
    index.add(1, 'hello world')
    const results = index.search('zyxwvuts', 5)
    expect(results).toHaveLength(0)
  })

  test('removes documents', () => {
    index.add(1, 'function greet')
    index.add(2, 'function farewell')
    index.remove(1)
    const results = index.search('greet', 5)
    expect(results).toHaveLength(0)
  })

  test('handles empty query', () => {
    index.add(1, 'hello')
    expect(index.search('', 5)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/retrieval/bm25Index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bm25Index.ts**

```typescript
// engine/retrieval/bm25Index.ts

type DocEntry = { id: number; terms: Map<string, number>; length: number }

/**
 * In-memory BM25 index for keyword-based code search.
 * Uses Okapi BM25 scoring with standard parameters.
 */
export class BM25Index {
  private docs = new Map<number, DocEntry>()
  private df = new Map<string, number>() // document frequency per term
  private avgDl = 0  // average document length
  private k1 = 1.5
  private b = 0.75

  add(docId: number, text: string): void {
    const terms = tokenize(text)
    const termFreqs = new Map<string, number>()
    for (const term of terms) {
      termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1)
    }

    this.docs.set(docId, { id: docId, terms: termFreqs, length: terms.length })

    // Update document frequencies
    for (const term of termFreqs.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }

    this.recalcAvgDl()
  }

  remove(docId: number): void {
    const doc = this.docs.get(docId)
    if (!doc) return

    for (const term of doc.terms.keys()) {
      const count = this.df.get(term) ?? 1
      if (count <= 1) {
        this.df.delete(term)
      } else {
        this.df.set(term, count - 1)
      }
    }

    this.docs.delete(docId)
    this.recalcAvgDl()
  }

  search(query: string, topK: number): { docId: number; score: number }[] {
    const queryTerms = tokenize(query)
    if (queryTerms.length === 0) return []

    const n = this.docs.size
    const scores: { docId: number; score: number }[] = []

    for (const [docId, doc] of this.docs) {
      let score = 0
      for (const term of queryTerms) {
        const tf = doc.terms.get(term) ?? 0
        if (tf === 0) continue
        const docFreq = this.df.get(term) ?? 0
        const idf = Math.log((n - docFreq + 0.5) / (docFreq + 0.5) + 1)
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * doc.length / this.avgDl))
        score += idf * tfNorm
      }
      if (score > 0) scores.push({ docId, score })
    }

    scores.sort((a, b) => b.score - a.score)
    return scores.slice(0, topK)
  }

  private recalcAvgDl(): void {
    if (this.docs.size === 0) { this.avgDl = 0; return }
    let total = 0
    for (const doc of this.docs.values()) total += doc.length
    this.avgDl = total / this.docs.size
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/retrieval/bm25Index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/retrieval/bm25Index.ts engine/__tests__/retrieval/bm25Index.test.ts
git commit -m "feat: BM25 keyword index for hybrid code search"
```

---

### Task 13: Repo Map (Graph + PageRank)

**Files:**
- Create: `engine/retrieval/repoMap.ts`
- Test: `engine/__tests__/retrieval/repoMap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/retrieval/repoMap.test.ts
import { describe, test, expect } from 'bun:test'
import { RepoGraph } from '../../retrieval/repoMap.js'

describe('RepoGraph', () => {
  test('adds definitions and references', () => {
    const graph = new RepoGraph()
    graph.addDefinition('utils.ts', 'greet', 'function')
    graph.addDefinition('app.ts', 'main', 'function')
    graph.addReference('app.ts', 'main', 'utils.ts', 'greet')
    expect(graph.nodeCount()).toBe(2)
    expect(graph.edgeCount()).toBe(1)
  })

  test('pageRank returns ranked results seeded by file', () => {
    const graph = new RepoGraph()
    graph.addDefinition('utils.ts', 'greet', 'function')
    graph.addDefinition('utils.ts', 'farewell', 'function')
    graph.addDefinition('app.ts', 'main', 'function')
    graph.addDefinition('lib.ts', 'unrelated', 'function')
    graph.addReference('app.ts', 'main', 'utils.ts', 'greet')

    const ranked = graph.pageRank(['app.ts'], 10)
    // greet should rank higher than unrelated because app.ts references it
    const greetRank = ranked.findIndex(r => r.name === 'greet')
    const unrelatedRank = ranked.findIndex(r => r.name === 'unrelated')
    expect(greetRank).toBeLessThan(unrelatedRank)
  })

  test('handles empty seed gracefully', () => {
    const graph = new RepoGraph()
    graph.addDefinition('a.ts', 'foo', 'function')
    const ranked = graph.pageRank([], 5)
    expect(ranked.length).toBeGreaterThan(0) // falls back to uniform
  })

  test('clear resets graph', () => {
    const graph = new RepoGraph()
    graph.addDefinition('a.ts', 'foo', 'function')
    graph.clear()
    expect(graph.nodeCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/retrieval/repoMap.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement repoMap.ts**

```typescript
// engine/retrieval/repoMap.ts

type NodeInfo = {
  file: string
  name: string
  kind: string // 'function' | 'class' | 'method'
}

type Edge = { from: string; to: string } // from node key → to node key

export type RankedDefinition = {
  file: string
  name: string
  kind: string
  score: number
}

/**
 * Definition graph with personalized PageRank.
 * Nodes are definitions (functions, classes). Edges are references (calls, imports).
 */
export class RepoGraph {
  private nodes = new Map<string, NodeInfo>()
  private edges: Edge[] = []
  private adjacency = new Map<string, string[]>() // outgoing edges

  private nodeKey(file: string, name: string): string {
    return `${file}::${name}`
  }

  addDefinition(file: string, name: string, kind: string): void {
    const key = this.nodeKey(file, name)
    this.nodes.set(key, { file, name, kind })
    if (!this.adjacency.has(key)) this.adjacency.set(key, [])
  }

  addReference(fromFile: string, fromName: string, toFile: string, toName: string): void {
    const fromKey = this.nodeKey(fromFile, fromName)
    const toKey = this.nodeKey(toFile, toName)
    if (!this.nodes.has(fromKey) || !this.nodes.has(toKey)) return
    this.edges.push({ from: fromKey, to: toKey })
    this.adjacency.get(fromKey)?.push(toKey)
  }

  nodeCount(): number { return this.nodes.size }
  edgeCount(): number { return this.edges.length }

  clear(): void {
    this.nodes.clear()
    this.edges = []
    this.adjacency.clear()
  }

  /**
   * Personalized PageRank seeded by files.
   * Nodes in seed files get boosted restart probability.
   */
  pageRank(seedFiles: string[], topK: number, iterations = 20, damping = 0.85): RankedDefinition[] {
    const n = this.nodes.size
    if (n === 0) return []

    const keys = [...this.nodes.keys()]
    const scores = new Map<string, number>()

    // Personalization vector: seed files get higher probability
    const seedKeys = new Set<string>()
    for (const file of seedFiles) {
      for (const [key, info] of this.nodes) {
        if (info.file === file) seedKeys.add(key)
      }
    }

    const personalBase = seedKeys.size > 0 ? 1 / seedKeys.size : 1 / n

    // Initialize
    for (const key of keys) {
      scores.set(key, 1 / n)
    }

    // Iterate
    for (let iter = 0; iter < iterations; iter++) {
      const newScores = new Map<string, number>()

      for (const key of keys) {
        // Personalization: restart to seed nodes
        const personal = seedKeys.size > 0
          ? (seedKeys.has(key) ? personalBase : 0)
          : 1 / n

        let incomingScore = 0
        // Find all nodes that point TO this node
        for (const [fromKey, neighbors] of this.adjacency) {
          if (neighbors.includes(key)) {
            const outDegree = neighbors.length
            incomingScore += (scores.get(fromKey) ?? 0) / outDegree
          }
        }

        newScores.set(key, (1 - damping) * personal + damping * incomingScore)
      }

      // Update scores
      for (const [key, score] of newScores) {
        scores.set(key, score)
      }
    }

    // Sort and return top K
    const ranked: RankedDefinition[] = []
    for (const [key, score] of scores) {
      const info = this.nodes.get(key)!
      ranked.push({ file: info.file, name: info.name, kind: info.kind, score })
    }
    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, topK)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/retrieval/repoMap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/retrieval/repoMap.ts engine/__tests__/retrieval/repoMap.test.ts
git commit -m "feat: repo map with personalized PageRank over definition graph"
```

---

### Task 14: Hybrid Search (Reciprocal Rank Fusion)

**Files:**
- Create: `engine/retrieval/hybridSearch.ts`
- Test: `engine/__tests__/retrieval/hybridSearch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/retrieval/hybridSearch.test.ts
import { describe, test, expect } from 'bun:test'
import { reciprocalRankFusion } from '../../retrieval/hybridSearch.js'

describe('reciprocalRankFusion', () => {
  test('fuses two ranked lists', () => {
    const vectorResults = [
      { id: 1, score: 0.9 },
      { id: 2, score: 0.8 },
      { id: 3, score: 0.7 },
    ]
    const bm25Results = [
      { id: 2, score: 5.0 },
      { id: 4, score: 3.0 },
      { id: 1, score: 1.0 },
    ]

    const fused = reciprocalRankFusion(vectorResults, bm25Results, 60, 5)
    // Doc 2 appears in both lists → should rank highest
    expect(fused[0].id).toBe(2)
    // Doc 1 also in both
    expect(fused[1].id).toBe(1)
  })

  test('handles empty rankers', () => {
    const fused = reciprocalRankFusion([], [], 60, 5)
    expect(fused).toHaveLength(0)
  })

  test('handles one empty ranker', () => {
    const vectorResults = [{ id: 1, score: 0.9 }]
    const fused = reciprocalRankFusion(vectorResults, [], 60, 5)
    expect(fused).toHaveLength(1)
    expect(fused[0].id).toBe(1)
  })

  test('respects topK limit', () => {
    const a = Array.from({ length: 20 }, (_, i) => ({ id: i, score: 1 }))
    const fused = reciprocalRankFusion(a, [], 60, 5)
    expect(fused.length).toBeLessThanOrEqual(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/retrieval/hybridSearch.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement hybridSearch.ts**

```typescript
// engine/retrieval/hybridSearch.ts

type RankedItem = { id: number; score: number }

/**
 * Reciprocal Rank Fusion: merge two ranked lists into one.
 * score(doc) = sum(1 / (k + rank_i)) for each ranker where doc appears.
 */
export function reciprocalRankFusion(
  listA: RankedItem[],
  listB: RankedItem[],
  k = 60,
  topK = 10,
): RankedItem[] {
  const scores = new Map<number, number>()

  for (let i = 0; i < listA.length; i++) {
    const id = listA[i].id
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
  }

  for (let i = 0; i < listB.length; i++) {
    const id = listB[i].id
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
  }

  const results: RankedItem[] = []
  for (const [id, score] of scores) {
    results.push({ id, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topK)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/retrieval/hybridSearch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/retrieval/hybridSearch.ts engine/__tests__/retrieval/hybridSearch.test.ts
git commit -m "feat: reciprocal rank fusion for hybrid search"
```

---

### Task 15: Wire tree-sitter into chunker + indexer

**Files:**
- Modify: `engine/index/chunker.ts:6-18`
- Modify: `engine/index/indexer.ts:19-24`
- Modify: `engine/index/store.ts:39,49-54`

- [ ] **Step 1: Update chunker to delegate to tree-sitter with regex fallback**

Replace the `chunkFile` function in `engine/index/chunker.ts` (line 6):

```typescript
// engine/index/chunker.ts — replace the chunkFile function (line 6)
export function chunkFile(filePath: string, content: string): Chunk[] {
  // Try tree-sitter first
  try {
    const { treeSitterChunk } = require('../retrieval/treeSitterChunker.js')
    const result = treeSitterChunk(filePath, content)
    if (result !== null) return result
  } catch {
    // tree-sitter not available — fall through to regex
  }

  // Regex fallback (original logic)
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const lines = content.split('\n')

  if (['py'].includes(ext)) {
    return chunkPython(filePath, lines, fileHash)
  } else if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return chunkTypeScript(filePath, lines, fileHash)
  } else {
    return chunkGeneric(filePath, lines, fileHash)
  }
}
```

- [ ] **Step 2: Update IndexStore to support dynamic embedding dimension**

In `engine/index/store.ts`, change the constructor to detect dimension from metadata if it exists, and allow re-creation of the vec table:

```typescript
// engine/index/store.ts — constructor change (line 39)
  constructor(dbPath: string, embeddingDim?: number) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(BASE_SCHEMA)

    // Detect dimension from metadata or use provided/default
    const storedDim = this.getMeta('embedding_dim')
    this.embeddingDim = embeddingDim ?? (storedDim ? parseInt(storedDim, 10) : 768)

    // Try to load sqlite-vec extension
    try {
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(this.db)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding float[${this.embeddingDim}]
        );
      `)
      this.vecEnabled = true
      this.setMeta('embedding_dim', String(this.embeddingDim))
      console.log(`[index] sqlite-vec loaded — vector search enabled (dim=${this.embeddingDim})`)
    } catch (e) {
      console.log(`[index] sqlite-vec not available — falling back to keyword search: ${e}`)
    }
  }
```

- [ ] **Step 3: Run existing tests**

Run: `cd engine && bun test __tests__/`
Expected: PASS (tree-sitter is opt-in, regex fallback preserved)

- [ ] **Step 4: Commit**

```bash
git add engine/index/chunker.ts engine/index/store.ts engine/index/indexer.ts
git commit -m "feat: wire tree-sitter chunker into indexer with regex fallback"
```

---

## Subsystem 4: Control Loop Wiring

### Task 16: Governance Control Signals

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts`
- Modify: `engine/vsm/governanceParams.ts`
- Test: `engine/__tests__/vsm/controlSignals.test.ts`

- [ ] **Step 1: Add new governance params**

In `engine/vsm/governanceParams.ts`, add variety control params before the closing `])`:

```typescript
  // ── Variety Control (temperature/tool-set) ──
  ['variety.low_entropy_threshold', param(
    'variety.low_entropy_threshold',
    'Tool entropy below which model is hammering one tool — raise temperature',
    0.5, 0.0, 2.0, 'variety',
  )],
  ['variety.high_entropy_margin', param(
    'variety.high_entropy_margin',
    'Margin from max entropy above which model is thrashing — lower temperature',
    0.2, 0.0, 1.0, 'variety',
  )],
  ['variety.temperature_floor', param(
    'variety.temperature_floor',
    'Minimum temperature from variety control',
    0.3, 0.1, 0.9, 'variety',
  )],
  ['variety.temperature_ceiling', param(
    'variety.temperature_ceiling',
    'Maximum temperature from variety control',
    1.0, 0.5, 2.0, 'variety',
  )],
  ['bestofn.budget', param(
    'bestofn.budget',
    'Default number of candidates for best-of-N sampling',
    2, 1, 8, 'global',
  )],
```

- [ ] **Step 2: Write the failing test**

```typescript
// engine/__tests__/vsm/controlSignals.test.ts
import { describe, test, expect } from 'bun:test'
import { computeControlSignals, type ControlSignals } from '../../vsm/controlSignals.js'

describe('computeControlSignals', () => {
  test('raises temperature when entropy is low (hammering)', () => {
    const signals = computeControlSignals({
      toolEntropy: 0.3,      // below threshold 0.5
      activeToolCount: 10,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(signals.temperatureAdjust).toBeGreaterThan(0)
    expect(signals.temperature).toBeGreaterThan(0.7)
  })

  test('lowers temperature when entropy is high (thrashing)', () => {
    const signals = computeControlSignals({
      toolEntropy: 3.0,      // near log2(10) = 3.32, within margin 0.2
      activeToolCount: 10,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(signals.temperatureAdjust).toBeLessThan(0)
    expect(signals.temperature).toBeLessThan(0.7)
  })

  test('no adjustment when entropy is balanced', () => {
    const signals = computeControlSignals({
      toolEntropy: 1.5,
      activeToolCount: 10,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(signals.temperatureAdjust).toBe(0)
  })

  test('clamps temperature to floor/ceiling', () => {
    const signals = computeControlSignals({
      toolEntropy: 0.0,      // extreme hammering
      activeToolCount: 10,
      stuckTurns: 0,
      baseTemperature: 0.95,
    })
    expect(signals.temperature).toBeLessThanOrEqual(1.0)
  })

  test('raises bestOfN budget when stuck', () => {
    const signals = computeControlSignals({
      toolEntropy: 0.3,
      activeToolCount: 10,
      stuckTurns: 4,
      baseTemperature: 0.7,
    })
    expect(signals.bestOfNBudget).toBe(4)
  })

  test('default bestOfN budget is 2', () => {
    const signals = computeControlSignals({
      toolEntropy: 1.5,
      activeToolCount: 10,
      stuckTurns: 0,
      baseTemperature: 0.7,
    })
    expect(signals.bestOfNBudget).toBe(2)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd engine && bun test __tests__/vsm/controlSignals.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement controlSignals.ts**

```typescript
// engine/vsm/controlSignals.ts
import { getParam } from './governanceParams.js'

export type ControlSignals = {
  temperatureAdjust: number  // delta to apply to base temperature
  temperature: number        // final temperature after adjustment
  bestOfNBudget: number      // N for best-of-N sampling
  widenToolSet: boolean      // true = use all tools, false = narrow to top-3
}

export type ControlInput = {
  toolEntropy: number        // Shannon entropy of tool distribution (base 2)
  activeToolCount: number    // number of currently active tools
  stuckTurns: number
  baseTemperature: number
}

/**
 * Compute control signals from variety entropy.
 * This is a real closed-loop controller — entropy drives temperature and tool-set width.
 */
export function computeControlSignals(input: ControlInput): ControlSignals {
  const lowThreshold = getParam('variety.low_entropy_threshold')
  const highMargin = getParam('variety.high_entropy_margin')
  const floor = getParam('variety.temperature_floor')
  const ceiling = getParam('variety.temperature_ceiling')
  const defaultBudget = getParam('bestofn.budget')

  const maxEntropy = Math.log2(Math.max(2, input.activeToolCount))
  const highThreshold = maxEntropy - highMargin

  let adjust = 0
  let widenToolSet = false

  if (input.toolEntropy < lowThreshold) {
    // Hammering one tool — raise temperature, widen tools
    adjust = 0.1
    widenToolSet = true
  } else if (input.toolEntropy > highThreshold && highThreshold > lowThreshold) {
    // Thrashing across too many tools — lower temperature, narrow tools
    adjust = -0.1
    widenToolSet = false
  }

  const temperature = Math.max(floor, Math.min(ceiling, input.baseTemperature + adjust))

  // Best-of-N budget: raise when stuck or low variety
  let bestOfNBudget = Math.round(defaultBudget)
  if (input.stuckTurns >= 3 || input.toolEntropy < lowThreshold) {
    bestOfNBudget = 4
  }

  return {
    temperatureAdjust: adjust,
    temperature,
    bestOfNBudget,
    widenToolSet,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd engine && bun test __tests__/vsm/controlSignals.test.ts`
Expected: PASS

- [ ] **Step 6: Add getControlSignals method to CyberneticsGovernance**

In `engine/vsm/cyberneticsGovernance.ts`, add a public method after `getVarietySnapshot()` (around line 659):

```typescript
  /** Get control signals for inference parameter adjustment. */
  getControlSignals(baseTemperature: number): import('./controlSignals.js').ControlSignals {
    const { computeControlSignals } = require('./controlSignals.js')
    const recentTools = this.toolHistory.slice(-10)
    const toolProbs = this._toolUsageProbabilities(recentTools)
    const toolEntropy = toolProbs.length > 0 ? foundations.entropy(toolProbs) : 0
    const activeToolCount = new Set(recentTools.map(t => t.name)).size

    return computeControlSignals({
      toolEntropy,
      activeToolCount: Math.max(activeToolCount, 5),
      stuckTurns: this.stuckCount,
      baseTemperature,
    })
  }
```

- [ ] **Step 7: Commit**

```bash
git add -f engine/vsm/controlSignals.ts engine/__tests__/vsm/controlSignals.test.ts engine/vsm/governanceParams.ts engine/vsm/cyberneticsGovernance.ts
git commit -m "feat: variety-driven control signals for temperature and tool-set"
```

---

### Task 17: Trajectory Recorder

**Files:**
- Create: `engine/training/trajectoryRecorder.ts`
- Test: `engine/__tests__/training/trajectoryRecorder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/training/trajectoryRecorder.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TrajectoryRecorder, type TurnRecord } from '../../training/trajectoryRecorder.js'
import { rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

describe('TrajectoryRecorder', () => {
  let recorder: TrajectoryRecorder
  let baseDir: string

  beforeEach(() => {
    baseDir = join(tmpdir(), `cynco-traj-${randomUUID().slice(0, 8)}`)
    recorder = new TrajectoryRecorder(baseDir)
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  test('records a turn and writes JSONL', () => {
    recorder.startTask('task-1', 'qwen3.6:27b')
    recorder.recordTurn({
      toolCalls: [{ name: 'Read', inputHash: 'abc', success: true, latencyMs: 100 }],
      stateFeatures: { filesTouched: 0, diffSize: 0, testsTotal: 0, testsFailing: 0, toolsUsed: ['Read'], contextPct: 0.3 },
      rewardComponents: { toolSuccessRate: 1.0, stuckTurns: 0, varietyEntropy: 0 },
    })

    const filePath = join(baseDir, 'task-1.jsonl')
    expect(existsSync(filePath)).toBe(true)

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)

    const record = JSON.parse(lines[0])
    expect(record.task_id).toBe('task-1')
    expect(record.turn_idx).toBe(0)
    expect(record.model).toBe('qwen3.6:27b')
    expect(record.tool_calls[0].name).toBe('Read')
  })

  test('increments turn index', () => {
    recorder.startTask('task-2', 'qwen3.6:27b')
    recorder.recordTurn({ toolCalls: [], stateFeatures: { filesTouched: 0, diffSize: 0, testsTotal: 0, testsFailing: 0, toolsUsed: [], contextPct: 0 }, rewardComponents: { toolSuccessRate: 1, stuckTurns: 0, varietyEntropy: 0 } })
    recorder.recordTurn({ toolCalls: [], stateFeatures: { filesTouched: 0, diffSize: 0, testsTotal: 0, testsFailing: 0, toolsUsed: [], contextPct: 0 }, rewardComponents: { toolSuccessRate: 1, stuckTurns: 0, varietyEntropy: 0 } })

    const lines = readFileSync(join(baseDir, 'task-2.jsonl'), 'utf-8').trim().split('\n')
    expect(JSON.parse(lines[0]).turn_idx).toBe(0)
    expect(JSON.parse(lines[1]).turn_idx).toBe(1)
  })

  test('uses fsync for durability', () => {
    recorder.startTask('task-3', 'qwen3.6:27b')
    recorder.recordTurn({ toolCalls: [], stateFeatures: { filesTouched: 0, diffSize: 0, testsTotal: 0, testsFailing: 0, toolsUsed: [], contextPct: 0 }, rewardComponents: { toolSuccessRate: 1, stuckTurns: 0, varietyEntropy: 0 } })
    // If we got here without error, fsync worked
    expect(existsSync(join(baseDir, 'task-3.jsonl'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/training/trajectoryRecorder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement trajectoryRecorder.ts**

```typescript
// engine/training/trajectoryRecorder.ts
import { appendFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type ToolCallRecord = {
  name: string
  inputHash: string
  success: boolean
  latencyMs: number
}

export type StateFeatures = {
  filesTouched: number
  diffSize: number
  testsTotal: number
  testsFailing: number
  toolsUsed: string[]
  contextPct: number
}

export type RewardComponents = {
  toolSuccessRate: number
  stuckTurns: number
  varietyEntropy: number
}

export type TurnRecord = {
  toolCalls: ToolCallRecord[]
  stateFeatures: StateFeatures
  rewardComponents: RewardComponents
}

/**
 * Records per-turn trajectory data to JSONL files for future training.
 * Each task gets its own file: ~/.cynco/trajectories/<taskId>.jsonl
 * Fsync'd after every write for crash safety.
 */
export class TrajectoryRecorder {
  private baseDir: string
  private currentTaskId: string | null = null
  private currentModel: string = ''
  private currentAdapterId: string | null = null
  private turnIdx = 0

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.cynco', 'trajectories')
    mkdirSync(this.baseDir, { recursive: true })
  }

  startTask(taskId: string, model: string, adapterId?: string): void {
    this.currentTaskId = taskId
    this.currentModel = model
    this.currentAdapterId = adapterId ?? null
    this.turnIdx = 0
  }

  recordTurn(turn: TurnRecord): void {
    if (!this.currentTaskId) return

    const record = {
      task_id: this.currentTaskId,
      turn_idx: this.turnIdx,
      ts: new Date().toISOString(),
      model: this.currentModel,
      adapter_id: this.currentAdapterId,
      tool_calls: turn.toolCalls,
      state_features: turn.stateFeatures,
      reward_components: turn.rewardComponents,
    }

    const filePath = join(this.baseDir, `${this.currentTaskId}.jsonl`)
    const line = JSON.stringify(record) + '\n'

    try {
      const fd = openSync(filePath, 'a')
      appendFileSync(fd, line)
      fsyncSync(fd)
      closeSync(fd)
    } catch (e) {
      console.error(`[trajectory] Write failed: ${e}`)
    }

    this.turnIdx++
  }

  get taskId(): string | null {
    return this.currentTaskId
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let _instance: TrajectoryRecorder | null = null

export function getTrajectoryRecorder(): TrajectoryRecorder | null {
  return _instance
}

export function initTrajectoryRecorder(baseDir?: string): TrajectoryRecorder {
  _instance = new TrajectoryRecorder(baseDir)
  return _instance
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/training/trajectoryRecorder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/training/trajectoryRecorder.ts engine/__tests__/training/trajectoryRecorder.test.ts
git commit -m "feat: trajectory recorder for per-turn training data collection"
```

---

### Task 18: Reward Labeler

**Files:**
- Create: `engine/training/rewardLabeler.ts`
- Test: `engine/__tests__/training/rewardLabeler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// engine/__tests__/training/rewardLabeler.test.ts
import { describe, test, expect } from 'bun:test'
import { computeReward, type RewardComponents } from '../../training/rewardLabeler.js'

describe('computeReward', () => {
  test('perfect task gets high reward', () => {
    const r = computeReward({
      testsPass: 1.0,
      typecheckPass: 1,
      buildPass: 1,
      diffClean: 1,
      taskCompleted: 1,
      stuckTurns: 0,
      iterFraction: 0.01,
      userSatisfaction: 1,
      testsUnmodified: 1,
    })
    expect(r).toBeGreaterThan(0.8)
    expect(r).toBeLessThanOrEqual(1.0)
  })

  test('failed tests reduce reward', () => {
    const r = computeReward({
      testsPass: 0.5,
      typecheckPass: 1,
      buildPass: 1,
      diffClean: 1,
      taskCompleted: 1,
      stuckTurns: 0,
      iterFraction: 0.01,
      userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(r).toBeLessThan(0.8)
  })

  test('modified tests give -1.0 (anti-reward-hacking)', () => {
    const r = computeReward({
      testsPass: 1.0,
      typecheckPass: 1,
      buildPass: 1,
      diffClean: 1,
      taskCompleted: 1,
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 1,
      testsUnmodified: 0,
    })
    expect(r).toBe(-1.0)
  })

  test('stuck turns reduce reward', () => {
    const noStuck = computeReward({
      testsPass: 1.0, typecheckPass: 1, buildPass: 1, diffClean: 1,
      taskCompleted: 1, stuckTurns: 0, iterFraction: 0, userSatisfaction: 0,
      testsUnmodified: 1,
    })
    const stuck = computeReward({
      testsPass: 1.0, typecheckPass: 1, buildPass: 1, diffClean: 1,
      taskCompleted: 1, stuckTurns: 10, iterFraction: 0, userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(stuck).toBeLessThan(noStuck)
  })

  test('reward is clipped to [-1, 1]', () => {
    const r = computeReward({
      testsPass: 1.0, typecheckPass: 1, buildPass: 1, diffClean: 1,
      taskCompleted: 1, stuckTurns: 0, iterFraction: 0, userSatisfaction: 1,
      testsUnmodified: 1,
    })
    expect(r).toBeLessThanOrEqual(1.0)
    expect(r).toBeGreaterThanOrEqual(-1.0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/training/rewardLabeler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement rewardLabeler.ts**

```typescript
// engine/training/rewardLabeler.ts
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

export type RewardComponents = {
  testsPass: number        // 0-1 ratio
  typecheckPass: 0 | 1
  buildPass: 0 | 1
  diffClean: 0 | 1
  taskCompleted: 0 | 1
  stuckTurns: number
  iterFraction: number     // turns / 500
  userSatisfaction: -1 | 0 | 1
  testsUnmodified: 0 | 1
}

export type TaskReward = {
  taskId: string
  turns: number
  components: RewardComponents
  reward: number
}

/**
 * Compute scalar reward from task outcome components.
 * Formula from the Compass analysis:
 *   r = 1.0*tests_pass + 0.5*typecheck + 0.3*build + 0.2*diff_clean
 *     + 0.5*task_completed - 0.05*min(stuck, 10) - 0.1*iter_fraction
 *     + 0.3*max(0, user_satisfaction)
 *   if tests_unmodified == 0: r = -1.0  (anti-reward-hacking)
 *   clip to [-1, 1]
 */
export function computeReward(c: RewardComponents): number {
  // Anti-reward-hacking gate: if test files were modified, reward is -1
  if (c.testsUnmodified === 0) return -1.0

  const r = 1.0 * c.testsPass
    + 0.5 * c.typecheckPass
    + 0.3 * c.buildPass
    + 0.2 * c.diffClean
    + 0.5 * c.taskCompleted
    - 0.05 * Math.min(c.stuckTurns, 10)
    - 0.1 * c.iterFraction
    + 0.3 * Math.max(0, c.userSatisfaction)

  return Math.max(-1.0, Math.min(1.0, r))
}

/**
 * Finalize a task and write the reward record.
 */
export function finalizeTask(
  taskId: string,
  turns: number,
  components: RewardComponents,
  baseDir?: string,
): TaskReward {
  const reward = computeReward(components)
  const record: TaskReward = { taskId, turns, components, reward }

  const dir = baseDir ?? join(homedir(), '.cynco', 'trajectories')
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${taskId}.reward.json`)
  writeFileSync(filePath, JSON.stringify(record, null, 2))

  return record
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/training/rewardLabeler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -f engine/training/rewardLabeler.ts engine/__tests__/training/rewardLabeler.test.ts
git commit -m "feat: reward labeler with anti-reward-hacking gate"
```

---

### Task 19: Wire control loop and trajectory into conversation loop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`
- Modify: `engine/main.ts`

- [ ] **Step 1: Initialize trajectory recorder in main.ts**

In `engine/main.ts`, after `initJournal()` is called, add:

```typescript
import { initTrajectoryRecorder } from './training/trajectoryRecorder.js'

// After initJournal()
if (process.env.LOCALCODE_TRAJECTORY_ENABLED !== 'false') {
  initTrajectoryRecorder()
  console.log('[main] Trajectory recorder initialized')
}
```

- [ ] **Step 2: Apply control signals before model call**

In `engine/bridge/conversationLoop.ts`, in the `runModelLoop` method, before the model call (around line 1210), add control signal application:

```typescript
  // Apply variety-driven control signals
  let effectiveTemperature = this.config.temperature ?? 0.7
  if (process.env.LOCALCODE_VARIETY_CONTROL !== 'false' && this.governance) {
    try {
      const signals = this.governance.getControlSignals(effectiveTemperature)
      effectiveTemperature = signals.temperature
      if (signals.temperatureAdjust !== 0) {
        console.log(`[control] Variety control: temp ${(effectiveTemperature - signals.temperatureAdjust).toFixed(2)} → ${effectiveTemperature.toFixed(2)} (entropy=${signals.widenToolSet ? 'low' : 'balanced'})`)
      }
    } catch (e) {
      console.log(`[control] Control signals failed: ${e}`)
    }
  }
```

Then pass `effectiveTemperature` to the model call by setting it on the config or request before calling `localCallModel`.

- [ ] **Step 3: Record trajectory turns after tool execution**

In `executeOneTool()` in `conversationLoop.ts`, after the existing S1 journal logging (around line 1888), add trajectory recording:

```typescript
  // Record trajectory turn
  try {
    const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
    const recorder = getTrajectoryRecorder()
    if (recorder) {
      const { createHash } = require('crypto')
      const inputHash = createHash('sha256').update(JSON.stringify(toolInput)).digest('hex').slice(0, 12)
      recorder.recordTurn({
        toolCalls: [{ name: toolName, inputHash, success: !result.isError, latencyMs: elapsed }],
        stateFeatures: {
          filesTouched: 0, // TODO: track from file.change events
          diffSize: 0,
          testsTotal: 0,
          testsFailing: 0,
          toolsUsed: [toolName],
          contextPct: this.lastContextUtilization ?? 0,
        },
        rewardComponents: {
          toolSuccessRate: this.governance ? this.governance.getReport().toolSuccessRate : 1.0,
          stuckTurns: this.governance ? this.governance.getReport().stuckTurns : 0,
          varietyEntropy: 0,
        },
      })
    }
  } catch {}
```

- [ ] **Step 4: Start task on each user message**

In `handleUserMessage()`, after contract creation, start a new trajectory task:

```typescript
  try {
    const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
    const recorder = getTrajectoryRecorder()
    if (recorder) {
      const { randomUUID } = require('crypto')
      const taskId = `task-${randomUUID().slice(0, 8)}`
      recorder.startTask(taskId, this.config.model ?? 'unknown')
    }
  } catch {}
```

- [ ] **Step 5: Run existing tests**

Run: `cd engine && bun test __tests__/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/bridge/conversationLoop.ts engine/main.ts
git commit -m "feat: wire variety control and trajectory recording into conversation loop"
```

---

## Task 20: Wire Check

**Verify all new symbols are actually imported and used.**

- [ ] **Step 1: Grep for all new exports and verify usage**

```bash
cd engine

# Subsystem 1: Constrained Decoding
echo "=== grammarEmitter ==="
grep -r "generateGBNF" --include="*.ts" | grep -v "__tests__" | grep -v "grammarEmitter.ts"
echo "=== postValidator ==="
grep -r "validateToolCall" --include="*.ts" | grep -v "__tests__" | grep -v "postValidator.ts"

# Subsystem 2: Best-of-N
echo "=== testDetector ==="
grep -r "detectTests" --include="*.ts" | grep -v "__tests__" | grep -v "testDetector.ts"
echo "=== WorktreeManager ==="
grep -r "WorktreeManager" --include="*.ts" | grep -v "__tests__" | grep -v "worktreeManager.ts"
echo "=== extractPatch ==="
grep -r "extractPatch" --include="*.ts" | grep -v "__tests__" | grep -v "patchExtractor.ts"
echo "=== selectWinner ==="
grep -r "selectWinner\|parseTestOutput\|runTests\|applyPatch" --include="*.ts" | grep -v "__tests__" | grep -v "sampler.ts"

# Subsystem 3: Retrieval
echo "=== treeSitterChunk ==="
grep -r "treeSitterChunk" --include="*.ts" | grep -v "__tests__" | grep -v "treeSitterChunker.ts"
echo "=== BM25Index ==="
grep -r "BM25Index" --include="*.ts" | grep -v "__tests__" | grep -v "bm25Index.ts"
echo "=== RepoGraph ==="
grep -r "RepoGraph" --include="*.ts" | grep -v "__tests__" | grep -v "repoMap.ts"
echo "=== reciprocalRankFusion ==="
grep -r "reciprocalRankFusion" --include="*.ts" | grep -v "__tests__" | grep -v "hybridSearch.ts"

# Subsystem 4: Control Loop
echo "=== computeControlSignals ==="
grep -r "computeControlSignals\|getControlSignals" --include="*.ts" | grep -v "__tests__" | grep -v "controlSignals.ts"
echo "=== TrajectoryRecorder ==="
grep -r "TrajectoryRecorder\|getTrajectoryRecorder\|initTrajectoryRecorder" --include="*.ts" | grep -v "__tests__" | grep -v "trajectoryRecorder.ts"
echo "=== computeReward ==="
grep -r "computeReward\|finalizeTask" --include="*.ts" | grep -v "__tests__" | grep -v "rewardLabeler.ts"
```

Every export must appear in at least one non-test file. If any symbol shows zero hits, the engineer must wire it into the appropriate integration point.

Expected minimum hits:
- `generateGBNF` → `callModel.ts`
- `validateToolCall` → `simulated.ts`
- `detectTests` → `conversationLoop.ts`
- `treeSitterChunk` → `chunker.ts`
- `computeControlSignals` → `controlSignals.ts` imported by `cyberneticsGovernance.ts`
- `getTrajectoryRecorder` → `conversationLoop.ts`
- `initTrajectoryRecorder` → `main.ts`

Symbols used only in tests (BM25Index, RepoGraph, reciprocalRankFusion, WorktreeManager, extractPatch, selectWinner) are expected — they will be wired during the indexer and sampler integration (future tasks when the full hybrid search pipeline and best-of-N orchestration are connected).

- [ ] **Step 2: Fix any unwired symbols**

If any symbol meant to be wired shows zero non-test hits, add the import and call.

- [ ] **Step 3: Run all tests one final time**

```bash
cd engine && bun test __tests__/
```

Expected: ALL PASS

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: wire check — ensure all new symbols are imported and used"
```
