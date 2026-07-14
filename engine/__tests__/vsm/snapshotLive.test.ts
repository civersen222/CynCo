import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// @ts-ignore — untyped harness module
import { createMissionCollector } from '../../../scripts/cynco-ledger.mjs'

// ── Gate ─────────────────────────────────────────────────────────────────────
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vsm/snapshotLive.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

// ── Harness helpers (mirror s4Live.test.ts) ──────────────────────────────────

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold (65536) — routing pre-call
    // would otherwise consume the mock provider's scripted responses.
    contextLength: 131072,
    tools: undefined,
    // Deterministic tests: proactive scouts would consume scripted responses
    // before the main loop runs.
    noScouts: true,
    approveAll: true,
  }
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

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return defaultCapabilities()
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      // Crisp failure instead of silent empty stream — script exhaustion must
      // be loud so alignment errors are surfaced immediately.
      if (!gen) throw new Error(`mock provider script exhausted at call ${callIdx}`)
      yield* gen()
    },
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

function* toolCall(i: number, name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: `m${i}`, model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${i}`, name, input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

// ── Gated proving test: after-batch snapshot fires organically ──────────────

describe('snapshot surfacing — loop level (gated: CYNCO_INTEGRATION=1)', () => {
  let tempDir = ''
  let targetFile = ''

  beforeEach(() => {
    // Ablation env var must be absent so CyberneticsGovernance activates.
    delete process.env._ABLATION_VSM_DISABLED
    // Fresh event bus per test — the singleton accumulates otherwise.
    resetEventBus()
    // Reset the global contract singleton: auto-created "pending" assertions
    // can never be satisfied by the mock provider and would block end_turn.
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)

    // The snapshot attaches to THIS temp dir — never the repo root, where
    // initSnapshot would `git add -A` the whole repo into a live
    // .cynco-snapshots/ from real CynCo sessions.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-snapshot-live-'))
    targetFile = path.join(tempDir, 'target.txt')
    fs.writeFileSync(targetFile, 'original content\n')

    // Loud URL-guard fetch stub: default reflection frequency is 8 so a
    // 2-iteration session never reflects, but S2 polls /api/ps and any stray
    // fetch must fail loudly instead of hitting the network.
    vi.stubGlobal('fetch', async (url: any) => {
      const u = String(url)
      if (u.includes('/api/chat')) {
        return new Response(
          JSON.stringify({
            message: { content: 'Progress: 7\nConfidence: 6\nTool Quality: 8\nStuckness: 2' },
          }),
          { status: 200 },
        )
      }
      if (u.includes('/api/ps')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      throw new Error(`snapshotLive fetch stub intercepted unexpected URL: ${u}`)
    })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
    vi.unstubAllGlobals()
  })

  it.skipIf(SKIP)('scripted Write batch fires the after-batch snapshot, lands in the ledger turn record, and undoLastBatch reverts the file', async () => {
    // Dynamically import to avoid blowing up the un-gated suite.
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')

    const filePath = targetFile.replace(/\\/g, '/')
    const events: any[] = []

    // Timeline:
    //   iter 1 (i=0): provider call → toolCall Write → execute (approveAll) →
    //                 after-batch snapshot block fires → snapshot.taken
    //   iter 2 (i=1): provider call → textResponse done → end_turn
    // Spare done-texts follow in case governance nudges add extra model calls.
    const doneText = 'task complete — the new content has been written to the target file as requested; all done.'
    const responses: Array<() => Generator<StreamEvent>> = [
      () => toolCall(1, 'Write', { file_path: filePath, content: 'modified by model\n' }),
      () => textResponse(doneText),
      () => textResponse(doneText),
      () => textResponse(doneText),
    ]

    const provider = mockProvider(responses)

    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider,
      emit: (e) => events.push(e),
      // CRITICAL: the constructor runs initSnapshot(opts.cwd ?? process.cwd())
      // — without this, construction itself would stage the repo root.
      cwd: tempDir,
    })
    // Production re-root path (main.ts user.message handler): executor, LSP,
    // and snapshot all point at the project dir before the message runs.
    loop.setCwd(tempDir)

    // Classifies as file_operation ("write"/"file").
    await loop.handleUserMessage('please write the new content to that file')

    // The loop must not have been halted by the kill switch — if it was, the
    // scripted Write is failing (temp dir setup or approval broken).
    const halted = events.filter((e: any) => e.type === 'message.complete' && e.stopReason === 'halted')
    expect(halted.length).toBe(0)

    // The after-batch snapshot block fired organically with a real git diff.
    const taken = events.filter((e: any) => e.type === 'snapshot.taken')
    expect(taken.length).toBeGreaterThanOrEqual(1)
    expect(taken[0].filesChanged).toBeGreaterThanOrEqual(1)
    expect(taken[0].hash).not.toBe(taken[0].prevHash)

    // The Write actually landed on disk.
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('modified by model\n')

    // And the snapshot lands in a ledger turn record via the real collector.
    const collector = createMissionCollector(() => 1000)
    for (const e of events) collector.ingest(e)
    expect(collector.turns.some((t: any) => t.snapshot && t.snapshot.hash === taken[0].hash)).toBe(true)

    // /undo path: revert the batch, file back to original, restore event out.
    const result = (loop as any).undoLastBatch()
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('original content\n')
    expect(events.some((e: any) => e.type === 'snapshot.restored' && e.hash === taken[0].prevHash)).toBe(true)
  }, 60000)
})
