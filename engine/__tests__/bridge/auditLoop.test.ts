/**
 * The tool-call audit through the conversation loop (F242, slice S5): a call the loop refuses before
 * the executor sees it has a `refused` record (`by: 'loop'`), a start that cannot be written is rule
 * 5's tool result AND one critical `governance.alert` from the audit layer, and the loop's tool line
 * carries the exit code. Under a test context over a marked temp audit folder (auditWorld); the
 * mock-provider pattern of denialVisibility.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { AUDIT_NOT_WRITTEN, setContainmentFaultSink } from '../../audit/toolAudit.js'
import { refusalText, setRunContainment } from '../../containment.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'
import { auditWorld, blockDayFile, type AuditWorld } from '../audit/auditWorld.js'

// These cases start real shells (PowerShell on Windows), which under the full suite's load take
// longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const worlds: AuditWorld[] = []
const savedSwitch = process.env.LOCALCODE_CONTAINMENT_OFF
afterEach(() => {
  setRunContainment(null)
  setContainmentFaultSink(null)
  if (savedSwitch === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
  else process.env.LOCALCODE_CONTAINMENT_OFF = savedSwitch
  vi.restoreAllMocks()
  for (const w of worlds.splice(0)) w.cleanup()
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: undefined, tools: undefined, noScouts: true,
    approveAll: true,
  } as LocalCodeConfig
}

function capabilities(): ModelCapabilities {
  return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
}

function provider(gens: Array<() => Generator<StreamEvent>>): Provider {
  let i = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { return capabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> {
      const g = gens[i++]
      if (g) yield* g()
    },
  }
}

// Each run pins its tools (allowedTools), as a mission does: that also turns off the two-stage
// routing, whose first model call would otherwise take the scripted tool call.

/** One tool call, with its input streamed as JSON text (or given whole at block start). */
function call(name: string, inputJson: string | null, startInput: Record<string, unknown> = {}) {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name, input: startInput } } as any
    if (inputJson !== null) yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function* silence(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm2', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as any
}

async function run(w: AuditWorld, gens: Array<() => Generator<StreamEvent>>, extra: Record<string, unknown> = {}) {
  const events: any[] = []
  const loop = new ConversationLoop({
    cwd: w.mission, config: config(), provider: provider(gens), emit: (e: any) => { events.push(e) }, ...extra,
  } as any)
  await loop.handleUserMessage('go')
  return events
}

describe('the loop\'s own refusals are recorded', () => {
  it('a tool outside allowedTools leaves one refused record by the loop, with the refusal text', async () => {
    const w = auditWorld(); worlds.push(w)
    setRunContainment(w.ctx)
    await run(w, [call('Bash', '{"command":"ls"}'), silence], { allowedTools: ['Read'] })
    const refused = w.records().filter(r => r.kind === 'refused')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ by: 'loop', src: 'tool', tool: 'Bash', input: { command: 'ls' }, cwd: w.mission })
    expect(refused[0]!.reason).toMatch(/^Tool "Bash" is not available in this run\./)
    expect(w.records().some(r => r.kind === 'start')).toBe(false)
  })

  it('a call with malformed arguments leaves one refused record', async () => {
    const w = auditWorld(); worlds.push(w)
    setRunContainment(w.ctx)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await run(w, [call('Read', null, { __malformed: true, raw: '{"file_path": ', error: 'unparseable JSON' }), silence], { allowedTools: ['Read'] })
    const refused = w.records().filter(r => r.kind === 'refused')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ by: 'loop', tool: 'Read' })
    expect(w.records().some(r => r.kind === 'start')).toBe(false)
  })
})

describe('a batch the loop skips', () => {
  // Review of slice S5: every call of a batch the loop does not run (the context-critical stop, a cut
  // stream) is a call it refused, and has its record.
  it('leaves one refused record per call, by the loop, with the reason the model is told', () => {
    const w = auditWorld(); worlds.push(w)
    setRunContainment(w.ctx)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const loop = new ConversationLoop({ cwd: w.mission, config: config(), provider: provider([]), emit: () => {} } as any)
    ;(loop as any).dropToolBatch([
      { id: 'a', name: 'Bash', input: { command: 'Remove-Item x' } },
      { id: 'b', name: 'Read', input: { file_path: 'y' } },
    ], 'test', 'the context window is full')
    const refused = w.records().filter(r => r.kind === 'refused')
    expect(refused.map(r => [r.tool, r.by, r.src])).toEqual([['Bash', 'loop', 'tool'], ['Read', 'loop', 'tool']])
    expect(refused[0]).toMatchObject({ input: { command: 'Remove-Item x' }, reason: 'Tool call "Bash" was not executed: the context window is full' })
  })
})

describe('a start that cannot be written', () => {
  it('is rule 5\'s tool result and one critical governance.alert from the audit layer', async () => {
    const w = auditWorld(); worlds.push(w)
    writeFileSync(join(w.mission, 'notes.txt'), 'x')
    blockDayFile(w)
    setRunContainment(w.ctx)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const events = await run(w, [call('Read', JSON.stringify({ file_path: join(w.mission, 'notes.txt') })), silence], { allowedTools: ['Read'] })
    const done = events.find(e => e.type === 'tool.complete' && e.toolName === 'Read')
    expect(done.result).toBe(refusalText('audit', AUDIT_NOT_WRITTEN('audit-dir-unwritable')))
    const alerts = events.filter(e => e.type === 'governance.alert' && e.source === 'audit')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ severity: 'critical', message: AUDIT_NOT_WRITTEN('audit-dir-unwritable') })
  })
})

describe('the tool line', () => {
  it('a successful Bash call prints its exit code', async () => {
    const w = auditWorld(); worlds.push(w)
    setRunContainment(w.ctx)
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    const log = vi.spyOn(console, 'log')
    await run(w, [call('Bash', '{"command":"echo hi"}'), silence], { allowedTools: ['Bash'] })
    expect(log.mock.calls.some(c => String(c[0]) === '[loop] Tool result: Bash isError=false exit=0')).toBe(true)
    const recs = w.records()
    expect(recs.find(r => r.kind === 'start')).toMatchObject({ tool: 'Bash', input: { command: 'echo hi' } })
    expect(recs.find(r => r.kind === 'end')).toMatchObject({ isError: false, exitCode: 0 })
  })
})
