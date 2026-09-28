/**
 * F162 (worktree leak): a best-of-N turn that throws part-way through the
 * orchestration must still remove every `cynco-bestofn-*` worktree it created
 * and leave the executor pointed back at the main tree. The throw is driven
 * through the real caller path: the engine's own emit throws on the
 * `bestOfN.candidate` frame, after the candidate ran and while the executor is
 * still inside its worktree.
 *
 * The real ConversationLoop against a mock provider, as sessionFidelityEveryExit does.
 */
import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

const bonEnv = ['LOCALCODE_BEST_OF_N', 'LOCALCODE_BEST_OF_N_COUNT'] as const
const prevBon = Object.fromEntries(bonEnv.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of bonEnv) { if (prevBon[k] === undefined) delete process.env[k]; else process.env[k] = prevBon[k] }
  globalContract.clear()
})

function config(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test-model', tier: 'auto', temperature: 0.7,
    maxOutputTokens: 8192, timeout: 120000, contextLength: 131072, tools: undefined, noScouts: true, approveAll: true,
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
    async *stream(_r: CompletionRequest): AsyncGenerator<StreamEvent> { const gen = responses[idx++]; if (gen) yield* gen() },
  } as Provider
}

function done(): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

describe('F162: best-of-N removes its worktrees on a throw through the caller', () => {
  it('a throw after the candidate ran leaves no cynco-bestofn-* worktree and the executor back on the main tree', async () => {
    process.env.LOCALCODE_BEST_OF_N = 'true'
    process.env.LOCALCODE_BEST_OF_N_COUNT = '1'
    globalContract.clear()
    const cwd = mkdtempSync(join(tmpdir(), 'cynco-f162-bon-'))
    dirs.push(cwd)
    writeFileSync(join(cwd, 'f.txt'), 'x\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'f162-bon', private: true, scripts: { test: 'node -e "0"' } }))
    writeFileSync(join(cwd, '.gitignore'), '.cynco*\n.cynco/\n')
    const git = (args: string) => execSync(`git -c user.name=t -c user.email=t@t -c core.autocrlf=false ${args}`, { cwd, stdio: 'pipe' }).toString()
    git('init -q'); git('add -A'); git('commit -q -m base')

    let loop: ConversationLoop | null = null
    let candidateTree = ''
    const write = function* (): Generator<StreamEvent> {
      candidateTree = (loop as any).executor.cwd as string
      yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu0', name: 'Write', input: {} } } as any
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(candidateTree, 'g.txt'), content: 'y\n' }) } } as any
      yield { type: 'content_block_stop', index: 0 } as any
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
      yield { type: 'message_stop' } as any
    }
    let threw = false
    loop = new ConversationLoop({
      cwd, config: config(),
      // candidate: write + done; single-pass fallback after the throw: done
      provider: mockProvider([write, done(), done()]),
      emit: (e: any) => {
        if (e.type === 'bestOfN.candidate') {
          // Still inside the candidate's worktree when the throw lands.
          expect(existsSync(candidateTree)).toBe(true)
          threw = true
          throw new Error('emit failed mid-orchestration')
        }
      },
      allowedTools: ['Read', 'Write'],
    })
    await loop.handleUserMessage('write g.txt')

    expect(threw).toBe(true)
    expect(candidateTree).toMatch(/cynco-bestofn-/)
    expect(git('worktree list --porcelain')).not.toContain('cynco-bestofn-')
    expect(existsSync(candidateTree)).toBe(false)
    expect((loop as any).executor.cwd).toBe(cwd)
    // The candidate's patch was never applied to the main tree.
    expect(existsSync(join(cwd, 'g.txt'))).toBe(false)
  }, 120000)
})
