/**
 * Stop reaches a sub-agent (F209).
 *
 * A sub-agent had its own AbortController that nothing outside could reach:
 * `kill()` set a flag the loop read between stream events, and its executor
 * was given no signal. A sub-agent waiting on its model call, or inside a
 * tool, therefore ran on after the turn that started it was stopped, with the
 * GPU generating for nobody.
 *
 * `localCallModel` is mocked to behave as a provider does: it waits until the
 * signal it was given aborts and then throws the abort error; given a signal
 * that never aborts it fails late and says so.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({
  signals: [] as Array<AbortSignal | undefined>,
  /** Per model call: 'hang' waits on the signal; an array is a stream of events. */
  calls: [] as Array<'hang' | any[]>,
}))

vi.mock('../../engine/callModel.js', () => ({
  localCallModel: ({ signal }: { signal?: AbortSignal }) => (async function* () {
    const script = state.calls[state.signals.length] ?? 'hang'
    state.signals.push(signal)
    if (script !== 'hang') { for (const e of script) yield e; return }
    await new Promise<never>((_, reject) => {
      const late = setTimeout(() => reject(new Error('the model call was never told to stop')), 4000)
      const stop = () => { clearTimeout(late); reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) }
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
    })
  })(),
}))

import { SubAgent } from '../../agents/subAgent.js'
import { makeSubAgentConfig } from '../../agents/types.js'
import { ToolExecutor } from '../../tools/executor.js'

function makeAgent(signal?: AbortSignal) {
  return new SubAgent({
    config: makeSubAgentConfig({ task: 'find the auth module', persona: 'scout', maxIterations: 3 }),
    provider: {} as any,
    emit: () => {},
    cwd: process.cwd(),
    model: 'test-model',
    ...(signal ? { signal } : {}),
  })
}

const readCall: any[] = [
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":"package.json"}' } } },
  { type: 'stream_event', event: { type: 'content_block_stop' } },
]

beforeEach(() => { state.signals = []; state.calls = [] })
afterEach(() => { vi.restoreAllMocks() })

describe('Stop reaches a sub-agent', () => {
  it('the parent turn\'s Stop ends a sub-agent that is waiting on its model call', async () => {
    const turn = new AbortController()
    const agent = makeAgent(turn.signal)
    const started = Date.now()
    const running = agent.run()
    setTimeout(() => turn.abort(), 100)
    const result = await running

    expect(Date.now() - started, 'the sub-agent waited for the model instead of stopping').toBeLessThan(3000)
    expect(state.signals).toHaveLength(1)
    expect(state.signals[0]?.aborted, 'the model call must hold a signal that Stop aborts').toBe(true)
    expect(result.success).toBe(false)
    expect(agent.status.state).toBe('killed')
  })

  it('kill() ends a sub-agent that is waiting on its model call (S2\'s kill was a flag nobody read until the next event)', async () => {
    const agent = makeAgent()
    const started = Date.now()
    const running = agent.run()
    setTimeout(() => agent.kill(), 100)
    const result = await running

    expect(Date.now() - started).toBeLessThan(3000)
    expect(state.signals[0]?.aborted).toBe(true)
    expect(result.success).toBe(false)
    expect(agent.status.state).toBe('killed')
  })

  it('a tool the sub-agent runs is handed the signal that Stop aborts', async () => {
    state.calls = [readCall]
    const seen: Array<AbortSignal | undefined> = []
    // As Bash does: the tool ends when its signal aborts.
    vi.spyOn(ToolExecutor.prototype, 'execute').mockImplementation((_name: string, _input: Record<string, unknown>, signal?: AbortSignal) => {
      seen.push(signal)
      return new Promise(resolve => {
        const late = setTimeout(() => resolve({ output: 'the tool was never told to stop', isError: true }), 4000)
        signal?.addEventListener('abort', () => { clearTimeout(late); resolve({ output: 'stopped', isError: true }) }, { once: true })
      })
    })
    const turn = new AbortController()
    const agent = makeAgent(turn.signal)
    const started = Date.now()
    const running = agent.run()
    setTimeout(() => turn.abort(), 150)
    const result = await running

    expect(seen).toHaveLength(1)
    expect(seen[0], 'the executor was given no signal').toBeInstanceOf(AbortSignal)
    expect(seen[0]?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(state.signals, 'no further model call after the Stop').toHaveLength(1)
    expect(result.success).toBe(false)
  })

  it('a sub-agent started after the Stop asks the model nothing', async () => {
    const turn = new AbortController()
    turn.abort()
    const agent = makeAgent(turn.signal)
    const result = await agent.run()
    expect(state.signals).toHaveLength(0)
    expect(result.success).toBe(false)
    expect(agent.status.state).toBe('killed')
  })
})
