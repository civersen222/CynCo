/**
 * Phase 4: S5's authority is earned per rule, and the loop is where it bites.
 *
 * `LOCALCODE_S5_ENFORCE` is all-or-nothing. With a verdict file on disk the
 * loop asks, per decision, whether every rule behind it is PREDICTIVE — and a
 * decision that is only `advisory` must be emitted as `enforced: false` and
 * must NOT be applied, even with enforcement on. With no verdict file the loop
 * behaves exactly as it did before (legacy).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import { ruleVerdictsPath } from '../../s5/ruleAuthority.js'
import type { S5Decision, S5Interface } from '../../s5/types.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

function* silence(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'end', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'message_stop' } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } as any
}

function provider(): Provider {
  const caps: ModelCapabilities = { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { return caps },
    async complete() { throw new Error('not implemented') },
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> { yield* silence() },
  }
}

/** An S5 that always switches the model, on the rules it is given. */
const switchesModel = (ruleIds: string[]): S5Interface => ({
  name: 'fixed',
  decide: async (): Promise<S5Decision> => ({ workflow: null, advancePhase: null, model: 'switched-model', tools: null, contextAction: 'none', spawnAgent: null, priority: 'balanced', reasoning: 'switch', ruleIds }),
})

describe('per-rule S5 authority in the conversation loop', () => {
  let home: string
  let cwd: string
  const prior = { home: process.env.CYNCO_HOME, enforce: process.env.LOCALCODE_S5_ENFORCE }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-authority-home-'))
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-authority-cwd-'))
    process.env.CYNCO_HOME = home
    process.env.LOCALCODE_S5_ENFORCE = 'true'
  })
  afterEach(() => {
    process.env.CYNCO_HOME = prior.home
    if (prior.enforce === undefined) delete process.env.LOCALCODE_S5_ENFORCE
    else process.env.LOCALCODE_S5_ENFORCE = prior.enforce
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
    // The loop keeps handles open under CYNCO_HOME (governance db, journals)
    // for the life of the process, and ConversationLoop has no close(); on
    // Windows that makes the directory EPERM until exit. Removed when it can
    // be, and said so when it cannot — the OS temp dir reclaims it.
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
    catch (e) { console.warn(`[test] could not remove ${home} while the loop holds it open: ${(e as Error).message}`) }
    vi.restoreAllMocks()
  })

  const writeVerdicts = (rules: Record<string, string>) => {
    const p = ruleVerdictsPath(home)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ schema: 1, version: 1, rules: Object.fromEntries(Object.entries(rules).map(([id, verdict]) => [id, { verdict }])), predictive: [], history: [] }))
  }

  async function run(ruleIds: string[]) {
    const frames: any[] = []
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    const loop = new ConversationLoop({
      cwd,
      config: { baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto', temperature: 0.7, maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, noScouts: true, approveAll: true } as LocalCodeConfig,
      provider: provider(),
      emit: (e: any) => frames.push(e),
      s5: new S5Orchestrator(switchesModel(ruleIds)),
    })
    await loop.handleUserMessage('hello')
    return { frames, logs, model: (loop as any).config.model as string, decision: frames.find(f => f.type === 's5.decision') }
  }

  it('an advisory decision is emitted enforced:false with its authority, and is NOT applied', async () => {
    writeVerdicts({ C7: 'PREDICTIVE', W1: 'NO EVIDENCE' })
    const r = await run(['C7', 'W1'])
    expect(r.decision).toMatchObject({ enforced: false, authority: 'advisory', ruleIds: ['C7', 'W1'] })
    expect(r.model).toBe('test')
    expect(r.logs.filter(l => l.startsWith('[s5] rule authority:'))).toEqual(['[s5] rule authority: earned (1 predictive of 2)'])
    expect(r.logs.some(l => /WOULD-ENFORCE \(advisory — rule authority not earned\): model switch to switched-model/.test(l))).toBe(true)
    // The warning-tier recommendation carries the authority and no auto-apply timer.
    const rec = r.frames.find(f => f.type === 'governance.recommendation')
    expect(rec).toMatchObject({ signal: 'W1', authority: 'advisory' })
    expect(rec.autoApplyAfterMs).toBeUndefined()
  })

  it('a legacy warning-tier recommendation keeps its 60 s auto-apply timer', async () => {
    const r = await run(['W1'])
    expect(r.frames.find(f => f.type === 'governance.recommendation')).toMatchObject({ authority: 'legacy', autoApplyAfterMs: 60000 })
  })

  it('an earned decision is enforced and applied', async () => {
    writeVerdicts({ C7: 'PREDICTIVE', W1: 'NO EVIDENCE' })
    const r = await run(['C7'])
    expect(r.decision).toMatchObject({ enforced: true, authority: 'earned' })
    expect(r.model).toBe('switched-model')
  })

  it('no verdict file: legacy — enforcement follows LOCALCODE_S5_ENFORCE exactly as before', async () => {
    const r = await run(['W1'])
    expect(r.decision).toMatchObject({ enforced: true, authority: 'legacy' })
    expect(r.model).toBe('switched-model')
    expect(r.logs.filter(l => l.startsWith('[s5] rule authority:'))).toEqual([`[s5] rule authority: legacy (no verdict file at ${ruleVerdictsPath(home)})`])
  })

  it('earned authority never overrides the global cap', async () => {
    writeVerdicts({ C7: 'PREDICTIVE' })
    process.env.LOCALCODE_S5_ENFORCE = 'false'
    const r = await run(['C7'])
    expect(r.decision).toMatchObject({ enforced: false, authority: 'earned' })
    expect(r.model).toBe('test')
  })
})
