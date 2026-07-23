import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent, TokenLogprob } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const loop = readFileSync('engine/bridge/conversationLoop.ts', 'utf-8')
const main = readFileSync('engine/main.ts', 'utf-8')

describe('brain wiring (static)', () => {
  it('conversationLoop feeds ThinkingRecorder on thinking deltas', () => {
    expect(loop).toMatch(/thinkingRecorder\?\.onThinkingDelta/)
    expect(loop).toMatch(/thinkingRecorder\?\.finalizeTurn/)
  })
  it('conversationLoop observes uncertainty on both delta kinds', () => {
    expect(loop.match(/observeUncertainty\(/g)!.length).toBeGreaterThanOrEqual(3) // 2 call sites + def
  })
  it('brain.uncertainty goes through dashboardBroadcast, not this.emit (protocol guard)', () => {
    expect(loop).toMatch(/dashboardBroadcast\(\{ type: 'brain\.uncertainty'/)
    expect(loop).not.toMatch(/emit\(\{\s*type: 'brain\./)
  })
  it('main.ts passes dashboardBroadcast to the loop', () => {
    expect(main).toMatch(/dashboardBroadcast/)
  })
  it('brain state resets at model-call start and recorder follows resume()', () => {
    expect(loop).toMatch(/resetBrainTurnState\(\)/)
    expect(loop.match(/new ThinkingRecorder\(/g)!.length).toBeGreaterThanOrEqual(2) // init + resume
  })
})

// ─── Behavioral: brain.toolUncertainty wiring ─────────────────────────────────
// Drives a real ConversationLoop with a mock provider stream that carries
// logprobs on tool-call chunks, and asserts the dashboardBroadcast side-effect.
// This is NOT a source-string scan: it would fail if the observeUncertainty
// call sites were dead code (e.g. wrapped in `if (false)`), because it captures
// the actual broadcast the flush produces at message_stop.

// ConversationLoop's constructor initSnapshot()s its cwd (git add -A into
// .cynco-snapshots/) — point it at a temp dir so tests never stage the repo
// root (same hazard fix the sibling loop tests use).
const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-brain-cwd-'))
const READ_FILE = path.join(TEST_CWD, 'loopfile.txt')
fs.writeFileSync(READ_FILE, 'budget data\n')
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
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
  } as LocalCodeConfig
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

function mockProvider(gens: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = gens[callIdx++]
      if (gen) yield* gen()
    },
  }
}

// TokenLogprob shape is { token, logprob, top: [...] } (engine/types.ts). The
// `top` distribution MUST be non-empty: UncertaintyTracker.entropy() returns
// null for an empty `top` (no distribution to measure), so such tokens are
// never batched and never broadcast. A behavioral test therefore has to supply
// a real top-k distribution — an empty `top: []` would make the assertions
// vacuously true regardless of wiring.
const toolLps: TokenLogprob[] = [
  { token: 'x', logprob: -0.1, top: [{ token: 'x', logprob: -0.1 }, { token: 'y', logprob: -2.3 }] },
]
const textLps: TokenLogprob[] = [
  { token: 'a', logprob: -0.05, top: [{ token: 'a', logprob: -0.05 }, { token: 'b', logprob: -3.0 }] },
]

// Emit `end_turn` AFTER `message_stop`: the native translator synthesizes its
// own tool_use stop at message_stop, but a trailing message_delta passes through
// its default case and sets the loop's stopReason to end_turn. The loop then
// records the tool block but does NOT execute it (execution needs
// stopReason === 'tool_use'), so the run is a single deterministic turn — no
// tool result, no governance nudge loop, no runaway iteration. Uncertainty is
// still observed live from the stream and flushed at message_stop.

// A single turn whose input_json_delta carries logprobs (T5 delta path).
function* toolDeltaLogprobsTurn(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"k":1}', logprobs: toolLps } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
}

// A single turn whose content_block_start (the tool-name token) carries
// logprobs (T5 content_block_start path).
function* toolBlockStartLogprobsTurn(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {}, logprobs: toolLps } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"k":1}' } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
}

// A single turn mixing an OUTPUT text delta (logprobs) AND a tool delta
// (logprobs) — proves the two kinds land on separate channels in one flush.
function* mixedOutputAndToolTurn(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi', logprobs: textLps } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
  yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"k":1}', logprobs: toolLps } } as any
  yield { type: 'content_block_stop', index: 1 } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
}

/** Drive one full loop turn and collect every dashboard broadcast it produced. */
async function runAndCaptureBroadcasts(gen: () => Generator<StreamEvent>): Promise<Array<Record<string, unknown>>> {
  const broadcasts: Array<Record<string, unknown>> = []
  const loopInstance = new ConversationLoop({
    cwd: TEST_CWD,
    config: { ...defaultConfig(), approveAll: true } as LocalCodeConfig,
    provider: mockProvider([gen]),
    emit: () => {},
    dashboardBroadcast: (msg) => broadcasts.push(msg),
    allowedTools: ['Read'],
  })
  await loopInstance.handleUserMessage('read a file')
  return broadcasts
}

describe('brain.toolUncertainty wiring (behavioral)', () => {
  it('input_json_delta logprobs broadcast brain.toolUncertainty with kind:"tool" points', async () => {
    const broadcasts = await runAndCaptureBroadcasts(toolDeltaLogprobsTurn)

    const toolMsgs = broadcasts.filter(b => b.type === 'brain.toolUncertainty')
    expect(toolMsgs.length).toBeGreaterThan(0)
    const points = toolMsgs.flatMap(b => (b.points as Array<Record<string, unknown>>) ?? [])
    expect(points.length).toBeGreaterThan(0)
    expect(points.every(p => p.kind === 'tool')).toBe(true)
  })

  it('tool points do NOT leak into any brain.uncertainty broadcast', async () => {
    // One turn carrying BOTH an output text delta and a tool delta.
    const broadcasts = await runAndCaptureBroadcasts(mixedOutputAndToolTurn)

    // The tool channel carries the tool points…
    const toolPoints = broadcasts
      .filter(b => b.type === 'brain.toolUncertainty')
      .flatMap(b => (b.points as Array<Record<string, unknown>>) ?? [])
    expect(toolPoints.length).toBeGreaterThan(0)
    expect(toolPoints.every(p => p.kind === 'tool')).toBe(true)

    // …and the general channel got the output points but NEVER a tool point.
    const generalMsgs = broadcasts.filter(b => b.type === 'brain.uncertainty')
    const generalPoints = generalMsgs.flatMap(b => (b.points as Array<Record<string, unknown>>) ?? [])
    expect(generalPoints.length).toBeGreaterThan(0) // the text_delta produced output points
    expect(generalPoints.some(p => p.kind === 'tool')).toBe(false)
  })

  it('content_block_start tool_use logprobs broadcast brain.toolUncertainty', async () => {
    const broadcasts = await runAndCaptureBroadcasts(toolBlockStartLogprobsTurn)

    const toolMsgs = broadcasts.filter(b => b.type === 'brain.toolUncertainty')
    expect(toolMsgs.length).toBeGreaterThan(0)
    const points = toolMsgs.flatMap(b => (b.points as Array<Record<string, unknown>>) ?? [])
    expect(points.length).toBeGreaterThan(0)
    expect(points.every(p => p.kind === 'tool')).toBe(true)
  })
})

describe('brain.toolUncertainty is dashboard-only (protocol absence)', () => {
  it('brain.toolUncertainty is NOT in the engine→TUI protocol (ts or py)', () => {
    const tsProto = readFileSync('engine/bridge/protocol.ts', 'utf-8')
    const pyProto = readFileSync('tui/localcode_tui/protocol.py', 'utf-8')
    expect(tsProto).not.toMatch(/toolUncertainty/)
    expect(pyProto).not.toMatch(/toolUncertainty/)
  })
})

// ─── Behavioral: read-loop escalation → context hygiene + brain.toolDivergence ──
// Drives the SAME denied Read signature through the tool-execution path enough
// times to trip ReadLoopGate escalation (allow → warn → deny → deny → escalate),
// then asserts the loop pruned redundant history and emitted the governance +
// dashboard signals. Fails if the escalate branch is dead code.
function readExecTurn(n: number): () => Generator<StreamEvent> {
  return function* () {
    yield { type: 'message_start', message: { id: `m${n}`, model: 'test', usage: { input_tokens: 5, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${n}`, name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: READ_FILE }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_stop' } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  }
}
function* stopTurn(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'mstop', model: 'test', usage: { input_tokens: 5, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } as any
}

describe('read-loop escalation → hygiene wiring (behavioral)', () => {
  it('escalation prunes redundant reads and emits brain.toolDivergence + governance.alert', async () => {
    const broadcasts: Array<Record<string, unknown>> = []
    const alerts: Array<Record<string, unknown>> = []
    const gens = [readExecTurn(1), readExecTurn(2), readExecTurn(3), readExecTurn(4), readExecTurn(5), stopTurn]
    const loopInstance = new ConversationLoop({
      cwd: TEST_CWD,
      config: { ...defaultConfig(), approveAll: true } as LocalCodeConfig,
      provider: mockProvider(gens),
      emit: (e: any) => { if (e?.type === 'governance.alert') alerts.push(e) },
      dashboardBroadcast: (msg) => broadcasts.push(msg),
      allowedTools: ['Read'],
    })
    await loopInstance.handleUserMessage('read the budget file over and over')

    const div = broadcasts.filter(b => b.type === 'brain.toolDivergence')
    expect(div.length).toBeGreaterThan(0)
    expect(div[0].tool).toBe('Read')
    expect((div[0].prunedMessages as number)).toBeGreaterThan(0)
    expect(alerts.some(a => String(a.message).includes('[context-hygiene]'))).toBe(true)
  })
})
