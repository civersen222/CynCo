/**
 * A caller pin (`allowedTools`) names a run's tools exactly, extended tools included.
 *
 * Since core-by-default tool loading (e7ad57f1), the loop seeded its offered set with core tools only and then
 * intersected it with the pin. A pin can only remove, so pinned extended tools (WebSearch, WebFetch, Mfl) never
 * reached the model: daemon missions pinned to ['Bash','Write','Read','WebSearch','WebFetch','Mfl'] were offered
 * three tools, the default read-only pin ['Mfl','WebSearch','WebFetch','Read'] was offered Read alone, and the
 * trade-scan ranking pass (['Mfl','WebSearch','WebFetch']) was offered nothing. The prompt meanwhile invited a
 * `load_tools` call that the pin itself blocks. 2026-10-28: the fantasy card passes could not research news and
 * fell back to scraping a search engine through Bash.
 *
 * The real ConversationLoop against a mock provider, as abortIsATurnEnd does.
 */
import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
afterEach(() => { globalContract.clear() })

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
  } as LocalCodeConfig
}

function* done(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '```json\n{"summary": "ok", "recommendations": []}\n```' } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

async function firstRequest(allowedTools: string[]): Promise<CompletionRequest> {
  globalContract.clear()
  const cwd = mkdtempSync(join(tmpdir(), 'cynco-pin-ext-'))
  dirs.push(cwd)
  const captured: CompletionRequest[] = []
  const provider: Provider = {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(r: CompletionRequest): AsyncGenerator<StreamEvent> { captured.push(r); yield* done() },
  }
  const loop = new ConversationLoop({ cwd, config: config(), provider, emit: () => {}, allowedTools })
  await loop.handleUserMessage('research the news for this roster')
  expect(captured.length).toBeGreaterThan(0)
  return captured[0]
}

function offered(r: CompletionRequest): string[] {
  const native = (r.tools ?? []).map((t: any) => t.name ?? t.function?.name).filter(Boolean)
  if (native.length) return native.sort()
  const system = String(r.system ?? '')
  const section = system.slice(system.indexOf('<TOOLS>'), system.indexOf('</TOOLS>'))
  return [...section.matchAll(/^- (\w+):/gm)].map(m => m[1]).sort()
}

describe('a caller pin offers exactly the pinned tools, extended ones included', () => {
  it('the fantasy mission pin offers Bash, Write, Read, WebSearch, WebFetch and Mfl', async () => {
    const r = await firstRequest(['Bash', 'Write', 'Read', 'WebSearch', 'WebFetch', 'Mfl'])
    expect(offered(r)).toEqual(['Bash', 'Mfl', 'Read', 'WebFetch', 'WebSearch', 'Write'])
  })

  it('the daemon default read-only pin offers all four of its tools, not Read alone', async () => {
    const r = await firstRequest(['Mfl', 'WebSearch', 'WebFetch', 'Read'])
    expect(offered(r)).toEqual(['Mfl', 'Read', 'WebFetch', 'WebSearch'])
  })

  it('a pin of only extended tools is not an empty tool list', async () => {
    const r = await firstRequest(['Mfl', 'WebSearch', 'WebFetch'])
    expect(offered(r)).toEqual(['Mfl', 'WebFetch', 'WebSearch'])
  })

  it('under a pin the prompt does not invite load_tools, which the pin blocks', async () => {
    const r = await firstRequest(['Read', 'WebSearch'])
    expect(String(r.system ?? '')).not.toContain('Loadable on demand')
    expect(offered(r)).not.toContain('load_tools')
  })

  it('a pinned name that is not a real tool is ignored, not offered', async () => {
    const r = await firstRequest(['Read', 'NoSuchTool'])
    expect(offered(r)).toEqual(['Read'])
  })
})
