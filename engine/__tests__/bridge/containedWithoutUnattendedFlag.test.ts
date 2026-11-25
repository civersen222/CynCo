/**
 * F242, entry 6.B1 (b) and directive 1: a mission engine's message that arrives WITHOUT
 * `unattended: true` runs its tools contained exactly like the driver's.
 *
 * The dashboard's chat box sends only `{ text, cwd }` (`conversationLoop.ts`, where the comment says
 * the driver declares the flag and the chat box does not). Containment is decided by the run context
 * the boot block set (`runContainment()`), never by a per-message flag, so a note typed into the
 * dashboard during a mission cannot start a command outside the sandbox. Case 3 pins the other side:
 * with no context, an interactive engine's shell keeps the process's own home.
 *
 * The rig is `operatorNoteWiring.test.ts`'s: the REAL loop against a scripted model. vitest's Node has
 * no `bun:ffi`, so on Windows the test context switches the `lowil` layer off (honoured only because
 * the context is a test context) and the overlay is what is measured here; the low-integrity token is
 * the Bun fixture's (`containmentLauncher.test.ts`).
 */
import { describe, expect, it, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { AUDIT_MARKER } from '../../audit/toolAudit.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { setRunContainment, testContainment, type RunContainment } from '../../containment.js'
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

type Script = { responses: Array<() => Generator<StreamEvent>>; idx: number }

function mockProvider(script: Script, requests: CompletionRequest[]): Provider {
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> {
      requests.push(r)
      const gen = script.responses[script.idx++]
      if (gen) yield* gen()
    },
  }
}

function toolUse(name: string, input: Record<string, unknown>): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name, input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } as any
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

const PRINT = getShellInfo().isPowerShell
  ? 'Write-Output "scratch=$env:CYNCO_SCRATCH home=$env:USERPROFILE"'
  : 'echo "scratch=$CYNCO_SCRATCH home=$HOME"'

function harness(cwd: string) {
  writeFileSync(join(cwd, 'seat.py'), 'VERSION = "v0"\n')
  // A contract exists so the loop does not auto-create one; enforcement is off so the scripted model
  // is not nudged once it has nothing left to say. Neither is what this file measures.
  globalContract.clear()
  globalContract.create('mission', '', ['File seat.py exists after changes'], 'harness')
  globalContract.setEnforcementEnabled(false)
  const events: EngineEvent[] = []
  const requests: CompletionRequest[] = []
  const script: Script = { responses: [toolUse('Bash', { command: PRINT }), textResponse('done')], idx: 0 }
  const loop = new ConversationLoop({
    cwd,
    config: config(),
    provider: mockProvider(script, requests),
    emit: (e: EngineEvent) => { events.push(e) },
    allowedTools: ['Bash', 'Read'],
  })
  return { loop, requests }
}

/** The text of the first tool_result block the model was sent back. */
function toolResultText(req: CompletionRequest | undefined): string {
  for (const m of (req as any)?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_result') continue
      if (typeof b.content === 'string') return b.content
      if (Array.isArray(b.content)) return b.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
    }
  }
  throw new Error('no tool_result in the request')
}

const fold = (s: string) => {
  const t = s.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? t.toLowerCase() : t
}
const valueOf = (out: string, key: 'scratch' | 'home') => {
  const m = new RegExp(`${key}=(\\S*)`).exec(out)
  return m ? m[1] : null
}

describe('a mission engine runs a message contained whatever its unattended flag says', () => {
  let ctx: RunContainment
  let mission: string
  let audit: string
  const switchBefore = process.env.LOCALCODE_CONTAINMENT_OFF

  beforeEach(() => {
    const root = tempDir('cynco-contained-flag-')
    mission = join(root, 'mission')
    const sb = join(root, 'sandbox', 'run')
    const sandbox = { root: sb, home: join(sb, 'home'), tmp: join(sb, 'tmp'), scratch: join(sb, 'scratch') }
    for (const d of [mission, sandbox.home, sandbox.tmp, sandbox.scratch]) mkdirSync(d, { recursive: true })
    // S5: the context names a marked audit folder of this test's own, so its tool calls are recorded.
    audit = join(root, 'audit')
    const folders = { state: join(root, 'state'), models: join(root, 'models'), guard: join(root, 'guard'), audit }
    for (const d of [join(root, 'fakehome'), folders.state, folders.models, folders.guard, audit]) mkdirSync(d, { recursive: true })
    writeFileSync(join(audit, AUDIT_MARKER), '')
    ctx = testContainment({ missionCwd: mission, sandbox, home: join(root, 'fakehome'), folders })
    setRunContainment(ctx)
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
  })

  afterEach(() => {
    setRunContainment(null)
    if (switchBefore === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
    else process.env.LOCALCODE_CONTAINMENT_OFF = switchBefore
  })

  it('a message without the unattended flag still runs its tools contained', async () => {
    const { loop, requests } = harness(mission)
    await loop.handleUserMessage('print it')
    const out = toolResultText(requests[1])
    expect(fold(valueOf(out, 'scratch') ?? ''), out).toBe(fold(ctx.sandbox.scratch))
    expect(fold(valueOf(out, 'home') ?? ''), out).toBe(fold(ctx.sandbox.home))
    // ...and its tool call is audited (S5): the start with the full input, then the end.
    const recs = readdirSync(audit).filter(n => n.endsWith('.jsonl'))
      .flatMap(n => readFileSync(join(audit, n), 'utf-8').split('\n').filter(l => l !== '').map(l => JSON.parse(l)))
    const start = recs.find(r => r.kind === 'start')
    expect(start).toMatchObject({ src: 'tool', tool: 'Bash', input: { command: PRINT }, run: ctx.runId })
    expect(recs.find(r => r.kind === 'end' && r.call === start.seq)).toMatchObject({ isError: false, exitCode: 0 })
  }, 30000)

  it('the same message with the flag behaves the same', async () => {
    const { loop, requests } = harness(mission)
    await loop.handleUserMessage('print it', { unattended: true })
    const out = toolResultText(requests[1])
    expect(fold(valueOf(out, 'scratch') ?? ''), out).toBe(fold(ctx.sandbox.scratch))
    expect(fold(valueOf(out, 'home') ?? ''), out).toBe(fold(ctx.sandbox.home))
  }, 30000)

  it('with no context the tool shell keeps the process\'s own home', async () => {
    setRunContainment(null)
    const { loop, requests } = harness(mission)
    await loop.handleUserMessage('print it')
    const out = toolResultText(requests[1])
    const own = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
    expect(fold(valueOf(out, 'home') ?? ''), out).toBe(fold(own ?? ''))
    expect(valueOf(out, 'scratch'), out).toBe('')
  }, 30000)
})
