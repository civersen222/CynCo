/**
 * A sub-agent's loop refuses a call before its executor sees it (a tool outside its trust tier, arguments
 * that are not JSON): that call has a `refused` record, `src: 'subagent'`, `by: 'loop'`, as the main
 * loop's refusals do (review of slice S5, F242). `localCallModel` is mocked to replay one tool call, then
 * end; the audit writes into a marked temp folder (auditWorld).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRunContainment } from '../../containment.js'
import { auditWorld, type AuditWorld } from '../audit/auditWorld.js'

const state = vi.hoisted(() => ({ calls: [] as any[][], n: 0 }))
vi.mock('../../engine/callModel.js', () => ({
  localCallModel: () => (async function* () {
    const script = state.calls[state.n++] ?? []
    for (const e of script) yield e
  })(),
}))

const { SubAgent } = await import('../../agents/subAgent.js')
const { makeSubAgentConfig } = await import('../../agents/types.js')

const worlds: AuditWorld[] = []
afterEach(() => { setRunContainment(null); state.calls = []; state.n = 0; for (const w of worlds.splice(0)) w.cleanup(); vi.restoreAllMocks() })

const toolCall = (name: string, input: Record<string, unknown>) => [
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name, input } } },
  { type: 'stream_event', event: { type: 'content_block_stop' } },
]

async function runAgent(w: AuditWorld, call: any[]) {
  state.calls = [call, []]
  const agent = new SubAgent({
    config: makeSubAgentConfig({ task: 'look around', persona: 'scout', maxIterations: 2 }),
    provider: {} as any, emit: () => {}, cwd: w.mission, model: 'test-model',
  })
  await agent.run()
}

describe('a sub-agent\'s loop refusals are recorded', () => {
  it('a tool outside its trust tier', async () => {
    const w = auditWorld(); worlds.push(w)
    setRunContainment(w.ctx)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runAgent(w, toolCall('Bash', { command: 'Remove-Item x' }))
    const refused = w.records().filter(r => r.kind === 'refused')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ src: 'subagent', by: 'loop', tool: 'Bash', input: { command: 'Remove-Item x' }, cwd: w.mission })
    expect(String(refused[0]!.reason)).toContain("is not allowed for this agent's trust tier")
    expect(w.records().some(r => r.kind === 'start')).toBe(false)
  })
  it('arguments that are not JSON', async () => {
    const w = auditWorld(); worlds.push(w)
    setRunContainment(w.ctx)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runAgent(w, toolCall('Read', { __malformed: true, raw: '{"file_path": ', error: 'unparseable JSON' }))
    const refused = w.records().filter(r => r.kind === 'refused')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ src: 'subagent', by: 'loop', tool: 'Read' })
    expect(String(refused[0]!.reason)).toContain('was not executed: its arguments were not valid JSON')
  })
})
