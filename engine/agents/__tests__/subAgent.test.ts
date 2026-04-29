import { describe, test, expect } from 'bun:test'
import { SubAgent } from '../subAgent.js'
import { makeSubAgentConfig } from '../types.js'
import type { Provider } from '../../provider.js'
import type { EngineEvent } from '../../bridge/protocol.js'

function makeMockProvider(responseText: string): Provider {
  return {
    name: 'mock',
    async listModels() { return [] },
    async probeCapabilities() {
      return {
        tier: 'standard' as const,
        toolUse: 'native' as const,
        thinking: 'none' as const,
        vision: false,
        jsonMode: false,
        contextLength: 32768,
        streaming: false,
      }
    },
    async complete(req: any) {
      return {
        content: [{ type: 'text', text: responseText }],
        model: 'mock',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    },
    async *stream(req: any) {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: responseText } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }
    },
    async healthCheck() { return true },
  } as any
}

function makeConfig(overrides?: Partial<Parameters<typeof makeSubAgentConfig>[0]>) {
  return makeSubAgentConfig({
    task: 'Find all usages of the foo function',
    persona: 'scout',
    trustTier: 'readonly',
    ...overrides,
  })
}

describe('SubAgent', () => {
  test('creates with config and has correct ID and queued state', () => {
    const config = makeConfig()
    const events: EngineEvent[] = []
    const agent = new SubAgent({
      config,
      provider: makeMockProvider('hello'),
      emit: (e) => events.push(e),
      cwd: '/tmp',
      model: 'mock-model',
    })

    expect(agent.id).toBe(config.id)
    expect(agent.status.state).toBe('queued')
    expect(agent.status.persona).toBe('scout')
    expect(agent.status.task).toBe('Find all usages of the foo function')
  })

  test('run() executes and returns a successful result with output text', async () => {
    const config = makeConfig()
    const events: EngineEvent[] = []
    const agent = new SubAgent({
      config,
      provider: makeMockProvider('The foo function is used in 3 files.'),
      emit: (e) => events.push(e),
      cwd: '/tmp',
      model: 'mock-model',
    })

    const result = await agent.run()

    expect(result.success).toBe(true)
    expect(result.agentId).toBe(config.id)
    expect(result.output).toContain('foo function')
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(agent.status.state).toBe('completed')
  })

  test('emits subagent.spawned event on start', async () => {
    const config = makeConfig()
    const events: EngineEvent[] = []
    const agent = new SubAgent({
      config,
      provider: makeMockProvider('done'),
      emit: (e) => events.push(e),
      cwd: '/tmp',
      model: 'mock-model',
    })

    await agent.run()

    const spawned = events.find(e => e.type === 'subagent.spawned')
    expect(spawned).toBeDefined()
    expect((spawned as any).agentId).toBe(config.id)
    expect((spawned as any).persona).toBe('scout')
    expect((spawned as any).task).toBe('Find all usages of the foo function')
  })

  test('emits subagent.complete event on finish', async () => {
    const config = makeConfig()
    const events: EngineEvent[] = []
    const agent = new SubAgent({
      config,
      provider: makeMockProvider('result text'),
      emit: (e) => events.push(e),
      cwd: '/tmp',
      model: 'mock-model',
    })

    await agent.run()

    const complete = events.find(e => e.type === 'subagent.complete')
    expect(complete).toBeDefined()
    expect((complete as any).agentId).toBe(config.id)
    expect((complete as any).success).toBe(true)
    expect((complete as any).output).toContain('result text')
  })

  test('kill() sets state to killed', () => {
    const config = makeConfig()
    const events: EngineEvent[] = []
    const agent = new SubAgent({
      config,
      provider: makeMockProvider('hello'),
      emit: (e) => events.push(e),
      cwd: '/tmp',
      model: 'mock-model',
    })

    expect(agent.status.state).toBe('queued')
    agent.kill()
    expect(agent.status.state).toBe('killed')
  })
})
