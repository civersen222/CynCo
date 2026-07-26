/**
 * Proof that a tool call reaches the trajectory recorder.
 *
 * conversationLoop reached the training modules through lazy require('*.js').
 * Under vitest those requires threw, and the call sites were wrapped in bare
 * `catch {}` — so every test that exercised a tool call took the catch branch
 * and the corpus writer was uncovered by construction. Nothing in the suite
 * would have noticed if recordTurn had stopped being called altogether.
 *
 * These tests run the real loop against a mock provider and assert the JSONL
 * line exists on disk. If the wiring breaks again, they go red.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { initTrajectoryRecorder } from '../../training/trajectoryRecorder.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
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
    // Above the two-stage tool-routing threshold, so the routing pre-call does
    // not consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
    approveAll: true,
  }
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

function* readToolUse(filePath: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: filePath }) } } as any
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

describe('trajectory recording is on a live path', () => {
  it('a tool call writes a turn to the trajectory JSONL', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-traj-cwd-')
    const trajDir = tempDir('cynco-traj-out-')
    initTrajectoryRecorder(trajDir)

    const events: any[] = []
    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        () => readToolUse(join(cwd, 'nonexistent.txt')),
        () => textResponse('done'),
      ]),
      emit: (e: any) => events.push(e),
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read the file for me please')

    const files = readdirSync(trajDir).filter(f => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)

    const lines = readFileSync(join(trajDir, files[0]), 'utf-8').trim().split('\n')
    const turn = JSON.parse(lines[0])
    expect(turn.tool_calls[0].name).toBe('Read')
    // The model name is what datasetBuilder groups DPO pairs by — a placeholder
    // here would silently pair runs from different policies.
    expect(turn.model).toBe('test-model')
    expect(turn.state_features).toBeDefined()

    // The same wiring feeds the dashboard.
    expect(events.some(e => e.type === 'trajectory.turn')).toBe(true)
    globalContract.clear()
  }, 30000)

  it('finalizeTrajectory labels the task at the end of the message', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-traj-cwd-')
    const trajDir = tempDir('cynco-traj-out-')
    initTrajectoryRecorder(trajDir)

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        () => readToolUse(join(cwd, 'nonexistent.txt')),
        () => textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read the file for me please')

    // endTask persists the conversation snapshot alongside the turn log; its
    // presence is what proves finalizeTrajectory ran rather than being skipped.
    const written = readdirSync(trajDir)
    expect(written.some(f => f.endsWith('.json') && !f.endsWith('.jsonl'))).toBe(true)
    globalContract.clear()
  }, 30000)

  /**
   * finalizeTask defaulted its output directory to ~/.cynco/rewards regardless
   * of where the trajectories were going. So this very file — trajectories in a
   * temp dir — wrote a manufactured reward label into the user's live training
   * corpus on every run, a dozen or more per full suite. They were degenerate
   * and so stayed out of the dataset, but the corpus is not a scratch directory
   * and a labeler change could have promoted them at any time.
   */
  it('the reward label follows the trajectories and never touches the real corpus', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-traj-cwd-')
    const trajDir = tempDir('cynco-traj-out-')
    const recorder = initTrajectoryRecorder(trajDir)

    const realCorpus = join(homedir(), '.cynco', 'rewards')
    const before = existsSync(realCorpus) ? readdirSync(realCorpus).length : 0

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        () => readToolUse(join(cwd, 'nonexistent.txt')),
        () => textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    await loop.handleUserMessage('read the file for me please')

    expect(recorder.rewardDir.startsWith(trajDir)).toBe(true)
    const labels = readdirSync(recorder.rewardDir).filter(f => f.endsWith('.reward.json'))
    expect(labels.length).toBe(1)

    const after = existsSync(realCorpus) ? readdirSync(realCorpus).length : 0
    expect(after).toBe(before)
    globalContract.clear()
  }, 30000)

  /**
   * finalizeTrajectory runs from handleUserMessage's finally — which does not
   * run when the process dies mid-task. Every engine restart during a live task
   * therefore left a trajectory on disk with no reward label, and an unlabeled
   * trajectory is invisible to the dataset builder. Across 2026-07-25/26 that
   * was 3 of 10 trajectories lost, mostly to my own restarts.
   *
   * Shutdown closes the open task the same way the end of a message does. The
   * label will usually be degenerate — an interrupted task has no outcome
   * evidence — and that is the correct answer, not a loss.
   */
  it('an interrupted task is labeled at shutdown, and only once', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-traj-cwd-')
    const trajDir = tempDir('cynco-traj-out-')
    const recorder = initTrajectoryRecorder(trajDir)

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([() => textResponse('done')]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    // A task that started and never reached the end of handleUserMessage.
    recorder.startTask('interrupted-task', 'test-model')
    recorder.recordTurn({ toolCalls: [{ name: 'Read', inputHash: 'h', success: true, latencyMs: 1 }] } as any)

    loop.finalizeOpenTask()
    expect(recorder.taskId).toBeNull()

    const labels = readdirSync(recorder.rewardDir).filter(f => f.startsWith('interrupted-task'))
    expect(labels.length).toBe(1)

    // Shutdown may follow a message that already closed its own task.
    loop.finalizeOpenTask()
    expect(readdirSync(recorder.rewardDir).filter(f => f.startsWith('interrupted-task')).length).toBe(1)
    globalContract.clear()
  }, 30000)
})
