import { describe, expect, it, beforeAll, afterAll, vi } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// These tests drive a real ConversationLoop with a scripted model and run in
// the ordinary suite. They need no service: what they write goes to a temp
// folder (TEST_CWD below, where the loop's snapshot runs git) and to the
// suite's temp CYNCO_HOME (session journal, governance database), and the
// suite's setup refuses fetch to this machine's service ports. They were behind
// CYNCO_INTEGRATION until 2026-11-24, and the one that failed there (compactNow,
// a product defect in the compressor) had failed unseen since 2026-07-15.
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// ConversationLoop's constructor initSnapshot()s its cwd (git add -A into
// .cynco-snapshots/) — point it at a temp dir so tests never stage the repo
// root into the repo's live .cynco-snapshots/ (P1.4 hazard fix).
const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-loop-cwd-'))
afterAll(() => {
  fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 })
})

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
  it('streams text responses and emits events', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('Hello!')])

    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('hi')
    expect(events.some(e => e.type === 'stream.token')).toBe(true)
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
  })

  it('sets processing flag during message handling', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('test')])

    const loop = new ConversationLoop({
      cwd: TEST_CWD,
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
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: () => {},
    })

    // These should not throw
    expect(() => loop.handleApprovalResponse('fake-id', true)).not.toThrow()
    expect(() => loop.setApproveAll(true)).not.toThrow()
    expect(() => loop.setApproveAll(false)).not.toThrow()
  })

  it('ignores messages while already processing', async () => {
    const events: any[] = []
    // Create a provider that takes a bit to respond
    const provider = mockProvider([() => textResponse('first'), () => textResponse('second')])

    const loop = new ConversationLoop({
      cwd: TEST_CWD,
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

  it('allowedTools option restricts the tool set offered to the model', async () => {
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
      cwd: TEST_CWD,
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

  it('allowedTools blocks disallowed tool calls at execution time', async () => {
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
      cwd: TEST_CWD,
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

  it('S5 restriction that would empty the tool set is skipped, and S5 sees activeToolNames', async () => {
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
      cwd: TEST_CWD,
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

  it('S5 tool restriction is enforced at execution time in one-shot runs', async () => {
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
      cwd: TEST_CWD,
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

  it('one-shot runs skip contract auto-creation so the model can finish', async () => {
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
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('analyze the league standings and summarize the week')
    // No contract → no "[System] You are NOT done" re-prompt → exactly one model call
    expect(captured.length).toBe(1)
  })

  it('one-shot nudge asks for the structured outcome instead of coding tools', async () => {
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
      cwd: TEST_CWD,
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
  const READ_FILES = ['package.json', 'README.md', 'CONVENTIONS.md', '.gitignore', 'engine/main.ts']
  const OUTCOME = '```json\n{"ok": true, "summary": "digest", "recommendations": []}\n```'

  it('varied narration across tool turns never accumulates stuck', async () => {
    const responses = [
      ...READ_FILES.map((f, i) => () => narratedToolUse(`Checking source ${i} for a different part of the digest.`, f)),
      () => textResponse(OUTCOME),
    ]
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider: mockProvider(responses),
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('compile the weekly digest from league data')
    expect((loop as any).governance.getStuckCount()).toBe(0)
  }, 20_000) // load-sensitive under the full suite (about 1.6 to 1.9 s alone, against the 5 s default; F207's pattern)

  it('repeated identical narration reaches governance and counts as stuck', async () => {
    // Guards the response wiring itself: if the loop passes '' (or anything
    // uniform-but-ignored) instead of the streamed text, a genuinely looping
    // model would never be detected.
    const responses = [
      ...READ_FILES.map(f => () => narratedToolUse('I will now check the league data.', f)),
      () => textResponse(OUTCOME),
    ]
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider: mockProvider(responses),
      emit: () => {},
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('compile the weekly digest from league data')
    expect((loop as any).governance.getStuckCount()).toBeGreaterThan(0)
  }, 20_000) // load-sensitive under the full suite (about 1.6 to 1.9 s alone, against the 5 s default; F207's pattern)

  it('context estimate includes system prompt + tool schema overhead', async () => {
    // 2026-06-12 incident #3: llama-server evaluates system prompt + tool
    // schemas on EVERY request (15.1k tokens of a 32.8k n_ctx), but the
    // in-loop monitor estimated only this.messages — it read 54% while the
    // server was rejecting requests at 100%, so compaction never fired.
    const events: any[] = []
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider: mockProvider([() => textResponse('Here is my analysis of the league situation this week.')]),
      emit: (e) => events.push(e),
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('analyze the league standings and summarize the week')
    const status = events.find(e => e.type === 'context.status')
    expect(status).toBeDefined()
    // The system prompt alone is thousands of chars (>300 tokens); a
    // messages-only estimate of this tiny exchange is well under 100.
    expect(status.estimatedTokens).toBeGreaterThan(300)
  })

  it('compactNow compresses older messages into a summary', async () => {
    // In-loop compaction must actually shrink this.messages — a "finish now"
    // warning alone cannot stop overflow when each tool result adds
    // thousands of tokens.
    // The side query's request is kept so the test can read the summary prompt:
    // a message that is neither summarized nor kept would pass every check on
    // the compacted list alone.
    const sideQueryBodies: any[] = []
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).endsWith('/api/chat')) sideQueryBodies.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({ message: { content: 'summary of earlier turns' } }),
        { status: 200 },
      )
    })
    try {
      const loop = new ConversationLoop({
        cwd: TEST_CWD,
        config: defaultConfig(),
        provider: mockProvider([]),
        emit: () => {},
      })
      const msgs = (loop as any).messages as any[]
      for (let i = 0; i < 12; i++) {
        msgs.push({
          role: i % 2 ? 'assistant' : 'user',
          content: [{ type: 'text', text: `turn ${i}: ${'x'.repeat(400)}` }],
        })
      }
      const before = msgs.slice()
      const tokensBefore: number = (loop as any).estimateMessageTokens()
      const compacted = await (loop as any).compactNow('test')
      expect(compacted).toBe(true)
      const after = (loop as any).messages as any[]
      // What compaction is for: the context the model is sent shrinks. The
      // count alone cannot say so, because the original task and the recent
      // user requests are pinned back in verbatim by design (F129); with a
      // summarized part also kept in the tail, this case grew from about 1,230
      // to 1,478 estimated tokens.
      expect((loop as any).estimateMessageTokens()).toBeLessThan(tokensBefore)
      expect(after.length).toBeLessThan(12)
      expect(after[0].content[0].text).toContain('[Context Summary]')
      // compactNow asks for the last two pairs. Apart from the summary and the
      // pinned anchors, exactly those four messages are kept, as they were, so
      // nothing the summary covers is also kept in the tail.
      const verbatim = after.filter(m => !/^\[(Context Summary|Pinned |Committed so far)/.test(String(m.content[0]?.text ?? '')))
      expect(verbatim).toEqual(before.slice(-4))
      // The assistant turns the summary covers appear nowhere else.
      const text = JSON.stringify(after)
      for (const i of [1, 3, 5, 7]) expect(text).not.toContain(`turn ${i}:`)
      // The summary was asked for once, over turns 0 to 7 and none of the four
      // kept turns: together with the tail, every turn is either summarized or
      // kept, and none is both.
      expect(sideQueryBodies.length).toBe(1)
      const prompt: string = sideQueryBodies[0].messages.at(-1).content
      const lines = prompt.split('\n')
      before.forEach((m, i) => {
        const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content[0].text}`
        expect(lines.includes(line), `turn ${i} in the summary prompt`).toBe(i < 8)
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('emits message.complete with correct stopReason', async () => {
    const events: any[] = []
    const provider = mockProvider([() => textResponse('done')])

    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
    })

    await loop.handleUserMessage('finish')
    const complete = events.find(e => e.type === 'message.complete')
    expect(complete).toBeDefined()
    expect(complete.stopReason).toBe('end_turn')
  })

  it('applies a harness-supplied contract before auto-create (P4.2)', async () => {
    globalContract.clear()
    // Enough scripted responses to exhaust contract enforcement rounds (cap 5).
    const provider = mockProvider(Array.from({ length: 7 }, () => () => textResponse('done')))
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: () => {},
    })
    await loop.handleUserMessage('carry out the mission described in the brief in full', {
      contract: { title: 'Mission: m1', assertions: ['Verification command exits 0: exit 0'] },
    })
    const snap = globalContract.snapshot()
    expect(snap.title).toBe('Mission: m1')
    expect(snap.assertions.length).toBe(1)
    globalContract.clear()
  })
})

// ─── P1.8: malformed tool-call retry ladder ───────────────────────────────────
// Real ConversationLoop instances, scripted model, same temp folders as above.
describe('malformed tool-call retry ladder (P1.8)', () => {
  // Emit a tool_use block with broken JSON arguments so callModel marks input
  // as { __malformed: true, raw, error }.
  function* malformedToolUse(id: string, raw: string): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }

  it('answers a malformed tool_use with an error tool_result containing the parse error and raw text', async () => {
    const events: any[] = []
    // jsonrepair salvages JSON-ish garbage (e.g. {"file_path": <<<) — only XML-like text genuinely throws
    const RAW = '<tool_call>blah</tool_call>'
    const provider = mockProvider([
      () => malformedToolUse('tu-bad1', RAW),
      () => textResponse('understood'),
    ])
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: (e) => events.push(e),
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('read something')

    // (1) No actual Read tool execution — only the error synthetic result
    const toolCompletes = events.filter(e => e.type === 'tool.complete' && e.toolName === 'Read')
    expect(toolCompletes.length).toBeGreaterThan(0)
    const errComplete = toolCompletes[0]
    expect(errComplete.isError).toBe(true)

    // (2) The result text contains the parse error and the raw offending input
    const resultText = String(errComplete.result)
    // The raw partial JSON was the marker for invalid, result must reference it or its error
    expect(resultText).toMatch(/not valid JSON|unparseable|malformed|parse error/i)

    // (3) toolcall.transport with stage:'retried' was emitted
    const transport = events.find(e => e.type === 'toolcall.transport' && e.stage === 'retried')
    expect(transport).toBeDefined()
    expect(transport.toolName).toBe('Read')
  })

  it('emits stage:discarded to the ledger after the bounded retry is exhausted', async () => {
    const RAW = '<tool_call>blah</tool_call>'
    const events: any[] = []
    // TWO consecutive malformed calls, then recovery text
    const provider = mockProvider([
      () => malformedToolUse('tu-bad1', RAW),
      () => malformedToolUse('tu-bad2', RAW),
      () => textResponse('ok'),
    ])
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: (e) => events.push(e),
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('read something')

    const transports = events.filter(e => e.type === 'toolcall.transport')
    // First is 'retried', second (exhausted) is 'discarded'
    expect(transports.some(e => e.stage === 'retried')).toBe(true)
    expect(transports.some(e => e.stage === 'discarded')).toBe(true)

    // The discarded result tells the model to proceed without the tool call
    const discardedIdx = transports.findIndex(e => e.stage === 'discarded')
    // Verify a tool.complete with is_error was emitted for the second call too
    const errCompletes = events.filter(e => e.type === 'tool.complete' && e.isError === true && e.toolName === 'Read')
    expect(errCompletes.length).toBeGreaterThanOrEqual(2)
    // The discarded result message should tell model to proceed
    const discardedResult = String(errCompletes[1].result)
    expect(discardedResult).toMatch(/proceed|different approach|dropped/i)
  })

  it('a well-formed tool call resets the malformed counter', async () => {
    const RAW = '<tool_call>blah</tool_call>'
    const events: any[] = []

    // malformed → valid Read (nonexistent file) → malformed again
    // third must be stage:'retried' (counter reset by the valid call)
    function* validReadToolUse(): Generator<StreamEvent> {
      yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-valid', name: 'Read', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"C:/nonexistent-cynco-test-file.txt"}' } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }

    const provider = mockProvider([
      () => malformedToolUse('tu-bad1', RAW),     // → retried
      () => validReadToolUse(),                     // → resets counter
      () => malformedToolUse('tu-bad3', RAW),     // → retried (not discarded)
      () => textResponse('done'),
    ])
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: (e) => events.push(e),
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('read something')

    const transports = events.filter(e => e.type === 'toolcall.transport')
    // Should have two 'retried' events and no 'discarded'
    const retried = transports.filter(e => e.stage === 'retried')
    const discarded = transports.filter(e => e.stage === 'discarded')
    expect(retried.length).toBe(2)
    expect(discarded.length).toBe(0)
  }, 20_000) // load-sensitive under the full suite (about 1.6 to 1.9 s alone, against the 5 s default; F207's pattern)

  it('regex XML fallback extraction emits stage:regex_fallback', async () => {
    // Model returns stop_reason 'tool_use' but emits <tool_call> XML text instead
    // of native tool_use blocks — triggers the XML regex fallback path.
    function* xmlFallbackResponse(): Generator<StreamEvent> {
      const xml = '<tool_call>{"name":"Read","arguments":{"file_path":"C:/nonexistent-cynco-test-file.txt"}}</tool_call>'
      yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: xml } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_stop' } as any
      // translateNative synthesizes its own message_delta (end_turn — no tool
      // blocks) at message_stop, clobbering any earlier provider stop_reason.
      // Emit the provider's tool_use stop_reason AFTER message_stop (it passes
      // through the translator's default case) so the loop sees the defensive
      // precondition this fallback exists for: stop=tool_use with zero blocks.
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    }
    const events: any[] = []
    const provider = mockProvider([
      () => xmlFallbackResponse(),
      () => textResponse('done'),
    ])
    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true },
      provider,
      emit: (e) => events.push(e),
      allowedTools: ['Read'],
    })
    await loop.handleUserMessage('read a file')

    const transport = events.find(e => e.type === 'toolcall.transport' && e.stage === 'regex_fallback')
    expect(transport).toBeDefined()
  })
})
