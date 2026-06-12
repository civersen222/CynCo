// engine/__tests__/daemon/oneShot.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractOutcome, buildOneShotPrompt, runOneShotTask } from '../../daemon/oneShot.js'
import type { Provider, CompletionRequest, ModelCapabilities } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { TaskFileInput } from '../../daemon/types.js'

// runOneShotTask drives a real ConversationLoop (filesystem, JSONL sessions,
// index DBs) — gated like the other ConversationLoop integration tests.
// Run with: CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/daemon/oneShot.test.ts
const SKIP = !process.env.CYNCO_INTEGRATION

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

describe('buildOneShotPrompt', () => {
  it('includes the outcome format contract, mission context, and task prompt', () => {
    const p = buildOneShotPrompt('goal: win the league', 'Review the waiver wire')
    expect(p).toContain('goal: win the league')
    expect(p).toContain('Review the waiver wire')
    expect(p).toContain('```json')
    expect(p).toContain('recommendations')
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

  it.skipIf(SKIP)('runs the task through the real conversation loop with restricted tools', async () => {
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

      const code = await runOneShotTask(taskPath, provider, makeConfig() as any)
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
