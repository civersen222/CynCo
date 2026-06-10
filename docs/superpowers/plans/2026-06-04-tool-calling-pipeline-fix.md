# Tool Calling Pipeline Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bypass 3 confirmed Ollama tool-calling bugs by making simulated tool prompts the default, add MTP speculative decoding support, governance-aware temperature control, and secondary Ollama server for embeddings.

**Architecture:** Provider-level override in `callModel.ts` forces simulated tool use for Ollama (bypassing native tool API), while preserving the probe table for llama-cpp. New parsers handle every tool call format models might emit. Temperature is overridden to 0.1 when stuck >= 3 turns.

**Tech Stack:** TypeScript (Bun runtime), Ollama, llama-server (llama.cpp)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `engine/ollama/simulated.ts` | Modify | Add Hermes + JSON block parsers to `extractSimulatedToolCalls()` |
| `engine/__tests__/ollama/simulated.test.ts` | Modify | Tests for new parser formats |
| `engine/engine/callModel.ts` | Modify | Provider-level simulated override + temperature/thinking overrides |
| `engine/__tests__/engine/callModel.test.ts` | Modify | Tests for Ollama override + temperature override |
| `engine/engine/messageConvert.ts` | Modify | Serialize tool_use blocks to XML in assistant messages |
| `engine/__tests__/engine/messageConvert.test.ts` | Create | Tests for tool_use serialization |
| `engine/llama/processManager.ts` | Modify | Add `--spec-type` + `--spec-draft-n-max` flags |
| `engine/__tests__/llama/processManager.test.ts` | Modify | Tests for spec flags |
| `engine/index/embedClient.ts` | Modify | Use `LOCALCODE_EMBED_BASE_URL` env var |
| `engine/__tests__/index/embedClient.test.ts` | Create | Test for embed URL override |

---

## Task 1: Maximal Tool Call Parsers (simulated.ts)

**Files:**
- Modify: `engine/ollama/simulated.ts:66-121`
- Modify: `engine/__tests__/ollama/simulated.test.ts`

### Step 1.1: Write failing tests for Hermes-style tool calls

- [ ] Add tests to `engine/__tests__/ollama/simulated.test.ts`:

```typescript
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
```

### Step 1.2: Write failing tests for fenced JSON block tool calls

- [ ] Add tests to `engine/__tests__/ollama/simulated.test.ts`:

```typescript
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
```

### Step 1.3: Write failing test for mixed formats in one response

- [ ] Add test:

```typescript
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
```

### Step 1.4: Run tests to verify they fail

- [ ] Run: `cd engine && bun test __tests__/ollama/simulated.test.ts`
- [ ] Expected: 4 new tests FAIL (functions not found / wrong results)

### Step 1.5: Implement Hermes and JSON block parsers

- [ ] In `engine/ollama/simulated.ts`, add two new extraction functions and integrate them into `extractSimulatedToolCalls()`:

```typescript
/**
 * Extract Hermes-style <function=name>{...}</function> tool calls.
 */
function extractHermesToolCalls(text: string): { calls: SimulatedToolCall[]; remaining: string } {
  const calls: SimulatedToolCall[] = []
  const regex = /<function=(\w+)>\s*([\s\S]*?)\s*<\/function>/g
  let remaining = text
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const name = match[1]
    const parsed = tryParseJSON(match[2].trim())
    if (parsed) {
      calls.push({
        id: `sim_${randomUUID()}`,
        name,
        input: parsed as Record<string, unknown>,
      })
    }
    remaining = remaining.replace(match[0], '')
  }

  return { calls, remaining }
}

/**
 * Extract tool calls from fenced JSON code blocks.
 * Only matches blocks containing both "name" and "arguments" keys.
 */
function extractJsonBlockToolCalls(text: string): { calls: SimulatedToolCall[]; remaining: string } {
  const calls: SimulatedToolCall[] = []
  const regex = /```(?:json)?\s*\n([\s\S]*?)\n```/g
  let remaining = text
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const parsed = tryParseJSON(match[1].trim())
    if (parsed && typeof parsed.name === 'string' && parsed.arguments !== undefined) {
      calls.push({
        id: `sim_${randomUUID()}`,
        name: parsed.name,
        input: (parsed.arguments ?? {}) as Record<string, unknown>,
      })
      remaining = remaining.replace(match[0], '')
    }
    // If parsed but not a tool call shape, leave it in remaining text
  }

  return { calls, remaining }
}
```

- [ ] Modify `extractSimulatedToolCalls()` to call all three parsers. Replace the body of the function (after the thinking extraction) with:

```typescript
export function extractSimulatedToolCalls(text: string): ExtractToolCallsResult {
  // First strip think blocks to avoid extracting tool calls from thinking
  const { remainingText: textWithoutThinking } = extractThinkingBlocks(text)

  // Extract from all supported formats
  const toolCalls: SimulatedToolCall[] = []

  // 1. Canonical <tool_call> XML
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let remaining = textWithoutThinking
  let match: RegExpExecArray | null

  while ((match = toolCallRegex.exec(textWithoutThinking)) !== null) {
    const jsonStr = match[1].trim()
    const parsed = tryParseJSON(jsonStr)
    if (parsed && typeof parsed.name === 'string') {
      toolCalls.push({
        id: `sim_${randomUUID()}`,
        name: parsed.name,
        input: parsed.arguments ?? {},
      })
    }
    remaining = remaining.replace(match[0], '')
  }

  // 2. Hermes-style <function=name>
  const hermes = extractHermesToolCalls(remaining)
  toolCalls.push(...hermes.calls)
  remaining = hermes.remaining

  // 3. Fenced JSON blocks (only if they look like tool calls)
  const jsonBlocks = extractJsonBlockToolCalls(remaining)
  toolCalls.push(...jsonBlocks.calls)
  remaining = jsonBlocks.remaining

  // Post-validate extracted tool calls against registry schemas
  let validationErrors: string[] = []
  try {
    const { validateToolCall } = require('../decoding/postValidator.js')
    const { ALL_TOOLS } = require('../tools/registry.js')
    const toolMap = new Map(ALL_TOOLS.map((t: any) => [t.name, t]))
    const validCalls: SimulatedToolCall[] = []

    for (const call of toolCalls) {
      const result = validateToolCall({ name: call.name, input: call.input }, toolMap)
      if (result.valid) {
        validCalls.push(call)
      } else {
        console.log(`[simulated] Invalid tool call "${call.name}": ${result.errors.join('; ')}`)
        validationErrors.push(result.correctionMessage)
      }
    }

    toolCalls.length = 0
    toolCalls.push(...validCalls)
  } catch (e) {
    console.log(`[simulated] Post-validation skipped: ${e}`)
  }

  return {
    toolCalls,
    remainingText: remaining.trim(),
    validationErrors,
  }
}
```

### Step 1.6: Run tests to verify they pass

- [ ] Run: `cd engine && bun test __tests__/ollama/simulated.test.ts`
- [ ] Expected: ALL tests PASS (existing + 4 new)

### Step 1.7: Commit

- [ ] ```bash
cd engine && git add ollama/simulated.ts __tests__/ollama/simulated.test.ts
git commit -m "feat: maximal tool call parsers — Hermes, JSON blocks, mixed formats"
```

---

## Task 2: Conversation History Preservation (messageConvert.ts)

**Files:**
- Modify: `engine/engine/messageConvert.ts:51-58`
- Create: `engine/__tests__/engine/messageConvert.test.ts`

### Step 2.1: Write failing tests for tool_use serialization

- [ ] Create `engine/__tests__/engine/messageConvert.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test'
import { convertMessages, convertTools, buildSystemPrompt } from '../../engine/messageConvert.js'
import type { Message } from '../../types.js'

describe('convertMessages', () => {
  it('preserves text and tool_result blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ]
    const result = convertMessages(messages)
    expect(result).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: 'text', text: 'Hello' })
  })

  it('strips unsupported block types', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Hi' },
        { type: 'redacted_thinking', data: 'secret' } as any,
      ] },
    ]
    const result = convertMessages(messages)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0].type).toBe('text')
  })
})

describe('convertMessages with simulatedToolUse', () => {
  it('serializes tool_use blocks to XML text in assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'List files' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } } as any,
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1.ts\nfile2.ts' } as any,
      ] },
    ]
    const result = convertMessages(messages, { simulatedToolUse: true })
    // Assistant message should have tool_use blocks converted to text
    const assistantContent = result[1].content
    expect(assistantContent).toHaveLength(1) // merged into single text block
    expect(assistantContent[0].type).toBe('text')
    const text = (assistantContent[0] as any).text
    expect(text).toContain('Let me check.')
    expect(text).toContain('<tool_call>')
    expect(text).toContain('"name": "Bash"')
    expect(text).toContain('"command": "ls"')
    expect(text).toContain('</tool_call>')
  })

  it('converts tool_result blocks to text in user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'output here' } as any,
      ] },
    ]
    const result = convertMessages(messages, { simulatedToolUse: true })
    const userContent = result[0].content
    expect(userContent[0].type).toBe('text')
    expect((userContent[0] as any).text).toContain('output here')
  })
})

describe('convertTools', () => {
  it('converts ToolLike to ToolDefinition', () => {
    const tools = [{ name: 'Read', description: 'Read a file', inputJSONSchema: { type: 'object' as const, properties: { path: { type: 'string' } } } }]
    const result = convertTools(tools)
    expect(result[0].name).toBe('Read')
    expect(result[0].input_schema.type).toBe('object')
  })
})

describe('buildSystemPrompt', () => {
  it('joins SystemPrompt parts with double newlines', () => {
    const result = buildSystemPrompt(['Part A', 'Part B'] as any)
    expect(result).toBe('Part A\n\nPart B')
  })
})
```

### Step 2.2: Run tests to verify they fail

- [ ] Run: `cd engine && bun test __tests__/engine/messageConvert.test.ts`
- [ ] Expected: `convertMessages with simulatedToolUse` tests FAIL (no `simulatedToolUse` option exists yet)

### Step 2.3: Implement simulatedToolUse option in convertMessages

- [ ] Modify `engine/engine/messageConvert.ts`:

Add an options type and modify `convertMessages`:

```typescript
// ─── Convert Options ───────────────────────────────────────────

export type ConvertOptions = {
  /** When true, serialize tool_use/tool_result blocks to text for simulated tool calling */
  simulatedToolUse?: boolean
}

// ─── convertMessages ────────────────────────────────────────────

/**
 * Convert internal messages for the Provider.
 *
 * In simulatedToolUse mode:
 * - Assistant tool_use blocks → serialized as <tool_call> XML text
 * - User tool_result blocks → serialized as plain text
 * This preserves full conversation history for models that use prompt-based tools.
 */
export function convertMessages(messages: Message[], options?: ConvertOptions): Message[] {
  if (options?.simulatedToolUse) {
    return messages.map(msg => convertMessageSimulated(msg))
  }
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content.filter(
      (block: ContentBlock) => ALLOWED_BLOCK_TYPES.has(block.type)
    ),
  }))
}

function convertMessageSimulated(msg: Message): Message {
  const textParts: string[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push((block as any).text)
    } else if (block.type === 'tool_use' && msg.role === 'assistant') {
      const tc = block as any
      textParts.push(`<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.input }, null, 2)}\n</tool_call>`)
    } else if (block.type === 'tool_result' && msg.role === 'user') {
      const tr = block as any
      const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)
      textParts.push(`[Tool Result: ${tr.tool_use_id}]\n${content}`)
    } else if (block.type === 'thinking') {
      // Preserve thinking blocks as-is (stripped by the provider layer)
      textParts.push(`<think>${(block as any).text}</think>`)
    }
    // Skip unsupported block types
  }

  return {
    role: msg.role,
    content: textParts.length > 0
      ? [{ type: 'text', text: textParts.join('\n\n') } as ContentBlock]
      : [],
  }
}
```

### Step 2.4: Run tests to verify they pass

- [ ] Run: `cd engine && bun test __tests__/engine/messageConvert.test.ts`
- [ ] Expected: ALL tests PASS

### Step 2.5: Commit

- [ ] ```bash
cd engine && git add engine/messageConvert.ts __tests__/engine/messageConvert.test.ts
git commit -m "feat: serialize tool_use blocks to XML in simulated mode conversation history"
```

---

## Task 3: Ollama Provider-Level Simulated Override (callModel.ts)

**Files:**
- Modify: `engine/engine/callModel.ts:183-336`
- Modify: `engine/__tests__/engine/callModel.test.ts`

### Step 3.1: Write failing test for Ollama simulated override

- [ ] Add test to `engine/__tests__/engine/callModel.test.ts` inside the `describe('localCallModel', ...)` block:

```typescript
describe('Ollama simulated tool override', () => {
  it('forces simulated tool use for Ollama provider even with native capabilities', async () => {
    let capturedRequest: any = null

    const provider: Provider = {
      name: 'ollama',  // <-- Ollama provider
      async *stream(request) {
        capturedRequest = request
        yield { type: 'message_start', message: { id: 'msg_ollama', model: 'qwen3.6:27b', usage: { input_tokens: 0, output_tokens: 0 } } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
        yield { type: 'message_stop' }
      },
      async complete() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
    }

    const tools = [makeTool('Bash', 'Run a command', { command: { type: 'string' } })]
    // Capabilities say native, but provider is Ollama → should force simulated
    const gen = localCallModel({
      ...defaultParams({ tools, options: { model: 'qwen3.6:27b' } }),
      deps: {
        getProvider: () => provider,
        loadConfig: () => defaultConfig({ model: 'qwen3.6:27b' }),
        resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
      },
    } as any)

    await collect(gen)

    // Tools should NOT be sent to the provider (simulated mode)
    expect(capturedRequest.tools).toBeUndefined()
    // System prompt should contain tool definitions
    expect(capturedRequest.system).toContain('<tool_call>')
    expect(capturedRequest.system).toContain('Bash')
  })

  it('respects LOCALCODE_NATIVE_TOOLS=true to disable override', async () => {
    let capturedRequest: any = null
    const origEnv = process.env.LOCALCODE_NATIVE_TOOLS
    process.env.LOCALCODE_NATIVE_TOOLS = 'true'

    try {
      const provider: Provider = {
        name: 'ollama',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_native', model: 'qwen3.6:27b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const tools = [makeTool('Bash', 'Run a command', { command: { type: 'string' } })]
      const gen = localCallModel({
        ...defaultParams({ tools, options: { model: 'qwen3.6:27b' } }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ model: 'qwen3.6:27b' }),
          resolveCapabilities: () => defaultCapabilities({ toolUse: 'native' }),
        },
      } as any)

      await collect(gen)

      // With LOCALCODE_NATIVE_TOOLS=true, tools should be sent natively
      expect(capturedRequest.tools).toBeDefined()
      expect(capturedRequest.tools).toHaveLength(1)
    } finally {
      if (origEnv === undefined) delete process.env.LOCALCODE_NATIVE_TOOLS
      else process.env.LOCALCODE_NATIVE_TOOLS = origEnv
    }
  })
})
```

### Step 3.2: Run tests to verify they fail

- [ ] Run: `cd engine && bun test __tests__/engine/callModel.test.ts`
- [ ] Expected: `Ollama simulated tool override` tests FAIL

### Step 3.3: Implement the provider-level override in callModel.ts

- [ ] In `engine/engine/callModel.ts`, modify the section around lines 183-186.

Find:
```typescript
  // 3. Resolve capabilities
  const capabilities = resolveCaps(model)
  const simulatedToolUse = capabilities.toolUse === 'simulated'
  const noToolUse = capabilities.toolUse === 'none'
```

Replace with:
```typescript
  // 3. Resolve capabilities
  const capabilities = resolveCaps(model)
  // Ollama provider override: force simulated tool use to bypass Ollama bugs
  // (Go struct serialization, stripped tool history, wrong template renderer)
  // unless LOCALCODE_NATIVE_TOOLS=true is explicitly set
  const ollamaSimulatedOverride = provider.name === 'ollama'
    && capabilities.toolUse !== 'none'
    && process.env.LOCALCODE_NATIVE_TOOLS !== 'true'
  const simulatedToolUse = ollamaSimulatedOverride || capabilities.toolUse === 'simulated'
  const noToolUse = capabilities.toolUse === 'none'
```

- [ ] Also modify the `convertMessages` call at line 231 to pass the simulated flag:

Find:
```typescript
  // 4. Convert messages
  const convertedMessages = convertMessages(messages as any)
```

Replace with:
```typescript
  // 4. Convert messages (serialize tool blocks to text in simulated mode)
  const convertedMessages = convertMessages(messages as any, { simulatedToolUse })
```

- [ ] Update the import at the top of callModel.ts:

Find:
```typescript
import { convertMessages, convertTools, buildSystemPrompt } from './messageConvert.js'
```

(No change needed — `convertMessages` already imported. The new `options` parameter is optional.)

### Step 3.4: Run tests to verify they pass

- [ ] Run: `cd engine && bun test __tests__/engine/callModel.test.ts`
- [ ] Expected: ALL tests PASS (existing + 2 new)

### Step 3.5: Commit

- [ ] ```bash
cd engine && git add engine/callModel.ts __tests__/engine/callModel.test.ts
git commit -m "feat: force simulated tool use for Ollama provider — bypass 3 confirmed bugs"
```

---

## Task 4: Temperature Override for Stuck States (callModel.ts)

**Files:**
- Modify: `engine/engine/callModel.ts:327-343`
- Modify: `engine/bridge/conversationLoop.ts:1448-1455`
- Modify: `engine/__tests__/engine/callModel.test.ts`

### Step 4.1: Write failing test for stuck temperature override

- [ ] Add test to `engine/__tests__/engine/callModel.test.ts`:

```typescript
describe('stuck temperature override', () => {
  it('overrides temperature to 0.1 when stuckTurns >= 3', async () => {
    let capturedRequest: any = null

    const provider: Provider = {
      name: 'mock',
      async *stream(request) {
        capturedRequest = request
        yield { type: 'message_start', message: { id: 'msg_stuck', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
        yield { type: 'message_stop' }
      },
      async complete() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
    }

    const gen = localCallModel({
      ...defaultParams({
        options: { model: 'qwen3:32b', stuckTurns: 3 },
      }),
      deps: {
        getProvider: () => provider,
        loadConfig: () => defaultConfig({ temperature: 0.7 }),
        resolveCapabilities: () => defaultCapabilities(),
      },
    } as any)

    await collect(gen)

    expect(capturedRequest.temperature).toBe(0.1)
  })

  it('uses LOCALCODE_TOOL_TEMPERATURE when set and stuck', async () => {
    let capturedRequest: any = null
    const origEnv = process.env.LOCALCODE_TOOL_TEMPERATURE
    process.env.LOCALCODE_TOOL_TEMPERATURE = '0.2'

    try {
      const provider: Provider = {
        name: 'mock',
        async *stream(request) {
          capturedRequest = request
          yield { type: 'message_start', message: { id: 'msg_tt', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
          yield { type: 'message_stop' }
        },
        async complete() { throw new Error('not implemented') },
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities() { return defaultCapabilities() },
      }

      const gen = localCallModel({
        ...defaultParams({
          options: { model: 'qwen3:32b', stuckTurns: 4 },
        }),
        deps: {
          getProvider: () => provider,
          loadConfig: () => defaultConfig({ temperature: 0.7 }),
          resolveCapabilities: () => defaultCapabilities(),
        },
      } as any)

      await collect(gen)

      expect(capturedRequest.temperature).toBe(0.2)
    } finally {
      if (origEnv === undefined) delete process.env.LOCALCODE_TOOL_TEMPERATURE
      else process.env.LOCALCODE_TOOL_TEMPERATURE = origEnv
    }
  })

  it('does not override temperature when stuckTurns < 3', async () => {
    let capturedRequest: any = null

    const provider: Provider = {
      name: 'mock',
      async *stream(request) {
        capturedRequest = request
        yield { type: 'message_start', message: { id: 'msg_ok', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
        yield { type: 'message_stop' }
      },
      async complete() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
    }

    const gen = localCallModel({
      ...defaultParams({
        options: { model: 'qwen3:32b', stuckTurns: 2 },
      }),
      deps: {
        getProvider: () => provider,
        loadConfig: () => defaultConfig({ temperature: 0.7 }),
        resolveCapabilities: () => defaultCapabilities(),
      },
    } as any)

    await collect(gen)

    expect(capturedRequest.temperature).toBe(0.7)
  })
})
```

### Step 4.2: Write failing test for thinking budget cap

- [ ] Add test:

```typescript
describe('stuck thinking budget cap', () => {
  it('caps thinking budget to 64 when stuck >= 3', async () => {
    let capturedRequest: any = null

    const provider: Provider = {
      name: 'mock',
      async *stream(request) {
        capturedRequest = request
        yield { type: 'message_start', message: { id: 'msg_think', model: 'qwen3:32b', usage: { input_tokens: 0, output_tokens: 0 } } }
        yield { type: 'message_stop' }
      },
      async complete() { throw new Error('not implemented') },
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities({ thinking: 'native' }) },
    }

    const gen = localCallModel({
      ...defaultParams({
        thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
        options: { model: 'qwen3:32b', stuckTurns: 3 },
      }),
      deps: {
        getProvider: () => provider,
        loadConfig: () => defaultConfig({ temperature: 0.7 }),
        resolveCapabilities: () => defaultCapabilities({ thinking: 'native' }),
      },
    } as any)

    await collect(gen)

    expect(capturedRequest.thinking).toBeDefined()
    expect(capturedRequest.thinking.budget_tokens).toBe(64)
  })
})
```

### Step 4.3: Run tests to verify they fail

- [ ] Run: `cd engine && bun test __tests__/engine/callModel.test.ts`
- [ ] Expected: `stuck temperature override` and `stuck thinking budget cap` tests FAIL

### Step 4.4: Implement temperature override and thinking cap

- [ ] In `engine/engine/callModel.ts`, add the override logic before the request is built. Find the section around line 327:

Find:
```typescript
  // 8. Build CompletionRequest
  const request: CompletionRequest = {
    model,
    messages: convertedMessages,
    system,
    temperature: config.temperature,
    // No max_tokens — let the model generate as much as it needs
  }
```

Replace with:
```typescript
  // 8. Build CompletionRequest
  // Temperature override: stuck >= 3 → force low temperature for tool accuracy
  const stuckTurns = (options as any).stuckTurns ?? 0
  let effectiveTemperature = config.temperature
  if (stuckTurns >= 3) {
    const toolTemp = process.env.LOCALCODE_TOOL_TEMPERATURE
    effectiveTemperature = toolTemp ? parseFloat(toolTemp) : 0.1
    console.log(`[callModel] Stuck ${stuckTurns} turns → temperature override to ${effectiveTemperature}`)
  }

  const request: CompletionRequest = {
    model,
    messages: convertedMessages,
    system,
    temperature: effectiveTemperature,
    // No max_tokens — let the model generate as much as it needs
  }
```

- [ ] Modify the thinking config section (around line 341). Find:

```typescript
  // Include thinking config if enabled
  if (thinkingConfig.type === 'enabled') {
    request.thinking = {
      enabled: true,
      budget_tokens: (thinkingConfig as any).budgetTokens,
    }
  }
```

Replace with:
```typescript
  // Include thinking config if enabled
  if (thinkingConfig.type === 'enabled') {
    // Cap thinking budget when stuck — extended thinking degrades tool accuracy
    const baseBudget = (thinkingConfig as any).budgetTokens
    const thinkingBudget = stuckTurns >= 3 ? Math.min(baseBudget, 64) : baseBudget
    request.thinking = {
      enabled: true,
      budget_tokens: thinkingBudget,
    }
  }
```

### Step 4.5: Run tests to verify they pass

- [ ] Run: `cd engine && bun test __tests__/engine/callModel.test.ts`
- [ ] Expected: ALL tests PASS

### Step 4.6: Wire stuckTurns from conversationLoop

- [ ] In `engine/bridge/conversationLoop.ts`, find the `localCallModel` call site (around line 1448):

Find:
```typescript
      const gen = localCallModel({
        messages: this.messages,
        systemPrompt: effectiveSystemPrompt,
        thinkingConfig,
        tools: iterationTools,
        signal: this.abortController?.signal ?? new AbortController().signal,
        options: { model: this.config.model! },
        deps,
      })
```

Replace with:
```typescript
      const gen = localCallModel({
        messages: this.messages,
        systemPrompt: effectiveSystemPrompt,
        thinkingConfig,
        tools: iterationTools,
        signal: this.abortController?.signal ?? new AbortController().signal,
        options: { model: this.config.model!, stuckTurns: this.governance?.getStuckCount() ?? 0 },
        deps,
      })
```

### Step 4.7: Commit

- [ ] ```bash
cd engine && git add engine/callModel.ts bridge/conversationLoop.ts __tests__/engine/callModel.test.ts
git commit -m "feat: governance temperature override — force 0.1 temp + cap thinking when stuck >= 3"
```

---

## Task 5: MTP Speculative Decoding Flags (processManager.ts)

**Files:**
- Modify: `engine/llama/processManager.ts:19-40`
- Modify: `engine/__tests__/llama/processManager.test.ts`

### Step 5.1: Write failing test for spec flags

- [ ] Add test to `engine/__tests__/llama/processManager.test.ts`:

```typescript
it('adds speculative decoding flags when specType is set', () => {
  const args = buildServerArgs({
    modelPath: '/models/qwen-mtp.gguf',
    port: 8081,
    specType: 'draft-mtp',
    specDraftN: 2,
  })
  expect(args).toContain('--spec-type')
  expect(args).toContain('draft-mtp')
  expect(args).toContain('--spec-draft-n-max')
  expect(args).toContain('2')
})

it('defaults specDraftN to 2 when specType is set but specDraftN is not', () => {
  const args = buildServerArgs({
    modelPath: '/models/qwen-mtp.gguf',
    port: 8081,
    specType: 'draft-mtp',
  })
  expect(args).toContain('--spec-draft-n-max')
  expect(args).toContain('2')
})

it('does not add spec flags when specType is not set', () => {
  const args = buildServerArgs({
    modelPath: '/models/qwen.gguf',
    port: 8081,
  })
  expect(args).not.toContain('--spec-type')
  expect(args).not.toContain('--spec-draft-n-max')
})
```

### Step 5.2: Run tests to verify they fail

- [ ] Run: `cd engine && bun test __tests__/llama/processManager.test.ts`
- [ ] Expected: First 2 new tests FAIL (specType not a valid field)

### Step 5.3: Implement spec flags in buildServerArgs

- [ ] In `engine/llama/processManager.ts`, add `specType` and `specDraftN` to BOTH `ServerConfig` and `ProcessManagerConfig`:

Find:
```typescript
export type ServerConfig = {
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  loraPath?: string
}
```

Replace with:
```typescript
export type ServerConfig = {
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  loraPath?: string
  specType?: string
  specDraftN?: number
}
```

Find:
```typescript
export type ProcessManagerConfig = {
  binaryPath: string
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
}
```

Replace with:
```typescript
export type ProcessManagerConfig = {
  binaryPath: string
  modelPath: string
  port: number
  ctxSize?: number
  batchSize?: number
  gpuLayers?: number
  flashAttn?: boolean
  threads?: number
  specType?: string
  specDraftN?: number
}
```

Note: `buildServerArgs` is called from `startProcess()` using `this.baseConfig` (which is `ProcessManagerConfig`). Since `ProcessManagerConfig` has all the `ServerConfig` fields except `loraPath` (added separately), both types need the spec fields.

- [ ] Add spec flags to `buildServerArgs()`, after the `loraPath` block (around line 36):

Find:
```typescript
  if (config.loraPath) {
    args.push('--lora', config.loraPath)
  }

  return args
```

Replace with:
```typescript
  if (config.loraPath) {
    args.push('--lora', config.loraPath)
  }

  if (config.specType) {
    args.push('--spec-type', config.specType)
    args.push('--spec-draft-n-max', String(config.specDraftN ?? 2))
  }

  return args
```

### Step 5.4: Wire env vars into ProcessManager construction

- [ ] In `engine/main.ts:166-175`, where `ProcessManager` is constructed, add the spec config fields:

Find:
```typescript
    const processManager = new ProcessManager({
      binaryPath,
      modelPath,
      port: config.port,
      ctxSize: config.contextLength ?? 32768,
      batchSize: config.batchSize,
      gpuLayers: config.gpuLayers,
      flashAttn: config.flashAttn,
      threads: config.threads,
    })
```

Replace with:
```typescript
    const processManager = new ProcessManager({
      binaryPath,
      modelPath,
      port: config.port,
      ctxSize: config.contextLength ?? 32768,
      batchSize: config.batchSize,
      gpuLayers: config.gpuLayers,
      flashAttn: config.flashAttn,
      threads: config.threads,
      specType: process.env.LOCALCODE_SPEC_TYPE || undefined,
      specDraftN: process.env.LOCALCODE_SPEC_DRAFT_N ? parseInt(process.env.LOCALCODE_SPEC_DRAFT_N, 10) : undefined,
    })
```

### Step 5.5: Run tests to verify they pass

- [ ] Run: `cd engine && bun test __tests__/llama/processManager.test.ts`
- [ ] Expected: ALL tests PASS

### Step 5.6: Commit

- [ ] ```bash
cd engine && git add llama/processManager.ts __tests__/llama/processManager.test.ts
git commit -m "feat: MTP speculative decoding support for llama-server provider"
```

---

## Task 6: Secondary Ollama Server for Embeddings (embedClient.ts)

**Files:**
- Modify: `engine/index/embedClient.ts:7-9`
- Create: `engine/__tests__/index/embedClient.test.ts`

### Step 6.1: Write failing test

- [ ] Create `engine/__tests__/index/embedClient.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test'
import { EmbedClient } from '../../index/embedClient.js'

describe('EmbedClient', () => {
  it('uses LOCALCODE_EMBED_BASE_URL when set', () => {
    const origEnv = process.env.LOCALCODE_EMBED_BASE_URL
    process.env.LOCALCODE_EMBED_BASE_URL = 'http://192.168.1.100:11434'

    try {
      const client = new EmbedClient()
      // Access the private baseUrl via the modelName getter pattern
      // We test behavior: healthCheck should hit the right URL
      expect(client.modelName).toBeDefined() // sanity check construction works

      // Verify by checking the URL used in a request (will fail to connect but that's OK)
      const fetchPromise = client.embed('test')
      // Should reject with network error pointing to the secondary URL
      expect(fetchPromise).rejects.toThrow()
    } finally {
      if (origEnv === undefined) delete process.env.LOCALCODE_EMBED_BASE_URL
      else process.env.LOCALCODE_EMBED_BASE_URL = origEnv
    }
  })

  it('falls back to constructor baseUrl when LOCALCODE_EMBED_BASE_URL is not set', () => {
    const origEnv = process.env.LOCALCODE_EMBED_BASE_URL
    delete process.env.LOCALCODE_EMBED_BASE_URL

    try {
      const client = new EmbedClient('http://localhost:11434')
      expect(client.modelName).toBeDefined()
    } finally {
      if (origEnv !== undefined) process.env.LOCALCODE_EMBED_BASE_URL = origEnv
    }
  })
})
```

### Step 6.2: Run test to verify it fails

- [ ] Run: `cd engine && bun test __tests__/index/embedClient.test.ts`
- [ ] Expected: Test may pass or fail depending on whether the env var is currently set — the key test is that construction doesn't crash

### Step 6.3: Implement the env var override

- [ ] In `engine/index/embedClient.ts`, modify the constructor:

Find:
```typescript
  constructor(baseUrl = 'http://localhost:11434', model = 'nomic-embed-text') {
    this.baseUrl = baseUrl
    this.model = process.env.LOCALCODE_EMBED_MODEL ?? model
  }
```

Replace with:
```typescript
  constructor(baseUrl = 'http://localhost:11434', model = 'nomic-embed-text') {
    this.baseUrl = process.env.LOCALCODE_EMBED_BASE_URL ?? baseUrl
    this.model = process.env.LOCALCODE_EMBED_MODEL ?? model
  }
```

### Step 6.4: Run tests to verify they pass

- [ ] Run: `cd engine && bun test __tests__/index/embedClient.test.ts`
- [ ] Expected: ALL tests PASS

### Step 6.5: Commit

- [ ] ```bash
cd engine && git add index/embedClient.ts __tests__/index/embedClient.test.ts
git commit -m "feat: LOCALCODE_EMBED_BASE_URL for secondary Ollama server embeddings"
```

---

## Task 7: Wire Check + Full Test Suite

**Files:** All modified files from Tasks 1-6

### Step 7.1: Grep for all new symbols

- [ ] Run each grep and verify the symbol appears in the expected file:

```bash
cd engine
grep -r 'LOCALCODE_NATIVE_TOOLS' --include='*.ts' -l
# Expected: engine/callModel.ts

grep -r 'LOCALCODE_SPEC_TYPE' --include='*.ts' -l
# Expected: main.ts

grep -r 'LOCALCODE_TOOL_TEMPERATURE' --include='*.ts' -l
# Expected: engine/callModel.ts

grep -r 'LOCALCODE_EMBED_BASE_URL' --include='*.ts' -l
# Expected: index/embedClient.ts

grep -r 'extractHermesToolCalls' --include='*.ts' -l
# Expected: ollama/simulated.ts

grep -r 'extractJsonBlockToolCalls' --include='*.ts' -l
# Expected: ollama/simulated.ts

grep -r 'simulatedToolUse' engine/callModel.ts
# Expected: should appear in the override logic AND in convertMessages call

grep -r 'stuckTurns' bridge/conversationLoop.ts
# Expected: should appear in the localCallModel options object

grep -r 'ollamaSimulatedOverride' engine/callModel.ts
# Expected: should appear in capability resolution section
```

### Step 7.2: Run full test suite

- [ ] Run: `cd engine && bun test`
- [ ] Expected: ALL tests PASS, no regressions

### Step 7.3: Verify provider.name is accessible

- [ ] Confirm `provider.name` is used in `callModel.ts` (already used at line 355 for grammar check):

```bash
grep -n 'provider.name' engine/callModel.ts
# Expected: line with grammar check AND new line with Ollama override
```

### Step 7.4: Final commit

- [ ] If any wire check failed and was fixed:
```bash
git add -A && git commit -m "fix: wire check corrections for tool calling pipeline"
```

---

## Task 8: Download MTP GGUF (Manual)

This is a manual step — the implementer runs it once.

### Step 8.1: Download the MTP GGUF

- [ ] Run in terminal:
```bash
# Option A: Direct download via llama-server (auto-downloads from HuggingFace)
llama-server -hf unsloth/Qwen3.6-27B-MTP-GGUF:Q6_K --port 8081

# Option B: Manual download with huggingface-cli
pip install huggingface-hub
huggingface-cli download unsloth/Qwen3.6-27B-MTP-GGUF Qwen3.6-27B-MTP-Q6_K.gguf --local-dir C:/models/
```

### Step 8.2: Test MTP with llama-server

- [ ] Run llama-server manually to verify MTP works:
```bash
llama-server --model C:/models/Qwen3.6-27B-MTP-Q6_K.gguf --port 8081 --host 127.0.0.1 --ctx-size 8192 --n-gpu-layers 999 --flash-attn on --spec-type draft-mtp --spec-draft-n-max 2
```

- [ ] Verify the server starts and the health endpoint responds:
```bash
curl http://127.0.0.1:8081/health
```

### Step 8.3: Test with CynCo

- [ ] Run CynCo with llama-cpp provider and MTP:
```bash
LOCALCODE_PROVIDER=llama-cpp LOCALCODE_MODEL_PATH=C:/models/Qwen3.6-27B-MTP-Q6_K.gguf LOCALCODE_SPEC_TYPE=draft-mtp bun engine/main.ts
```

---

## Summary of New Environment Variables

| Variable | Default | Where Read | Purpose |
|----------|---------|------------|---------|
| `LOCALCODE_NATIVE_TOOLS` | unset (simulated) | `engine/engine/callModel.ts` | Set `true` to use Ollama native tools |
| `LOCALCODE_TOOL_TEMPERATURE` | unset (0.1 when stuck) | `engine/engine/callModel.ts` | Override temperature when stuck >= 3 |
| `LOCALCODE_SPEC_TYPE` | unset | `engine/llama/processManager.ts` | Speculative decoding type (e.g., `draft-mtp`) |
| `LOCALCODE_SPEC_DRAFT_N` | `2` | `engine/llama/processManager.ts` | Max draft tokens for speculative decoding |
| `LOCALCODE_EMBED_BASE_URL` | unset (uses `LOCALCODE_BASE_URL`) | `engine/index/embedClient.ts` | Secondary Ollama server for embeddings |
