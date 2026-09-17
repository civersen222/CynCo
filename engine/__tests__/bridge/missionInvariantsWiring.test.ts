/**
 * Proof that mission invariants are on a live path.
 *
 * `MissionInvariants` is a pure class, and a pure class nothing constructs
 * passes all of its own unit tests forever. That is the specific failure this
 * file guards. C8 wave 1 spent its last tool call on `git checkout --`; the
 * brief had said in prose that reverting was forbidden. A sentence has no
 * regulatory variety against a command (Ashby) — so the refusal has to come out
 * of the real gate ladder in the real ConversationLoop, and the state it
 * accumulates has to reach the wire on `governance.status`, or the outcome
 * ledger cannot tell a run that never reverted from a run whose regulator was
 * never built.
 *
 * So these tests run the real loop against a mock provider and assert on the
 * events the real `executeOneTool` and the real status emit produce.
 */
import { describe, expect, it, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { codeIndexAdoptionHint, resetCodeIndexNudgeState } from '../../tools/toolHints.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { EngineEvent } from '../../bridge/protocol.js'
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

/**
 * CodeIndex-first calls the real tool through a dynamic import. Stubbed here so
 * the assertion is about the WIRING — does the loop prepend the card and count
 * the adoption — and not about whether a vector index happened to build inside
 * a freshly-made temp directory.
 */
const ciStub = vi.hoisted(() => ({ output: null as string | null }))
vi.mock('../../tools/impl/codeIndex.js', () => ({
  codeIndexTool: {
    name: 'CodeIndex',
    execute: async (input: Record<string, unknown>) => ({
      output: ciStub.output ?? `STUB CARD for ${String(input.query)} (top_k=${String(input.top_k)})`,
      isError: false,
    }),
  },
}))

/** One assistant message carrying a single Grep call. */
function grepToolUse(pattern: string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name: 'Grep', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ pattern }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/**
 * One assistant message carrying a single Read call. The path is resolved when
 * the generator runs, so a test can name a file inside the harness's own cwd.
 */
function readToolUse(filePath: () => string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: filePath() }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/** One assistant message carrying a single Bash call. */
function bashToolUse(command: string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name: 'Bash', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/** One assistant message whose tool arguments are not JSON and cannot be repaired. */
function malformedToolUse(name: string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu2', name, input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'this is not json at all <<<' } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function textResponse(text: string): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function harness(prefix: string, responses: Array<() => Generator<StreamEvent>>) {
  const cwd = tempDir(prefix)
  const events: EngineEvent[] = []
  const loop = new ConversationLoop({
    cwd,
    config: config(),
    provider: mockProvider(responses),
    emit: (e: EngineEvent) => { events.push(e) },
    allowedTools: ['Bash', 'Read', 'Grep'],
  })
  return { cwd, loop, events }
}

/** The last per-iteration governance.status frame of the run. */
function lastStatus(events: EngineEvent[]): any {
  return events.filter(e => e.type === 'governance.status').at(-1)
}

describe('mission invariants wiring', () => {
  it('an unattended message with invariants refuses git checkout -- and reports invariants on governance.status', async () => {
    globalContract.clear()
    const { loop, events } = harness('cynco-inv-armed-', [
      bashToolUse('git checkout -- a.py'),
      textResponse('done'),
    ])

    await loop.handleUserMessage('do the thing', {
      unattended: true,
      invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
    })

    const complete = events.filter(e => e.type === 'tool.complete') as any[]
    expect(complete.length).toBeGreaterThan(0)
    expect(complete[0].isError).toBe(true)
    expect(String(complete[0].result)).toContain('[invariant] REFUSED')

    const status = lastStatus(events)
    expect(status, 'no governance.status frame was emitted').toBeTruthy()
    expect(status.invariants.revertRefusals).toBe(1)
    expect(status.invariants.denials[0].invariant).toBe('revert')
    globalContract.clear()
  }, 30000)

  it('prepends the CodeIndex card to an identifier-shaped Grep and counts the adoption', async () => {
    globalContract.clear()
    const { loop, events } = harness('cynco-inv-codeindex-', [
      grepToolUse('hold_seat_for_player'),
      textResponse('done'),
    ])

    await loop.handleUserMessage('find it', {
      unattended: true,
      invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
    })

    const complete = events.filter(e => e.type === 'tool.complete') as any[]
    expect(complete.length).toBe(1)
    // Prepended, not substituted: the model still gets everything Grep found.
    expect(String(complete[0].result)).toContain('[CodeIndex top-3 for "hold_seat_for_player"]')
    expect(String(complete[0].result)).toContain('STUB CARD for hold_seat_for_player (top_k=3)')
    expect(lastStatus(events).invariants.codeIndexAssisted).toBe(1)
    globalContract.clear()
  }, 30000)

  /**
   * `codeIndexTool.execute` never sets `isError`. When the vector search comes
   * back empty it answers with its OWN regex grep, and `codeIndexAssisted`
   * counting that would make the adoption metric a count of identifier-shaped
   * Greps — the number the ledger already has — while prepending a second copy
   * of the grep the model is about to read.
   */
  it('does not count (or prepend) a regex-fallback answer as index adoption', async () => {
    globalContract.clear()
    ciStub.output = '[regex fallback]\ngilded/ui/app.py:12: def hold_seat_for_player(...)'
    try {
      const { loop, events } = harness('cynco-inv-fallback-', [
        grepToolUse('hold_seat_for_player'),
        textResponse('done'),
      ])

      await loop.handleUserMessage('find it', {
        unattended: true,
        invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
      })

      const complete = events.filter(e => e.type === 'tool.complete') as any[]
      expect(complete.length).toBe(1)
      expect(String(complete[0].result)).not.toContain('[CodeIndex top-3 for')
      expect(String(complete[0].result)).not.toContain('[regex fallback]')
      expect(lastStatus(events).invariants.codeIndexAssisted).toBe(0)
    } finally {
      ciStub.output = null
      globalContract.clear()
    }
  }, 30000)

  /**
   * The two adoption counters must agree. `codeIndexAdoptionHint` nudges every
   * 15th retrieval call with "N calls since your last CodeIndex query"; the
   * CodeIndex-first prepend queries the index ON the model's behalf during a
   * Grep. Without `noteCodeIndexUse` the model gets lectured for skipping an
   * index that just answered its Grep — while `invariants.codeIndexAssisted`
   * says it used it.
   */
  it('a CodeIndex-first prepend clears the crawl nudge counter', async () => {
    globalContract.clear()
    resetCodeIndexNudgeState()
    // 13 crawl calls. The Grep below is #14, and the Read after it would be the
    // #15 that trips the crawl nudge — unless the prepend reset the counter.
    for (let i = 0; i < 13; i++) codeIndexAdoptionHint('Read', {}, 'contents', false)

    // The generators are not run until handleUserMessage below, so the path can
    // be filled in after the harness has made the temp directory.
    const notePath = { value: '' }
    const { cwd, loop, events } = harness('cynco-inv-crawlreset-', [
      grepToolUse('hold_seat_for_player'),
      readToolUse(() => notePath.value),
      textResponse('done'),
    ])
    notePath.value = join(cwd, 'note.txt')
    writeFileSync(notePath.value, 'a note\n')

    await loop.handleUserMessage('find it, then read the note', {
      unattended: true,
      invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
    })

    const complete = events.filter(e => e.type === 'tool.complete') as any[]
    expect(complete.length).toBe(2)
    expect(String(complete[0].result)).toContain('[CodeIndex top-3 for "hold_seat_for_player"]')
    expect(String(complete[1].result)).not.toContain('calls since your last CodeIndex query')
    expect(lastStatus(events).invariants.codeIndexAssisted).toBe(1)
    globalContract.clear()
    resetCodeIndexNudgeState()
  }, 30000)

  /**
   * The malformed-arguments repair ladder returns before the tool runs. It
   * still counts against the commit-pressure clock, so it must count against
   * the invariants' clocks too — two clocks measuring the same run must not
   * drift apart because one of them skipped an early return.
   */
  it('counts a malformed tool call against the invariant clocks', async () => {
    globalContract.clear()
    const { loop, events } = harness('cynco-inv-malformed-', [
      malformedToolUse('Bash'),
      textResponse('done'),
    ])

    await loop.handleUserMessage('do the thing', {
      unattended: true,
      invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
    })

    const complete = events.filter(e => e.type === 'tool.complete') as any[]
    expect(complete.length).toBe(1)
    expect(complete[0].isError).toBe(true)
    expect(String(complete[0].result)).toContain('not valid JSON')
    const status = lastStatus(events)
    expect(status.invariants.callsSinceSourceEdit).toBeGreaterThanOrEqual(1)
    expect(status.invariants.callsSinceCommit).toBeGreaterThanOrEqual(1)
    globalContract.clear()
  }, 30000)

  /**
   * A typo in CYNCO_MISSION_INVARIANTS used to buy an ungoverned mission whose
   * only report was a console line — in the one run mode defined by nobody
   * watching the console. The ledger row was indistinguishable from a mission
   * dispatched without caps at all.
   */
  it('a rejected invariants block raises a governance alert and marks the status frame', async () => {
    globalContract.clear()
    const { loop, events } = harness('cynco-inv-rejected-', [
      textResponse('done'),
    ])

    await loop.handleUserMessage('do the thing', {
      unattended: true,
      invariants: { editGapCap: 'x' } as any,
    })

    const alerts = events.filter(e => e.type === 'governance.alert') as any[]
    expect(alerts.some(a =>
      String(a.message) === '[invariant] invariants block malformed — this unattended run has NO mission invariants'
      && a.source === 'mission-invariants'
      // `warn`, not `critical`: the daemon's one-shot path halts on `critical`
      // and a rejected invariants block must not halt an ideation run.
      && a.severity === 'warn',
    ), `no malformed-invariants alert; saw ${JSON.stringify(alerts.map(a => a.message))}`).toBe(true)

    const status = lastStatus(events)
    expect(status, 'no governance.status frame was emitted').toBeTruthy()
    expect(status.invariants ?? null).toBeNull()
    expect(status.invariantsRejected).toBe(true)
    globalContract.clear()
  }, 30000)

  it('an interactive message never constructs invariants', async () => {
    globalContract.clear()
    const { loop, events } = harness('cynco-inv-interactive-', [
      bashToolUse('git checkout -- a.py'),
      textResponse('done'),
    ])

    await loop.handleUserMessage('do the thing', {})

    const status = lastStatus(events)
    expect(status, 'no governance.status frame was emitted').toBeTruthy()
    expect(status.invariants ?? null).toBeNull()
    expect((loop as any).missionInvariants).toBeNull()
    globalContract.clear()
  }, 30000)
})
