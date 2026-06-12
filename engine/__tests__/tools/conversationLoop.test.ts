import { describe, expect, it, beforeAll } from 'bun:test'

// Skip these integration tests in CI — they create real ConversationLoop
// instances that hit the filesystem, create JSONL sessions, index DBs, etc.
// Run manually with: CYNCO_INTEGRATION=1 bun test
const SKIP = !process.env.CYNCO_INTEGRATION
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold (65536) — the routing
    // pre-call would otherwise consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    // Deterministic tests: proactive scouts would consume the mock provider's
    // scripted responses before the main loop runs.
    noScouts: true,
  }
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return defaultCapabilities()
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      if (gen) yield* gen()
    },
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

describe('ConversationLoop with tools', () => {
  it.skipIf(SKIP)('streams text responses and emits events', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('Hello!')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('hi')
    expect(events.some(e => e.type === 'stream.token')).toBe(true)
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
  })

  it.skipIf(SKIP)('sets processing flag during message handling', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('test')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    expect(loop.isProcessing).toBe(false)
    const promise = loop.handleUserMessage('hello')
    // isProcessing is true while awaiting
    expect(loop.isProcessing).toBe(true)
    await promise
    expect(loop.isProcessing).toBe(false)
  })

  it('exposes handleApprovalResponse and setApproveAll methods', () => {
    const provider = mockProvider([])
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: () => {},
    })

    // These should not throw
    expect(() => loop.handleApprovalResponse('fake-id', true)).not.toThrow()
    expect(() => loop.setApproveAll(true)).not.toThrow()
    expect(() => loop.setApproveAll(false)).not.toThrow()
  })

  it.skipIf(SKIP)('ignores messages while already processing', async () => {
    const events: any[] = []
    // Create a provider that takes a bit to respond
    const provider = mockProvider([() => textResponse('first'), () => textResponse('second')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    const p1 = loop.handleUserMessage('first')
    // This should be ignored since we're already processing
    const p2 = loop.handleUserMessage('second')
    await p1
    await p2

    // Only one message.complete event (the second was ignored)
    const completes = events.filter(e => e.type === 'message.complete')
    expect(completes.length).toBe(1)
  })

  it.skipIf(SKIP)('allowedTools option restricts the tool set offered to the model', async () => {
    const captured: CompletionRequest[] = []
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        captured.push(request)
        yield* textResponse('done')
      },
    }
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('what is in the readme file here')
    expect(captured.length).toBeGreaterThan(0)
    // Unknown models run in simulated tool-use mode (tools ride in the system
    // prompt, request.tools stays unset) — so assert on the <TOOLS> section.
    const system = String(captured[0].system ?? '')
    expect(system).toContain('<TOOLS>')
    const toolsSection = system.slice(system.indexOf('<TOOLS>'), system.indexOf('</TOOLS>'))
    expect(toolsSection).toContain('- Read:')
    expect(toolsSection).not.toContain('- Bash:')
    expect(toolsSection).not.toContain('- Write:')
  })

  it.skipIf(SKIP)('allowedTools blocks disallowed tool calls at execution time', async () => {
    // Simulated-mode models can hallucinate tools that were never offered in
    // the prompt — the pin must also be enforced when the call comes back.
    function* bashToolUse(): Generator<StreamEvent> {
      yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo SHOULD_NOT_RUN"}' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }
    const events: any[] = []
    const provider = mockProvider([() => bashToolUse(), () => textResponse('done')])
    const loop = new ConversationLoop({
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: (e) => events.push(e),
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('run something')
    const complete = events.find(e => e.type === 'tool.complete' && e.toolName === 'Bash')
    expect(complete).toBeDefined()
    expect(complete.isError).toBe(true)
    expect(String(complete.result)).toContain('not available in this run')
    expect(String(complete.result)).not.toContain('SHOULD_NOT_RUN')
  })

  it.skipIf(SKIP)('S5 restriction that would empty the tool set is skipped, and S5 sees activeToolNames', async () => {
    // Real incident (2026-06-12): C7 restricted a mission run to coding tools
    // outside the pinned set — intersection left ZERO tools. The loop must
    // never apply a restriction that removes every available tool.
    const captured: CompletionRequest[] = []
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        captured.push(request)
        yield* textResponse('done')
      },
    }
    const s5Inputs: any[] = []
    const fakeS5 = {
      async makeDecision(input: any) {
        s5Inputs.push(input)
        return {
          workflow: null, advancePhase: null, model: null,
          tools: ['Edit', 'Write', 'Bash'], // none of these exist in this run
          contextAction: 'none', spawnAgent: null, priority: 'balanced',
          reasoning: 'test restriction',
        }
      },
      evaluateLastDecision() { return null },
    }
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: () => {},
      s5: fakeS5 as any,
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('hello')
    // S5 was told what tools are actually available in this run
    expect(s5Inputs.length).toBeGreaterThan(0)
    expect(s5Inputs[0].governance.activeToolNames).toEqual(['Read'])
    // The empty-intersection restriction was skipped — Read still offered
    const system = String(captured[0].system ?? '')
    const toolsSection = system.slice(system.indexOf('<TOOLS>'), system.indexOf('</TOOLS>'))
    expect(toolsSection).toContain('- Read:')
  })

  it.skipIf(SKIP)('S5 tool restriction is enforced at execution time in one-shot runs', async () => {
    // Replay incident (2026-06-12): at stuck=5 S5 restricted the prompt to
    // [Read, WebFetch], but the model kept calling WebSearch (seen earlier in
    // history) and the calls EXECUTED — the gate only checked the run-level
    // pin, not the live restricted set. Stuck climbed to 15 → HALT.
    function* bashToolUse(): Generator<StreamEvent> {
      yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo SHOULD_NOT_RUN"}' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }
    const events: any[] = []
    const fakeS5 = {
      async makeDecision() {
        return {
          workflow: null, advancePhase: null, model: null,
          tools: ['Read'], // restriction: Bash is pinned for the run but NOT offered this turn
          contextAction: 'none', spawnAgent: null, priority: 'balanced',
          reasoning: 'test restriction',
        }
      },
      evaluateLastDecision() { return null },
    }
    const loop = new ConversationLoop({
      config: { ...defaultConfig(), approveAll: true },
      provider: mockProvider([() => bashToolUse(), () => textResponse('done')]),
      emit: (e) => events.push(e),
      s5: fakeS5 as any,
      allowedTools: ['Read', 'Bash'],
    })
    await loop.handleUserMessage('do something')
    const complete = events.find(e => e.type === 'tool.complete' && e.toolName === 'Bash')
    expect(complete).toBeDefined()
    expect(complete.isError).toBe(true)
    expect(String(complete.result)).toContain('not available')
    expect(String(complete.result)).not.toContain('SHOULD_NOT_RUN')
  })

  it.skipIf(SKIP)('one-shot runs skip contract auto-creation so the model can finish', async () => {
    // 2026-06-12 weekly-digest incident: the auto-created contract demanded
    // "Run the test suite NOW with Bash" in a read-only mission, re-prompting
    // the model every time it tried to produce its final outcome.
    const captured: CompletionRequest[] = []
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        captured.push(request)
        yield* textResponse('Here is my analysis of the league situation this week.')
      },
    }
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('analyze the league standings and summarize the week')
    // No contract → no "[System] You are NOT done" re-prompt → exactly one model call
    expect(captured.length).toBe(1)
  })

  it.skipIf(SKIP)('one-shot nudge asks for the structured outcome instead of coding tools', async () => {
    // 2026-06-12 weekly-digest incident: S2 nudged "Call Read, Write, Edit,
    // Grep, or Bash RIGHT NOW" at the model mid-answer, pushing it back into
    // a tool loop. In one-shot runs the nudge must offer finishing as an
    // option, and a response containing the structured outcome must not be
    // nudged at all.
    function* readToolUse(): Generator<StreamEvent> {
      yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"C:/nonexistent.txt"}' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }
    const captured: CompletionRequest[] = []
    const responses = [
      () => readToolUse(),
      () => textResponse('I will now compile the weekly digest.'), // narration stall → nudge
      () => textResponse('```json\n{"ok": true, "summary": "week 1 digest", "recommendations": []}\n```'),
    ]
    let idx = 0
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        captured.push(request)
        const gen = responses[idx++]
        if (gen) yield* gen()
      },
    }
    const loop = new ConversationLoop({
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('compile the weekly digest from league data')
    // Exactly 3 calls: tool turn, narration turn (nudged), outcome turn (exit)
    expect(captured.length).toBe(3)
    const lastMessages = (captured[2] as any).messages as any[]
    const nudge = lastMessages[lastMessages.length - 1]
    const nudgeText = nudge.content.map((b: any) => b.text ?? '').join('')
    expect(nudgeText).toContain('structured outcome')
    expect(nudgeText).not.toMatch(/Write, Edit, Grep/)
  })

  // 2026-06-12 weekly-digest incident #3: the loop passed response: '' to
  // governance.onTurnComplete on EVERY turn, so responseStuck (uniform
  // prefixes) was permanently true from turn 3 — stuck +1/turn, guaranteed
  // HALT at ~turn 18 in any long mission regardless of model behavior.
  function* narratedToolUse(text: string, file: string): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: file }) } } as any
    yield { type: 'content_block_stop', index: 1 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
  const READ_FILES = ['package.json', 'README.md', 'CLAUDE.md', '.gitignore', 'engine/main.ts']
  const OUTCOME = '```json\n{"ok": true, "summary": "digest", "recommendations": []}\n```'

  it.skipIf(SKIP)('varied narration across tool turns never accumulates stuck', async () => {
    const responses = [
      ...READ_FILES.map((f, i) => () => narratedToolUse(`Checking source ${i} for a different part of the digest.`, f)),
      () => textResponse(OUTCOME),
    ]
    const loop = new ConversationLoop({
      config: { ...defaultConfig(), approveAll: true },
      provider: mockProvider(responses),
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('compile the weekly digest from league data')
    expect((loop as any).governance.getStuckCount()).toBe(0)
  })

  it.skipIf(SKIP)('repeated identical narration reaches governance and counts as stuck', async () => {
    // Guards the response wiring itself: if the loop passes '' (or anything
    // uniform-but-ignored) instead of the streamed text, a genuinely looping
    // model would never be detected.
    const responses = [
      ...READ_FILES.map(f => () => narratedToolUse('I will now check the league data.', f)),
      () => textResponse(OUTCOME),
    ]
    const loop = new ConversationLoop({
      config: { ...defaultConfig(), approveAll: true },
      provider: mockProvider(responses),
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('compile the weekly digest from league data')
    expect((loop as any).governance.getStuckCount()).toBeGreaterThan(0)
  })

  it.skipIf(SKIP)('emits message.complete with correct stopReason', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('done')])

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('finish')
    const complete = events.find(e => e.type === 'message.complete')
    expect(complete).toBeDefined()
    expect(complete.stopReason).toBe('end_turn')
  })
})
