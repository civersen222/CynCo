/**
 * Proof that brain telemetry lands on disk and joins to the trajectory row.
 *
 * Everything the Brain measured used to be broadcast to the dashboard and
 * dropped, and the brain messages carried no task or turn key, so no entropy
 * reading could ever be attached to the turn that produced it. These tests
 * drive the real loop with a provider that emits tool logprobs and assert the
 * JSONL exists AND that its key matches the trajectory row beside it.
 *
 * No dashboardBroadcast is passed. That is the point: the entropy loop used to
 * sit behind the dashboard guard, so the divergence floor and the recorded
 * telemetry existed only while someone happened to be watching.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { initTrajectoryRecorder } from '../../training/trajectoryRecorder.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent, TokenLogprob } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test-model',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
    approveAll: true,
  } as LocalCodeConfig
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let idx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[idx++]
      if (gen) yield* gen()
    },
  }
}

// A non-empty `top` is required: UncertaintyTracker.entropy() returns null for
// an empty distribution, so an empty top would make the entropy assertions
// vacuously true no matter how the wiring behaved.
const toolLps: TokenLogprob[] = [
  { token: 'x', logprob: -0.1, top: [{ token: 'x', logprob: -0.1 }, { token: 'y', logprob: -2.3 }] },
]

function* readToolUseWithLogprobs(filePath: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {}, logprobs: toolLps } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: filePath }), logprobs: toolLps } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function jsonl(path: string): any[] {
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function runOnce(): Promise<{ trajDir: string }> {
  globalContract.clear()
  const cwd = tempDir('cynco-brain-cwd-')
  const trajDir = tempDir('cynco-brain-out-')
  initTrajectoryRecorder(trajDir)

  const loop = new ConversationLoop({
    cwd,
    config: config(),
    provider: mockProvider([
      () => readToolUseWithLogprobs(join(cwd, 'nonexistent.txt')),
      () => textResponse('done'),
    ]),
    emit: () => {},
    allowedTools: ['Read'],
  })

  await loop.handleUserMessage('read the file for me please')
  globalContract.clear()
  return { trajDir }
}

describe('brain telemetry is recorded and joinable', () => {
  it('a tool call writes a brain row that joins to its trajectory row', async () => {
    const { trajDir } = await runOnce()

    const brainDir = join(trajDir, 'brain')
    const brainFiles = readdirSync(brainDir).filter(f => f.endsWith('.jsonl'))
    expect(brainFiles.length).toBe(1)

    const brainRows = jsonl(join(brainDir, brainFiles[0])).filter(r => r.kind === 'turn')
    expect(brainRows.length).toBeGreaterThan(0)

    const trajFiles = readdirSync(trajDir).filter(f => f.endsWith('.jsonl'))
    const trajRows = jsonl(join(trajDir, trajFiles[0]))

    // The join has to land on the row that produced the reading, not the one
    // after it: turnIdx is read before recordTurn, which increments it.
    for (const b of brainRows) {
      const match = trajRows.filter(t => t.task_id === b.task_id && t.turn_idx === b.turn_idx)
      expect(match).toHaveLength(1)
    }
    expect(brainRows.map(b => b.turn_idx)).toContain(trajRows[0].turn_idx)
    expect(brainRows[0].task_id).toBe(trajRows[0].task_id)
  }, 30000)

  it('captures tool entropy with no dashboard attached', async () => {
    const { trajDir } = await runOnce()

    const brainDir = join(trajDir, 'brain')
    const rows = jsonl(join(brainDir, readdirSync(brainDir)[0])).filter(r => r.kind === 'turn')
    const e = rows[0].tool_entropy
    expect(e).not.toBeNull()
    expect(e.n).toBeGreaterThan(0)
    expect(Number.isFinite(e.mean)).toBe(true)
    expect(e.min).toBeLessThanOrEqual(e.mean)
    expect(e.max).toBeGreaterThanOrEqual(e.mean)
  }, 30000)

  it('the brain directory follows the trajectories and never the live corpus', async () => {
    const trajDir = tempDir('cynco-brain-out-')
    const recorder = initTrajectoryRecorder(trajDir)
    expect(recorder.brainDir.startsWith(trajDir)).toBe(true)
  })
})
