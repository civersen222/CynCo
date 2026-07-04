// engine/__tests__/agents/subAgent.test.ts
// NOTE: import vi from 'vitest' (not 'bun:test') — precedent: bootstrapProvider.test.ts
import { describe, expect, it, vi } from 'vitest'

// Streams are configured per-test via this holder. vi.hoisted is required:
// vi.mock factories are hoisted above top-level `let` declarations.
const state = vi.hoisted(() => ({ streamEvents: [] as any[] }))

vi.mock('../../engine/callModel.js', () => ({
  localCallModel: () => (async function* () {
    for (const e of state.streamEvents) yield e
  })(),
}))

import { SubAgent } from '../../agents/subAgent.js'
import { makeSubAgentConfig } from '../../agents/types.js'

function makeAgent() {
  return new SubAgent({
    config: makeSubAgentConfig({ task: 'find the auth module', persona: 'scout', maxIterations: 3 }),
    provider: {} as any,
    emit: () => {},
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
