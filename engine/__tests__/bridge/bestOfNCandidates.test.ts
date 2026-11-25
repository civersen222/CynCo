/**
 * Best-of-N in the loop, wave 15c (P4: what rounds one and two found in the loop's best-of-N block).
 *
 *  - A candidate's worktree is removed when that candidate is done, not only in the block's finally
 *    (round one, item P4(3): "remove the candidate's worktree when the candidate is done").
 *  - A candidate refused for a link it made is named as the candidate it is ('candidate N'), not
 *    only by its worktree's path (round one, found outside the items).
 *  - A winner that is not applied says why on the page: the reason applyPatch gives (check B4-4),
 *    where the page used to say 'patch failed to apply cleanly' for every refusal.
 *
 * The real ConversationLoop against a mock provider, as bestOfNCleanup.test.ts does.
 */
import { describe, expect, it, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'
import { endMarked, goneWithin, isMarked, newMark, watchMarked, type MarkWatch } from '../helpers/markedProcesses.js'

const dirs: string[] = []
const links: string[] = []
/**
 * The marks a hanging test script carries in its command line: a program still running under one is ended by it (the
 * defect's survivor), never by the pid it wrote (F255, wave 24: until then a number read back from its file was ended
 * here, after the test had seen that program gone, so whatever process had the number by then was ended).
 */
const marks: string[] = []
const watches: MarkWatch[] = []
afterAll(async () => {
  for (const w of watches.splice(0)) await w.stop().catch(() => undefined)
  for (const m of marks) endMarked(m)
  // Junctions are removed as entries first, so the folder removal cannot reach through one.
  for (const l of links) { try { rmdirSync(l) } catch { /* already gone with its worktree */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

const bonEnv = ['LOCALCODE_BEST_OF_N', 'LOCALCODE_BEST_OF_N_COUNT'] as const
const prevBon = Object.fromEntries(bonEnv.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of bonEnv) { if (prevBon[k] === undefined) delete process.env[k]; else process.env[k] = prevBon[k] }
  globalContract.clear()
  vi.restoreAllMocks()
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

function done(before?: () => void): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    before?.()
    yield { type: 'message_start', message: { id: 'm2', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

/** A model call that writes `rel` (in whatever folder the executor is in) with the Write tool. */
function write(loopRef: () => ConversationLoop, rel: string, onTree?: (tree: string) => void): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    const tree = (loopRef() as any).executor.cwd as string
    onTree?.(tree)
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu-${rel}`, name: 'Write', input: {} } } as any
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(tree, rel), content: 'y\n' }) } } as any
    yield { type: 'content_block_stop', index: 0 } as any
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
    yield { type: 'message_stop' } as any
  }
}

function repo(prefix: string): { cwd: string; git: (args: string) => string } {
  const cwd = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(cwd)
  writeFileSync(join(cwd, 'f.txt'), 'x\n')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'bon-candidates', private: true, scripts: { test: 'node -e "0"' } }))
  writeFileSync(join(cwd, '.gitignore'), '.cynco*\n.cynco/\nout\n')
  const git = (args: string) => execSync(`git -c user.name=t -c user.email=t@t -c core.autocrlf=false ${args}`, { cwd, stdio: 'pipe' }).toString()
  git('init -q'); git('add -A'); git('commit -q -m base')
  return { cwd, git }
}

describe('best-of-N candidates in the loop', () => {
  it('removes each candidate\'s worktree when that candidate is done, before the next one starts', async () => {
    process.env.LOCALCODE_BEST_OF_N = 'true'
    process.env.LOCALCODE_BEST_OF_N_COUNT = '2'
    const { cwd, git } = repo('cynco-bon-each-')
    let loop: ConversationLoop | null = null
    const trees: string[] = []
    let firstGoneAtSecond: boolean | null = null
    loop = new ConversationLoop({
      cwd, config: config(),
      // Every model call ends the turn; the nudges make each candidate call more than once.
      provider: mockProvider(Array.from({ length: 60 }, () => done())),
      // The progress line of each candidate goes out after its worktree is made and the executor
      // is in it, and before its first model call.
      emit: (e: any) => {
        const m = e.type === 'stream.token' ? /sampling candidate (\d)\/2/.exec(String(e.text)) : null
        if (!m) return
        trees.push((loop as any).executor.cwd as string)
        if (m[1] === '2') firstGoneAtSecond = !existsSync(trees[0])
      },
      allowedTools: ['Read', 'Write'],
    })
    await loop.handleUserMessage('write g.txt')
    expect(trees).toHaveLength(2)
    expect(trees[0]).toMatch(/cynco-bestofn-/)
    expect(firstGoneAtSecond, 'the first candidate\'s worktree was still there when the second started').toBe(true)
    expect(git('worktree list --porcelain')).not.toContain('cynco-bestofn-')
    expect(existsSync(trees[1])).toBe(false)
  }, 120000)

  it('names the candidate it refuses for a link it made', async () => {
    process.env.LOCALCODE_BEST_OF_N = 'true'
    process.env.LOCALCODE_BEST_OF_N_COUNT = '1'
    const { cwd } = repo('cynco-bon-name-')
    const outside = mkdtempSync(join(tmpdir(), 'cynco-bon-name-outside-'))
    dirs.push(outside)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    let loop: ConversationLoop | null = null
    loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([
        write(() => loop!, 'g.txt', t => { const l = join(t, 'lead-out'); symlinkSync(outside, l, 'junction'); links.push(l) }), done(),
        done(),
      ]),
      emit: () => {},
      allowedTools: ['Read', 'Write'],
    })
    await loop.handleUserMessage('write g.txt')
    expect(logs.some(l => /^\[bestOfN\] candidate 1 \(.*cynco-bestofn-.*\) made a link \(lead-out\); it is not applied$/.test(l)), logs.filter(l => l.startsWith('[bestOfN]')).join('\n')).toBe(true)
  }, 120000)

  it('a winner that is not applied says why on the page', async () => {
    process.env.LOCALCODE_BEST_OF_N = 'true'
    process.env.LOCALCODE_BEST_OF_N_COUNT = '1'
    const { cwd } = repo('cynco-bon-why-')
    const outside = mkdtempSync(join(tmpdir(), 'cynco-bon-why-outside-'))
    dirs.push(outside)
    const texts: string[] = []
    let loop: ConversationLoop | null = null
    loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([
        // The candidate writes sub/x.txt in its worktree (Write makes the folder).
        write(() => loop!, join('sub', 'x.txt'), t => { mkdirSync(join(t, 'sub'), { recursive: true }) }),
        // Meanwhile the mission folder's `sub` is a junction leading out of it, as a run in the
        // mission folder could have made it: the winner's patch would write through it.
        done(() => { const l = join(cwd, 'sub'); symlinkSync(outside, l, 'junction'); links.push(l) }),
        done(),
      ]),
      emit: (e: any) => { if (e.type === 'stream.token') texts.push(String(e.text)) },
      allowedTools: ['Read', 'Write'],
    })
    await loop.handleUserMessage('write sub/x.txt')
    const page = texts.join('')
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    expect(page).toMatch(/Candidate 1 won \(.*\) but its patch was not applied: it writes through a link \(sub\)/)
    expect(page).not.toContain('failed to apply cleanly')
  }, 120000)

  // Wave 19, check C4-5: Stop reaches a best-of-N turn. The candidate's test run takes the turn's
  // signal and ends its tree, the candidate loop ends, no winner is applied, and the page says so.
  // Before, the tests ran to their two-minute cap, every later candidate still ran, and the winner
  // the owner stopped was applied to the mission folder.
  it('a Stop during a candidate\'s tests ends them, runs no later candidate and applies nothing', async () => {
    process.env.LOCALCODE_BEST_OF_N = 'true'
    process.env.LOCALCODE_BEST_OF_N_COUNT = '2'
    const { cwd, git } = repo('cynco-bon-stop-')
    const startedDir = mkdtempSync(join(tmpdir(), 'cynco-bon-stop-marks-'))
    dirs.push(startedDir)
    const started = join(startedDir, 'started.txt').replace(/\\/g, '/')
    const mark = newMark('bonStop')
    marks.push(mark)
    // Wave 24, round two: a watcher lists for the mark while the turn runs, and the Stop is pressed once it has seen the
    // program carrying it: "gone" afterwards is also the answer of a mark that never named the program.
    const watch = watchMarked(mark)
    watches.push(watch)
    await watch.ready
    // The candidates' tests: say they started (with their pid), then hang until they are ended (for two minutes at
    // most, far longer than the case needs: a survivor of the defect ends by itself too). The program carries `mark`.
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'bon-stop', private: true,
      scripts: { test: `node -e "require('fs').writeFileSync('${started}', String(process.pid)); setTimeout(() => {}, 120000) // ${mark}"` },
    }))
    git('add -A'); git('commit -q -m tests')
    const texts: string[] = []
    const frames: any[] = []
    let loop: ConversationLoop | null = null
    loop = new ConversationLoop({
      cwd, config: config(),
      provider: mockProvider([write(() => loop!, 'g.txt'), ...Array.from({ length: 40 }, () => done())]),
      emit: (e: any) => { frames.push(e); if (e.type === 'stream.token') texts.push(String(e.text)) },
      allowedTools: ['Read', 'Write'],
    })
    const turn = loop.handleUserMessage('write g.txt')
    // The file exists before its writer has written into it: only a whole positive number is a pid. Number('') is 0,
    // and pid 0 names the asking process itself (wave 24).
    const pidOf = (): number | null => {
      if (!existsSync(started)) return null
      const n = Number(readFileSync(started, 'utf-8').trim())
      return Number.isInteger(n) && n > 0 ? n : null
    }
    const until = Date.now() + 60_000
    while (pidOf() === null && Date.now() < until) await new Promise(res => setTimeout(res, 100))
    expect(existsSync(started), 'the first candidate\'s tests never started').toBe(true)
    const pid = pidOf()
    expect(pid, `the first candidate's tests wrote no pid: ${JSON.stringify(readFileSync(started, 'utf-8'))}`).not.toBeNull()
    // The control: before the Stop the mark finds the program, so "gone" after it is not a mark that finds nothing.
    expect(isMarked(pid!, mark), `node ${pid} is not found by its mark while the candidate's tests run`).toBe(true)
    await watch.saw(pid!, 15_000)
    const t0 = Date.now()
    loop.abort()
    await turn
    const ms = Date.now() - t0
    expect(await watch.stop(), `node ${pid} was never seen carrying its mark while the candidate's tests ran`).toContain(pid)
    // Asked by the mark, never by the number alone; a survivor is ended by the mark in afterAll.
    const gone = await goneWithin(pid!, mark)
    const page = texts.join('')
    expect(ms, 'the turn waited for the tests\' cap, not the Stop').toBeLessThan(15_000)
    expect(gone, `node ${pid}, started by the candidate's tests, outlived the Stop`).toBe(true)
    expect(page).not.toContain('sampling candidate 2/2')
    expect(page).toContain('**Best-of-N:** stopped, so no candidate was applied.')
    expect(page).not.toContain('Best-of-N result')
    expect(frames.some(f => f.type === 'bestOfN.selected')).toBe(false)
    // The stopped candidate is not scored: its tests were ended, not run.
    expect(frames.some(f => f.type === 'bestOfN.candidate')).toBe(false)
    expect(existsSync(join(cwd, 'g.txt'))).toBe(false)
    expect(git('worktree list --porcelain')).not.toContain('cynco-bestofn-')
    expect(frames.filter(f => f.type === 'message.complete' && f.stopReason === 'aborted')).toHaveLength(1)
  }, 200000)
})
