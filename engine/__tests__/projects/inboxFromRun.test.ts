/**
 * A scheduled run aimed at a project files its answer in that project's inbox
 * (engine/projects/inbox.ts `fileRunDraft`, called from the daemon's one-shot).
 *
 * The call site is two small additions in engine/daemon/oneShot.ts; they are
 * pinned by text here, and the whole path — a task file, the real
 * conversation loop with a scripted model, the draft on disk — runs when
 * CYNCO_INTEGRATION is set, as the daemon's own loop tests do.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { runOneShotTask } from '../../daemon/oneShot.js'
import { createProject } from '../../projects/layout.js'
import { listDrafts } from '../../projects/inbox.js'
import type { Provider, CompletionRequest, ModelCapabilities } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { TaskFileInput } from '../../daemon/types.js'

const SKIP = !process.env.CYNCO_INTEGRATION
const here = dirname(fileURLToPath(import.meta.url))
const oneShot = readFileSync(join(here, '../../daemon/oneShot.ts'), 'utf-8').replace(/\r\n/g, '\n')

describe('the call site in the daemon\'s one-shot', () => {
  it('a run that ended well tells onFinished; a failed one returns before it', () => {
    const body = oneShot.slice(oneShot.indexOf('export async function runGovernedLoop('), oneShot.indexOf('export async function runOneShotTask('))
    const failed = body.indexOf('if (failure) {')
    const told = body.indexOf('opts.onFinished?.(messages, outcome)')
    expect(failed).toBeGreaterThan(-1)
    expect(told).toBeGreaterThan(failed)
    expect(body.slice(failed, told)).toMatch(/return \{ ok: false/)
    expect(body.slice(told)).toMatch(/^opts\.onFinished\?\.\(messages, outcome\)\n  return outcome\n\}/)
  })
  it('runOneShotTask files the draft with the run\'s own working folder, mission and trigger, under the projects home', () => {
    const body = oneShot.slice(oneShot.indexOf('export async function runOneShotTask('))
    expect(body).toMatch(/onFinished: \(messages, done\) => \{\s*fileRunDraft\(\{ home: projectsHome\(\), cwd: cwd \?\? task\.cwd, missionId: task\.missionId, triggerId: task\.triggerId, sessionId: done\.sessionId, messages, summary: done\.summary \}\)/)
    // The trade scan has its own orchestrator and files nothing.
    const tradeScan = body.slice(body.indexOf("if (task.taskType === 'trade-scan')"), body.indexOf('} else {'))
    expect(tradeScan).not.toContain('fileRunDraft')
  })
})

describe('a one-shot whose working folder is a project (real conversation loop, scripted model)', () => {
  function makeConfig() {
    return { baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto' as const, temperature: 0.7, maxOutputTokens: 8192, timeout: 120000, contextLength: undefined, tools: undefined }
  }
  function* answer(text: string): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as never
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as never
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as never
    yield { type: 'content_block_stop', index: 0 } as never
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as never
    yield { type: 'message_stop' } as never
  }
  const provider = (text: string): Provider => ({
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> {
      return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
    },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> { yield* answer(text) },
  })
  const ANSWER = '# Planting plan\n\nTulips by the fence, daffodils under the maple.\n\n```json\n{"summary": "A plan for both beds.", "recommendations": []}\n```'

  it.skipIf(SKIP)('files its answer as a draft in that project, and still writes its outcome', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-inbox-run-'))
    const scratch = mkdtempSync(join(tmpdir(), 'cynco-inbox-run-task-'))
    const savedHome = process.env.LOCALCODE_PROJECTS_HOME
    process.env.LOCALCODE_PROJECTS_HOME = home
    try {
      const meta = createProject(home, { name: 'Yard' })
      const dir = join(home, meta.slug)
      const task: TaskFileInput = {
        missionId: 'yard-weekly', triggerId: 'planting-plan', prompt: 'Write this week\'s planting plan.',
        context: 'A garden project.', allowedTools: ['Read'], timeoutMs: 30000,
        outcomePath: join(scratch, 'out.json'), cwd: dir,
      }
      const taskPath = join(scratch, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      const code = await runOneShotTask(taskPath, provider(ANSWER), makeConfig() as never)
      expect(code).toBe(0)
      expect(JSON.parse(readFileSync(join(scratch, 'out.json'), 'utf-8'))).toMatchObject({ ok: true, summary: 'A plan for both beds.' })
      const drafts = listDrafts(dir).drafts
      expect(drafts).toHaveLength(1)
      expect(drafts[0]).toMatchObject({ from: 'yard-weekly · planting-plan', summary: 'A plan for both beds.', readable: true })
      expect(drafts[0]!.name).toMatch(/^\d{8}-\d{6}-planting-plan\.md$/)
      expect(readFileSync(join(dir, 'inbox', drafts[0]!.name), 'utf8')).toBe('# Planting plan\n\nTulips by the fence, daffodils under the maple.\n')
    } finally {
      if (savedHome === undefined) delete process.env.LOCALCODE_PROJECTS_HOME; else process.env.LOCALCODE_PROJECTS_HOME = savedHome
      rmSync(home, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true })
    }
  }, 30000)

  it.skipIf(SKIP)('a one-shot anywhere else files nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-inbox-run-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'cynco-inbox-run-elsewhere-'))
    const savedHome = process.env.LOCALCODE_PROJECTS_HOME
    process.env.LOCALCODE_PROJECTS_HOME = home
    try {
      const meta = createProject(home, { name: 'Yard' })
      const task: TaskFileInput = {
        missionId: 'fantasy-digest', triggerId: 'digest', prompt: 'Summarise the league.', context: 'A league.',
        allowedTools: ['Read'], timeoutMs: 30000, outcomePath: join(elsewhere, 'out.json'), cwd: elsewhere,
      }
      const taskPath = join(elsewhere, 'task.json')
      writeFileSync(taskPath, JSON.stringify(task), 'utf-8')
      expect(await runOneShotTask(taskPath, provider(ANSWER), makeConfig() as never)).toBe(0)
      expect(listDrafts(join(home, meta.slug)).drafts).toEqual([])
      expect(readdirSync(join(home, meta.slug, 'inbox'))).toEqual([])
    } finally {
      if (savedHome === undefined) delete process.env.LOCALCODE_PROJECTS_HOME; else process.env.LOCALCODE_PROJECTS_HOME = savedHome
      rmSync(home, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true })
    }
  }, 30000)
})
