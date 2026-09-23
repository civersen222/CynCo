/**
 * Proof that verify-first routing is on a live path.
 *
 * `VerifyFirstRouter` is a pure object, and a pure object nothing constructs
 * passes its own unit tests forever — the same failure `missionInvariantsWiring`
 * exists to prevent, one verb later. The claim being pinned here is specific:
 * the REAL gate ladder in the REAL ConversationLoop runs the mission's
 * KEEP-GREEN command before it refuses a revert and after a low-confidence
 * source edit, the refusal is still a refusal, and the routing record reaches
 * the wire on `governance.status`.
 *
 * So these tests run the real loop against a mock provider, with a real
 * `globalContract` carrying a real keep-green assertion whose command is a
 * `node` script the test writes — exiting 0 or 3 as the case requires. Nothing
 * about the verdict is faked; the only stub is the model.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent, TokenLogprob } from '../../types.js'
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

const INVARIANTS = { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: false }

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
 * Tool-token logprobs the real `observeUncertainty('tool', …)` path digests.
 *
 * `calm` tokens are near-certain and each slightly MORE certain than the last,
 * so the final token — the one `lastToolEntropy` keeps — sits below the turn's
 * own mean and cannot trip a relative rule by floating-point accident.
 * `spike` is a flat distribution over eight alternatives: H = ln 8 ≈ 2.079 nats.
 */
function calmTokens(n: number): TokenLogprob[] {
  return Array.from({ length: n }, (_, i) => ({
    token: 't', logprob: -0.0001,
    top: [{ token: 't', logprob: -0.0001 }, { token: 'u', logprob: -(10 + i) }],
  }))
}
function spikeToken(): TokenLogprob {
  const top = Array.from({ length: 8 }, (_, k) => ({ token: `a${k}`, logprob: -Math.log(8) }))
  return { token: 'a0', logprob: -Math.log(8), top }
}

type Block = { name: string; input: Record<string, unknown>; logprobs?: TokenLogprob[] }

/** One assistant message carrying `blocks` tool calls, in order. */
function toolUse(...blocks: Block[]): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const delta: Record<string, unknown> = { type: 'input_json_delta', partial_json: JSON.stringify(b.input) }
      if (b.logprobs) delta.logprobs = b.logprobs
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: b.name, input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta } as any
      yield { type: 'content_block_stop', index: i } as any
    }
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

const GREEN_SCRIPT = "console.log('suite ok: 12 passed')\n"
const RED_SCRIPT = "console.log('FAILED tests/test_seat.py::test_hold')\nprocess.exit(3)\n"

/**
 * A workspace with a real KEEP-GREEN command and a real keep-green assertion.
 *
 * The contract is seeded directly rather than through `opts.contract` because
 * the harness contract path also pins read-only instrument paths and starts
 * enforcement rounds; neither is what this file is about. Enforcement is turned
 * off for the same reason — an incomplete contract would otherwise spend five
 * extra model iterations nudging a mock provider that has nothing left to say.
 */
function harness(prefix: string, script: string, responses: Array<() => Generator<StreamEvent>>) {
  const cwd = tempDir(prefix)
  writeFileSync(join(cwd, 'keep-green.js'), script)
  writeFileSync(join(cwd, 'seat.py'), 'VERSION = "v0"\n')
  globalContract.clear()
  globalContract.create(
    'mission',
    '',
    [{ text: 'KEEP-GREEN: the suite that was green stays green', command: 'node keep-green.js', role: 'keep-green' }],
    'harness',
  )
  globalContract.setEnforcementEnabled(false)
  const events: EngineEvent[] = []
  const loop = new ConversationLoop({
    cwd,
    config: config(),
    provider: mockProvider(responses),
    emit: (e: EngineEvent) => { events.push(e) },
    allowedTools: ['Bash', 'Read', 'Edit'],
  })
  return { cwd, loop, events }
}

function lastStatus(events: EngineEvent[]): any {
  return events.filter(e => e.type === 'governance.status').at(-1)
}
function completions(events: EngineEvent[]): any[] {
  return events.filter(e => e.type === 'tool.complete') as any[]
}

const revert = (n: number): Block => ({ name: 'Bash', input: { command: `git checkout -- a${n}.py` } })
const edit = (from: string, to: string, logprobs?: TokenLogprob[]): Block => ({
  name: 'Edit',
  input: { file_path: 'seat.py', old_string: `VERSION = "${from}"`, new_string: `VERSION = "${to}"` },
  logprobs,
})

describe('verify-first wiring — informed revert refusal', () => {
  it('refuses the revert AND reports KEEP-GREEN red with the command output', async () => {
    const { loop, events } = harness('cynco-vf-red-', RED_SCRIPT, [
      toolUse(revert(1)),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    const done = completions(events)
    expect(done).toHaveLength(1)
    // Still refused. Routing never grants a call a denial would have refused.
    expect(done[0].isError).toBe(true)
    expect(String(done[0].result)).toContain('[invariant] REFUSED')
    expect(String(done[0].result)).toContain('[verify-first] KEEP-GREEN is red as the tree stands')
    expect(String(done[0].result)).toContain('FAILED tests/test_seat.py::test_hold')
    globalContract.clear()
  }, 30000)

  it('refuses the revert AND reports KEEP-GREEN green — nothing to undo, commit instead', async () => {
    const { loop, events } = harness('cynco-vf-green-', GREEN_SCRIPT, [
      toolUse(revert(1)),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    const done = completions(events)
    expect(done).toHaveLength(1)
    expect(done[0].isError).toBe(true)
    expect(String(done[0].result)).toContain('[invariant] REFUSED')
    expect(String(done[0].result)).toContain('[verify-first] KEEP-GREEN is green as the tree stands')
    expect(String(done[0].result)).toContain('commit instead')

    const status = lastStatus(events)
    expect(status.routing, 'no routing block on governance.status').toBeTruthy()
    expect(status.routing.count).toBe(1)
    expect(status.routing.used).toBe(1)
    expect(status.routing.byKind.revert).toBe(1)
    expect(status.routing.byOutcome.passed).toBe(1)
    expect(status.routing.entries[0].kind).toBe('revert')
    globalContract.clear()
  }, 30000)

  it('falls back to the plain refusal once the budget is spent', async () => {
    // Six reverts each spend one KEEP-GREEN run; the Edit between each pair
    // invalidates the cache, so no revert is served a stale verdict. The
    // seventh has nothing left to spend.
    const versions = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6']
    const blocks: Block[] = []
    for (let i = 0; i < 6; i++) {
      blocks.push(revert(i + 1))
      blocks.push(edit(versions[i], versions[i + 1]))
    }
    blocks.push(revert(7))
    const { loop, events } = harness('cynco-vf-budget-', GREEN_SCRIPT, [
      toolUse(...blocks),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    const done = completions(events)
    expect(done).toHaveLength(13)
    const lastRefusal = String(done[12].result)
    expect(lastRefusal).toContain('[invariant] REFUSED')
    expect(lastRefusal, 'budget-exhausted must fall back to the plain refusal').not.toContain('[verify-first]')

    const status = lastStatus(events)
    expect(status.routing.used).toBe(6)
    expect(status.routing.budget).toBe(6)
    expect(status.routing.count).toBe(7)
    expect(status.routing.byOutcome['budget-exhausted']).toBe(1)
    // The entry's outcome record: the next call after the refused revert.
    expect(status.routing.entries[0].nextCallClass).toBe('sourceEdit')
    globalContract.clear()
  }, 60000)
})

describe('verify-first wiring — measured low-confidence edit', () => {
  it('appends the KEEP-GREEN verdict to an edit the model was uncertain about', async () => {
    const { loop, events } = harness('cynco-vf-lowconf-', GREEN_SCRIPT, [
      toolUse(edit('v0', 'v1', [...calmTokens(9), spikeToken()])),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    const done = completions(events)
    expect(done).toHaveLength(1)
    expect(done[0].isError).toBe(false)
    expect(String(done[0].result)).toContain('[verify-first] KEEP-GREEN after this edit: PASS')

    const status = lastStatus(events)
    expect(status.routing.count).toBe(1)
    expect(status.routing.byKind['low-confidence-edit']).toBe(1)
    expect(status.routing.entries[0].entropy).toBeGreaterThan(1.0)
    globalContract.clear()
  }, 30000)

  it('reports a red KEEP-GREEN after the edit with the output tail', async () => {
    const { loop, events } = harness('cynco-vf-lowconf-red-', RED_SCRIPT, [
      toolUse(edit('v0', 'v1', [...calmTokens(9), spikeToken()])),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    const done = completions(events)
    expect(String(done[0].result)).toContain('[verify-first] KEEP-GREEN after this edit: FAIL')
    expect(String(done[0].result)).toContain('FAILED tests/test_seat.py::test_hold')
    // The edit itself succeeded — the verdict is information, not a refusal.
    expect(done[0].isError).toBe(false)
    globalContract.clear()
  }, 30000)

  it('leaves a calm edit alone', async () => {
    const { loop, events } = harness('cynco-vf-calm-', GREEN_SCRIPT, [
      toolUse(edit('v0', 'v1', calmTokens(10))),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    const done = completions(events)
    expect(done).toHaveLength(1)
    expect(String(done[0].result)).not.toContain('[verify-first]')
    expect(lastStatus(events).routing.count).toBe(0)
    globalContract.clear()
  }, 30000)
})

describe('verify-first wiring — when the router must not exist', () => {
  it('an interactive session never routes', async () => {
    const { loop, events } = harness('cynco-vf-interactive-', RED_SCRIPT, [
      toolUse(revert(1)),
      textResponse('done'),
    ])
    await loop.handleUserMessage('do the thing', {})

    expect((loop as any).verifyFirst).toBeNull()
    const done = completions(events)
    expect(String(done[0]?.result ?? '')).not.toContain('[verify-first]')
    expect(lastStatus(events).routing ?? null).toBeNull()
    globalContract.clear()
  }, 30000)

  it('an unattended mission with no keep-green assertion never routes', async () => {
    const { loop, events } = harness('cynco-vf-nogate-', RED_SCRIPT, [
      toolUse(revert(1)),
      textResponse('done'),
    ])
    // Same mission, same invariants — but the contract carries no keep-green.
    globalContract.clear()
    globalContract.create('mission', '', ['File seat.py exists after changes'], 'harness')
    globalContract.setEnforcementEnabled(false)
    await loop.handleUserMessage('do the thing', { unattended: true, invariants: INVARIANTS })

    expect((loop as any).verifyFirst).toBeNull()
    const done = completions(events)
    expect(String(done[0].result)).toContain('[invariant] REFUSED')
    expect(String(done[0].result)).not.toContain('[verify-first]')
    expect(lastStatus(events).routing ?? null).toBeNull()
    globalContract.clear()
  }, 30000)
})
