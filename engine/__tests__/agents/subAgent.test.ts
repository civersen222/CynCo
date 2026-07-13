// engine/__tests__/agents/subAgent.test.ts
// NOTE: import vi from 'vitest' (not 'bun:test') — precedent: bootstrapProvider.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Streams are configured per-test via this holder. vi.hoisted is required:
// vi.mock factories are hoisted above top-level `let` declarations.
const state = vi.hoisted(() => ({
  streamEvents: [] as any[],
  // For multi-turn tests: each entry is one model-call's stream events.
  // If set, takes priority over streamEvents.
  streamSequence: null as any[][] | null,
  callCount: 0,
  // Captures messages passed to each localCallModel call (index = call number).
  capturedMessages: [] as any[][],
}))

vi.mock('../../engine/callModel.js', () => ({
  localCallModel: ({ messages }: any) => {
    // Record the messages snapshot for this call
    state.capturedMessages.push(messages ? JSON.parse(JSON.stringify(messages)) : [])
    return (async function* () {
      const seq = state.streamSequence
      if (seq) {
        const idx = state.callCount++
        const events = seq[idx] ?? seq[seq.length - 1]
        for (const e of events) yield e
      } else {
        for (const e of state.streamEvents) yield e
      }
    })()
  },
}))

import { SubAgent } from '../../agents/subAgent.js'
import { makeSubAgentConfig } from '../../agents/types.js'
import { ToolExecutor } from '../../tools/executor.js'

function makeAgent(emit?: (ev: any) => void) {
  return new SubAgent({
    config: makeSubAgentConfig({ task: 'find the auth module', persona: 'scout', maxIterations: 3 }),
    provider: {} as any,
    emit: emit ?? (() => {}),
    cwd: process.cwd(),
    model: 'test-model',
  })
}

function textEvents(text: string): any[] {
  return [
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    { type: 'stream_event', event: { type: 'content_block_stop' } },
  ]
}

function toolUseEvents(id: string, name: string, partialJson: string): any[] {
  return [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id, name, input: {} },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: partialJson },
      },
    },
    { type: 'stream_event', event: { type: 'content_block_stop' } },
  ]
}

beforeEach(() => {
  state.streamSequence = null
  state.callCount = 0
  state.capturedMessages = []
})

describe('SubAgent silent-success', () => {
  it('reports failure when the model streams zero output', async () => {
    state.streamEvents = [] // model produces nothing at all
    const agent = makeAgent()
    const result = await agent.run()
    expect(result.success).toBe(false)
    expect(result.output).toBe('(no output)')
    expect(agent.status.state).toBe('failed')
  })

  it('reports failure when the model streams only whitespace', async () => {
    state.streamEvents = textEvents('   \n  ')
    const agent = makeAgent()
    const result = await agent.run()
    expect(result.success).toBe(false)
    expect(agent.status.state).toBe('failed')
  })

  it('reports success when the model streams real text', async () => {
    state.streamEvents = textEvents('The auth module is in src/auth.ts')
    const agent = makeAgent()
    const result = await agent.run()
    expect(result.success).toBe(true)
    expect(result.output).toBe('The auth module is in src/auth.ts')
    expect(agent.status.state).toBe('completed')
  })
})

describe('SubAgent P1.8 repair-ladder parity', () => {
  it('salvageable args (trailing comma) are repaired and tool executes with correct input', async () => {
    // Turn 1: tool_use with trailing-comma JSON (strict-invalid, jsonrepair-fixable)
    // Turn 2: plain text so agent stops
    const executeSpy = vi.spyOn(ToolExecutor.prototype, 'execute').mockResolvedValue({
      output: 'file contents here',
      isError: false,
    })

    state.streamSequence = [
      // Call 1: model emits a tool_use with salvageable JSON (trailing comma)
      toolUseEvents('tool_1', 'Read', '{"file_path": "a.ts",}'),
      // Call 2: model responds with text (done)
      textEvents('Done reading the file.'),
    ]

    const agent = makeAgent()
    const result = await agent.run()

    // The tool should have been called exactly once with the repaired input
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(executeSpy).toHaveBeenCalledWith('Read', { file_path: 'a.ts' })

    // Agent should succeed (second turn yielded text output)
    expect(result.success).toBe(true)

    executeSpy.mockRestore()
  })

  it('unrepairable args are not executed, and the next model turn receives an is_error tool_result containing "not valid JSON"', async () => {
    const executeSpy = vi.spyOn(ToolExecutor.prototype, 'execute').mockResolvedValue({
      output: 'should not be called',
      isError: false,
    })

    const emittedEvents: any[] = []

    // The XML-ish string: established fixture that jsonrepair cannot salvage
    const unrepairableJson = '<tool_call>blah</tool_call>'

    // Multi-turn: call 1 → malformed tool_use; call 2 → text (agent done)
    state.streamSequence = [
      toolUseEvents('tool_bad', 'Read', unrepairableJson),
      textEvents('Recovered after malformed call.'),
    ]

    const agent = new SubAgent({
      config: makeSubAgentConfig({ task: 'find the auth module', persona: 'scout', maxIterations: 3 }),
      provider: {} as any,
      emit: (ev: any) => { emittedEvents.push(ev) },
      cwd: process.cwd(),
      model: 'test-model',
    })

    const result = await agent.run()

    // ToolExecutor.execute must NOT have been called for the malformed tool
    expect(executeSpy).not.toHaveBeenCalled()

    // An error event should have been emitted for the malformed tool call
    const errorEvent = emittedEvents.find(
      (ev: any) => ev.type === 'subagent.tool' && ev.status === 'error' && ev.toolName === 'Read'
    )
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.preview).toMatch(/[Mm]alformed/)

    // The second localCallModel call's messages should contain an is_error tool_result
    // with content mentioning "not valid JSON"
    expect(state.capturedMessages.length).toBeGreaterThanOrEqual(2)
    const secondCallMsgs = state.capturedMessages[1]
    const toolResultMsg = secondCallMsgs.find(
      (m: any) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === 'tool_result' && c.is_error === true)
    )
    expect(toolResultMsg).toBeDefined()

    const errorBlock = toolResultMsg?.content?.find(
      (c: any) => c.type === 'tool_result' && c.is_error === true
    )
    expect(errorBlock?.content).toMatch(/not valid JSON/)

    // Agent eventually succeeds because second turn returned text
    expect(result.success).toBe(true)

    executeSpy.mockRestore()
  })
})
