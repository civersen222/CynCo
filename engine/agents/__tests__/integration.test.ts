import { describe, test, expect } from 'bun:test'
import { S2Coordinator } from '../s2Coordinator.js'
import { SubAgent } from '../subAgent.js'
import { makeSubAgentConfig } from '../types.js'
import { spawnAgentTool } from '../../tools/impl/spawnAgent.js'
import { collectAgentTool } from '../../tools/impl/collectAgent.js'
import { getToolsForTier } from '../trustTier.js'
import type { EngineEvent } from '../../bridge/protocol.js'

// ─── Mock provider ────────────────────────────────────────────────────────────

function makeMockProvider(text: string) {
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
    async complete() {
      return {
        content: [{ type: 'text', text }],
        model: 'mock',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    },
    async *stream() {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }
    },
    async healthCheck() { return true },
  } as any
}

// ─── Full pipeline ────────────────────────────────────────────────────────────

describe('Integration — full SubAgent pipeline', () => {
  test('config → S2 schedule → run → result with events and decisions', async () => {
    // 1. Use spawnAgentTool.execute() to obtain a config
    const spawnResult = await spawnAgentTool.execute(
      { task: 'Search for all usages of makeSubAgentConfig', persona: 'scout' },
      '/tmp',
    )
    expect(spawnResult.isError).toBe(false)

    const parsed = JSON.parse(spawnResult.output)
    expect(parsed._subagent).toBe(true)
    expect(parsed.config).toBeDefined()
    expect(parsed.config.persona).toBe('scout')

    const config = parsed.config

    // 2. Create S2Coordinator with mock 30% GPU utilisation (green zone → 'run')
    const s2 = new S2Coordinator({ pollGpuUtil: async () => 0.30 })

    // 3. requestSchedule → expect 'run' decision
    const decision = await s2.requestSchedule(config.id)
    expect(decision.decision).toBe('run')
    expect(decision.type).toBe('schedule')
    expect(decision.agentId).toBe(config.id)

    // 4. Create SubAgent, register initial status with S2
    const events: EngineEvent[] = []
    const agent = new SubAgent({
      config,
      provider: makeMockProvider('Found 7 usages of makeSubAgentConfig across the codebase.'),
      emit: (e) => events.push(e),
      cwd: '/tmp',
      model: 'mock-model',
    })

    s2.registerAgent(agent.status)

    // 5. Run the agent
    const result = await agent.run()

    // 6. Verify result
    expect(result.success).toBe(true)
    expect(result.agentId).toBe(config.id)
    expect(result.output).toContain('makeSubAgentConfig')
    expect(result.turns).toBeGreaterThanOrEqual(1)

    // 7. Verify events emitted
    const spawnedEvent = events.find(e => e.type === 'subagent.spawned')
    expect(spawnedEvent).toBeDefined()
    expect((spawnedEvent as any).agentId).toBe(config.id)
    expect((spawnedEvent as any).persona).toBe('scout')

    const completeEvent = events.find(e => e.type === 'subagent.complete')
    expect(completeEvent).toBeDefined()
    expect((completeEvent as any).success).toBe(true)
    expect((completeEvent as any).output).toContain('makeSubAgentConfig')

    // 8. Verify S2 state has decisions recorded
    const s2State = s2.getState()
    expect(s2State.decisions.length).toBeGreaterThanOrEqual(1)
    expect(s2State.decisions[0].type).toBe('schedule')
    expect(s2State.decisions[0].decision).toBe('run')
  })
})

// ─── Trust tier tool filtering ────────────────────────────────────────────────

describe('Integration — trust tier gives scouts only read-only tools', () => {
  test('readonly scout has Read and Grep but not Write, Edit, Bash, or SubAgent', () => {
    const tools = getToolsForTier('readonly', 'scout')
    const toolNames = tools.map(t => t.name)

    // Must have read-only tools
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Grep')
    expect(toolNames).toContain('Glob')

    // Must NOT have write/exec/spawn tools
    expect(toolNames).not.toContain('Write')
    expect(toolNames).not.toContain('Edit')
    expect(toolNames).not.toContain('Bash')
    expect(toolNames).not.toContain('SubAgent')
  })
})

// ─── CollectAgent marker ──────────────────────────────────────────────────────

describe('Integration — collectAgentTool returns _collectAgent marker', () => {
  test('returns _collectAgent: true with the correct agentId', async () => {
    const result = await collectAgentTool.execute({ agentId: 'scout-abc123' }, '/tmp')

    expect(result.isError).toBe(false)

    const parsed = JSON.parse(result.output)
    expect(parsed._collectAgent).toBe(true)
    expect(parsed.agentId).toBe('scout-abc123')
  })

  test('returns error when agentId is empty', async () => {
    const result = await collectAgentTool.execute({ agentId: '' }, '/tmp')
    expect(result.isError).toBe(true)
  })
})
