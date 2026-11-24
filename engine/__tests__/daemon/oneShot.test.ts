// engine/__tests__/daemon/oneShot.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractOutcome, buildOneShotPrompt, buildResumePrompt, makeHaltCapture, runOneShotTask, runGovernedLoop, countAssistantTurns } from '../../daemon/oneShot.js'
import { MISSION_FIXED_RULE, MISSION_FIXED_RULE_SHORT, scratchSentence } from '../../missionRule.js'
import { setRunContainment, testContainment } from '../../containment.js'
import type { Message } from '../../types.js'
import type { Provider, CompletionRequest, ModelCapabilities } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { TaskFileInput } from '../../daemon/types.js'

// runOneShotTask drives a real ConversationLoop (filesystem, JSONL sessions,
// index DBs) under the suite's temporary home; it needs no live service and
// runs in the ordinary suite (ungated 2026-11-17).

describe('extractOutcome', () => {
  it('parses the last fenced json block', () => {
    const text = [
      'thinking...',
      '```json', '{"summary": "draft", "recommendations": []}', '```',
      'more...',
      '```json',
      JSON.stringify({ summary: 'final', recommendations: [{ actionType: 'waiver', summary: 'Claim X', detail: 'why' }] }),
      '```',
    ].join('\n')
    const outcome = extractOutcome(text)
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toBe('final')
    expect(outcome.recommendations.length).toBe(1)
  })

  it('assigns ids to recommendations missing one', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations[0].id).toMatch(/^rec-/)
  })

  it('falls back to text tail when no json block parses', () => {
    const outcome = extractOutcome('I looked at the roster. Nothing to do this week.')
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toContain('Nothing to do')
    expect(outcome.recommendations).toEqual([])
  })

  it('flags unstructured fallback output so digests show the contract miss', () => {
    const outcome = extractOutcome('free text, no json block')
    expect(outcome.summary).toMatch(/^\(unstructured output\)/)
  })

  it('fallback strips think blocks and tool_call fragments before tailing', () => {
    // Real failure mode (2026-06-12 morning-brief): model got stuck, emitted
    // reasoning + a malformed <tool_call> instead of the outcome JSON, and the
    // raw tail shipped to the phone as the digest.
    const text = [
      '<think>let me reason about the roster here</think>',
      'I am stuck calling Mfl "players" which returns the full database.',
      '<tool_call>',
      '{',
      '{',
      '  "name": "Mfl",',
      '  "arguments": { "league": "65042", "query": "players" }',
      '}',
    ].join('\n')
    const outcome = extractOutcome(text)
    expect(outcome.summary).toMatch(/^\(unstructured output\)/)
    expect(outcome.summary).toContain('stuck calling Mfl')
    expect(outcome.summary).not.toContain('<think>')
    expect(outcome.summary).not.toContain('let me reason')
    expect(outcome.summary).not.toContain('<tool_call>')
    expect(outcome.summary).not.toContain('"arguments"')
  })

  it('ignores model-supplied recommendation ids and always generates fresh ones', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"id": "__proto__", "actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations[0].id).toMatch(/^rec-[0-9a-f]{8}$/)
  })

  it('drops malformed recommendation entries', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"bogus": true}, {"actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations.length).toBe(1)
    expect(outcome.recommendations[0].actionType).toBe('waiver')
  })
})

describe('countAssistantTurns', () => {
  const msg = (role: 'user' | 'assistant', content: any[]): Message => ({ role, content } as Message)

  it('counts assistant messages that said or did something', () => {
    expect(countAssistantTurns([
      msg('user', [{ type: 'text', text: 'go' }]),
      msg('assistant', [{ type: 'text', text: 'looking' }]),
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    ])).toBe(2)
  })

  it('is zero for a run where the model never produced anything', () => {
    expect(countAssistantTurns([])).toBe(0)
    expect(countAssistantTurns([msg('user', [{ type: 'text', text: 'go' }])])).toBe(0)
  })

  it('does not count an empty or whitespace-only assistant message as a turn', () => {
    expect(countAssistantTurns([
      msg('assistant', []),
      msg('assistant', [{ type: 'text', text: '   ' }]),
    ])).toBe(0)
  })
})

describe('makeHaltCapture', () => {
  it('captures a halted message.complete', () => {
    const cap = makeHaltCapture()
    cap.emit({ type: 'stream.token', text: 'hi' })
    expect(cap.haltReason()).toBeNull()
    cap.emit({ type: 'message.complete', messageId: '', stopReason: 'halted' })
    expect(cap.haltReason()).toBe('algedonic kill switch halted the loop')
  })

  it('prefers the critical governance.alert message as the reason', () => {
    const cap = makeHaltCapture()
    cap.emit({ type: 'governance.alert', severity: 'critical', message: '5 consecutive failures — system halted for safety', source: 'algedonic' })
    cap.emit({ type: 'message.complete', messageId: '', stopReason: 'halted' })
    expect(cap.haltReason()).toBe('5 consecutive failures — system halted for safety')
  })

  it('records a swallowed engine error so the run is not reported ok (2026-10-28: a killed model server ended a run as "(unstructured output)" ok:true)', () => {
    const cap = makeHaltCapture()
    expect(cap.endedEarly()).toBeNull()
    cap.emit({ type: 'session.error', error: 'fetch failed: ECONNRESET' } as any)
    expect(cap.endedEarly()).toMatch(/engine error.*ECONNRESET/i)
    expect(cap.haltReason()).toBeNull()
  })

  it('records hitting the iteration limit (also where the stuck-15 halt lands)', () => {
    const cap = makeHaltCapture()
    cap.emit({ type: 'message.complete', messageId: '', stopReason: 'max_iterations' })
    expect(cap.endedEarly()).toMatch(/iteration limit/i)
  })

  it('a normal end_turn is not an early end', () => {
    const cap = makeHaltCapture()
    cap.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' })
    expect(cap.endedEarly()).toBeNull()
  })

  it('a critical alert without a halt is not a halt', () => {
    const cap = makeHaltCapture()
    cap.emit({ type: 'governance.alert', severity: 'critical', message: 'model error', source: 'algedonic' })
    expect(cap.haltReason()).toBeNull()
  })
})

describe('buildOneShotPrompt', () => {
  it('includes the outcome format contract, mission context, and task prompt', () => {
    const p = buildOneShotPrompt('goal: win the league', 'Review the waiver wire')
    expect(p).toContain('goal: win the league')
    expect(p).toContain('Review the waiver wire')
    expect(p).toContain('```json')
    expect(p).toContain('recommendations')
  })

  // F242: every one-shot prompt carries the fixed rule; a resumed run gets the short form.
  it('carries the fixed rule, and the resume prompt its short form', () => {
    expect(buildOneShotPrompt('goal: win the league', 'Review the waiver wire')).toContain(MISSION_FIXED_RULE)
    expect(buildResumePrompt()).toContain(MISSION_FIXED_RULE_SHORT)
  })
})

describe('runGovernedLoop: the first message of a contained run (F242)', () => {
  afterEach(() => { setRunContainment(null) })

  function makeConfig() {
    return {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto' as const,
      temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
      contextLength: undefined, tools: undefined,
    }
  }
  function capturingProvider(captured: CompletionRequest[]): Provider {
    return {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities(): Promise<ModelCapabilities> {
        return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
      },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        captured.push(request)
        const text = '```json\n{"summary": "ok", "recommendations": []}\n```'
        yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
        yield { type: 'content_block_stop', index: 0 } as any
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
        yield { type: 'message_stop' } as any
      },
    }
  }
  /** The text of the first user message the model was sent. */
  function firstUserText(captured: CompletionRequest[]): string {
    expect(captured.length).toBeGreaterThan(0)
    const first = (captured[0].messages ?? []).find((m: any) => m.role === 'user') as any
    expect(first).toBeDefined()
    const c = first.content
    return typeof c === 'string' ? c : (c ?? []).map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
  }

  it('a contained run is told the literal path of its scratch folder; an uncontained one is not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-osrule-'))
    try {
      const scratch = join(dir, 'run', 'scratch')
      setRunContainment(testContainment({
        missionCwd: dir,
        sandbox: { root: join(dir, 'run'), home: join(dir, 'run', 'home'), tmp: join(dir, 'run', 'tmp'), scratch },
        home: join(dir, 'home'),
        folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
      }))
      const captured: CompletionRequest[] = []
      const outcome = await runGovernedLoop({
        prompt: 'Review the waiver wire', context: 'Mission goal: win', allowedTools: ['Read'], timeoutMs: 30000,
        provider: capturingProvider(captured), config: makeConfig() as any, cwd: dir,
      })
      expect(outcome.ok).toBe(true)
      const text = firstUserText(captured)
      expect(text).toContain('Review the waiver wire')
      expect(text).toContain(MISSION_FIXED_RULE)
      expect(text.trimEnd().endsWith(scratchSentence(scratch))).toBe(true)

      setRunContainment(null)
      const plain: CompletionRequest[] = []
      await runGovernedLoop({
        prompt: 'Review the waiver wire', context: 'Mission goal: win', allowedTools: ['Read'], timeoutMs: 30000,
        provider: capturingProvider(plain), config: makeConfig() as any, cwd: dir,
      })
      const plainText = firstUserText(plain)
      expect(plainText).toContain(MISSION_FIXED_RULE)
      expect(plainText).not.toContain('SCRATCH FOLDER')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60000)

  it('a context with no absolute scratch path is a REFUSED: containment outcome, and no model call is made (review 2026-11-23)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-osrule-'))
    try {
      const ctx = testContainment({
        missionCwd: dir,
        sandbox: { root: join(dir, 'run'), home: join(dir, 'run', 'home'), tmp: join(dir, 'run', 'tmp'), scratch: join(dir, 'run', 'scratch') },
        home: join(dir, 'home'),
        folders: { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null },
      })
      setRunContainment({ ...ctx, sandbox: { ...ctx.sandbox, scratch: 'relative-scratch' } })
      const captured: CompletionRequest[] = []
      await expect(runGovernedLoop({
        prompt: 'Review the waiver wire', context: 'Mission goal: win', allowedTools: ['Read'], timeoutMs: 30000,
        provider: capturingProvider(captured), config: makeConfig() as any, cwd: dir,
      })).rejects.toThrow(/^REFUSED: containment: withFixedRule: /)
      expect(captured).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60000)
})

describe('runOneShotTask trade-scan dispatch', () => {
  function makeConfig() {
    return {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto' as const,
      temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
      contextLength: undefined, tools: undefined,
    }
  }
  const noopProvider = {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities() { throw new Error('unused') },
    async complete() { throw new Error('unused') },
    async *stream() { throw new Error('unused') },
  } as unknown as Provider

  it("taskType 'trade-scan' routes to the injected orchestrator and writes its outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-ts-'))
    try {
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'trade-scan', prompt: 'Rank trades', context: 'ctx',
        allowedTools: ['Mfl'], timeoutMs: 60000, outcomePath: join(dir, 'out.json'),
        taskType: 'trade-scan',
        leagues: [{ leagueId: '65042', year: 2026, franchiseId: '0003' }],
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      const seen: TaskFileInput[] = []
      const fakeScan = async (t: TaskFileInput) => {
        seen.push(t)
        return { ok: true, summary: 'scan done', recommendations: [] }
      }
      const code = await runOneShotTask(taskPath, noopProvider, makeConfig() as any, fakeScan)
      expect(code).toBe(0)
      expect(seen.length).toBe(1)
      expect(seen[0].leagues?.[0]?.franchiseId).toBe('0003')
      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome.summary).toBe('scan done')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a non-trade-scan task never dispatches to the trade-scan orchestrator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-ts-'))
    try {
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'morning-brief', prompt: 'Summarize the roster', context: 'ctx',
        allowedTools: [], timeoutMs: 5000, outcomePath: join(dir, 'out.json'),
        // intentionally no taskType — must go to runGovernedLoop, never to tradeScanImpl
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      let fakeScanInvoked = false
      const fakeScan = async (_t: TaskFileInput) => {
        fakeScanInvoked = true
        throw new Error('must not be called')
      }
      // cwd: dir — this path constructs a real ConversationLoop, whose
      // constructor initSnapshot()s its cwd; a temp dir keeps the test from
      // staging the repo root into the live .cynco-snapshots/ (P1.4 fix).
      const code = await runOneShotTask(taskPath, noopProvider, makeConfig() as any, fakeScan, dir)
      // Key assertion 1: the trade-scan orchestrator was never touched
      expect(fakeScanInvoked).toBe(false)
      // Key assertion 2: outcome file was written
      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome).toBeDefined()
      // runGovernedLoop catches the stream error internally, so the run
      // produces zero assistant turns — that is a failed run, exit code 1.
      expect(code).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a run that produced zero turns reports ok:false, not an "(unstructured output)" success', async () => {
    // Real incident: every model call timed out ("[loop] ERROR: The operation
    // timed out."), the loop wrote nothing, and the outcome file still said
    // {"ok": true, "summary": "(unstructured output) (no output)"} — so every
    // unattended caller had to re-derive success by inspecting the repo.
    const dir = mkdtempSync(join(tmpdir(), 'cynco-zt-'))
    try {
      const timingOutProvider = {
        ...noopProvider,
        async probeCapabilities() {
          return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
        },
        async *stream(): AsyncGenerator<any> { throw new Error('The operation timed out.') },
      } as unknown as Provider
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'zero-turn', prompt: 'Do the mission', context: 'ctx',
        allowedTools: ['Read'], timeoutMs: 15000, outcomePath: join(dir, 'out.json'),
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')

      const code = await runOneShotTask(taskPath, timingOutProvider, makeConfig() as any, undefined, dir)
      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome.ok).toBe(false)
      expect(outcome.summary).not.toContain('(unstructured output)')
      expect(String(outcome.error)).toMatch(/no.*turn/i)
      expect(code).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30000)

  it('a failed scan outcome yields exit code 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-ts-'))
    try {
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'trade-scan', prompt: 'p', context: 'c',
        allowedTools: [], timeoutMs: 60000, outcomePath: join(dir, 'out.json'),
        taskType: 'trade-scan',
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      const fakeScan = async () => ({ ok: false, summary: '', recommendations: [], error: 'too few passes' })
      const code = await runOneShotTask(taskPath, noopProvider, makeConfig() as any, fakeScan)
      expect(code).toBe(1)
      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome.error).toBe('too few passes')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("uses task.cwd as the loop workspace when the caller passes no override", async () => {
    const outer = mkdtempSync(join(tmpdir(), 'cynco-cwd-'))
    const workspace = join(outer, 'ws')
    mkdirSync(workspace)
    try {
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 'dynasty-trades', prompt: 'Run the gate', context: 'ctx',
        allowedTools: ['Bash', 'Read'], timeoutMs: 5000, outcomePath: join(outer, 'out.json'),
        cwd: workspace,
      }
      const taskPath = join(outer, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      await runOneShotTask(taskPath, noopProvider, makeConfig() as any)
      // The loop initSnapshot()s its cwd and `git init`s a workspace that has no
      // repo yet: the marker proves the loop ran in task.cwd, not in process.cwd().
      expect(existsSync(join(workspace, '.git'))).toBe(true)
      expect(existsSync(join(process.cwd(), 'cynco-cwd-marker-should-not-exist'))).toBe(false)
    } finally { rmSync(outer, { recursive: true, force: true }) }
  })

})

describe('runOneShotTask (governed conversation loop)', () => {
  function makeConfig() {
    return {
      baseUrl: 'http://localhost:11434',
      model: 'test',
      tier: 'auto' as const,
      temperature: 0.7,
      maxOutputTokens: 8192,
      timeout: 120000,
      contextLength: undefined,
      tools: undefined,
    }
  }

  function* outcomeResponse(): Generator<StreamEvent> {
    const text = '```json\n{"summary": "integration ok", "recommendations": [{"actionType": "waiver", "summary": "Claim Y", "detail": "depth"}]}\n```'
    yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }

  it('runs the task through the real conversation loop with restricted tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-os-'))
    try {
      const captured: CompletionRequest[] = []
      const provider: Provider = {
        name: 'mock',
        async healthCheck() { return true },
        async listModels() { return [] },
        async probeCapabilities(): Promise<ModelCapabilities> {
          return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
        },
        async complete() { throw new Error('not implemented') },
        async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
          captured.push(request)
          yield* outcomeResponse()
        },
      }
      const task: TaskFileInput = {
        missionId: 'm1', triggerId: 't1', prompt: 'Review the waiver wire',
        context: 'Mission goal: win', allowedTools: ['Read'], timeoutMs: 30000,
        outcomePath: join(dir, 'out.json'),
      }
      const taskPath = join(dir, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')

      // cwd: dir — keeps the real loop's initSnapshot off the repo root (P1.4 fix).
      const code = await runOneShotTask(taskPath, provider, makeConfig() as any, undefined, dir)
      expect(code).toBe(0)

      const outcome = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
      expect(outcome.ok).toBe(true)
      expect(outcome.summary).toBe('integration ok')
      expect(outcome.recommendations[0].id).toMatch(/^rec-/)

      // Proof this went through the governed conversation loop, not a bypass:
      // the engine's assembled base prompt carries the <TOOLS> section.
      expect(captured.length).toBeGreaterThan(0)
      const system = String(captured[0].system ?? '')
      expect(system).toContain('<TOOLS>')
      // And the mission's allowedTools restriction reached the model. Unknown
      // models run in simulated tool-use mode (tools ride in the system prompt,
      // request.tools stays unset) — so assert on the <TOOLS> section.
      const toolsSection = system.slice(system.indexOf('<TOOLS>'), system.indexOf('</TOOLS>'))
      expect(toolsSection).toContain('- Read:')
      expect(toolsSection).not.toContain('- Bash:')
      expect(toolsSection).not.toContain('- Write:')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30000)
})
