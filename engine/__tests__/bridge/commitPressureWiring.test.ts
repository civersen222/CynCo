/**
 * Proof that the commit-pressure notice is on a live path.
 *
 * commitPressure.ts is a pure function, and a pure function that nothing calls
 * passes all of its own tests forever. That is the specific failure this file
 * guards: if the injection were dead, the ledger would record the signal as
 * "never fired", which reads identically to a run that committed properly. A
 * broken instrument and a healthy mission must not look the same.
 *
 * So these tests run the real ConversationLoop against a mock provider and
 * assert on the counter the real executeOneTool advances and the message the
 * real runModelLoop pushes.
 */
import { describe, expect, it, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import { globalContract } from '../../tools/contract.js'
import { COMMIT_PRESSURE_PERIOD } from '../../bridge/commitPressure.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
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

/** One assistant message carrying `paths.length` parallel Read calls. */
function readToolUse(...paths: string[]): () => Generator<StreamEvent> {
  return function* (): Generator<StreamEvent> {
    yield { type: 'message_start', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } } as any
    for (let i = 0; i < paths.length; i++) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu${i}`, name: 'Read', input: {} } } as any
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: paths[i] }) } } as any
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

function noticeText(loop: ConversationLoop): string[] {
  return loop.getMessages()
    .filter(m => m.role === 'user')
    .flatMap(m => (Array.isArray(m.content) ? m.content : []) as any[])
    .filter(c => c?.type === 'text')
    .map(c => String(c.text))
    // Match the prefix both wordings share. The notice has two branches — one
    // for a tree holding unsaved work, one for a tree holding no work at all —
    // and these tests are about whether the notice REACHES the conversation,
    // not about which of the two it chose. Filtering on wording unique to the
    // dirty branch made the whole file silently stop testing the wiring the
    // moment the clean branch was added.
    .filter(t => t.includes('[System] You have made '))
}

describe('the commit-pressure counter is advanced by real tool calls', () => {
  it('executeOneTool increments callsSinceCommit', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-cp-count-')

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'nonexistent.txt')),
        textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    expect((loop as any).callsSinceCommit).toBe(0)
    await loop.handleUserMessage('read the file for me please')
    // One tool call went through the real executeOneTool. If accountCommitPressure
    // were not called from there, this stays 0 and the notice can never fire.
    expect((loop as any).callsSinceCommit).toBe(1)
    globalContract.clear()
  }, 30000)

  it('a new HEAD in the workspace resets the counter', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-cp-head-')
    const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf-8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(cwd, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    git('commit', '-m', 'base')

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'a.txt')),
        textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    // First reading seeds lastCommitHead; the baseline is not delivery, so the
    // call still counts. (Task 2 of this plan hit the mirror-image bug driver
    // side, where the dispatch baseline was read as commit number one.)
    await loop.handleUserMessage('read a.txt')
    expect((loop as any).callsSinceCommit).toBe(1)

    writeFileSync(join(cwd, 'a.txt'), 'two\n')
    git('add', 'a.txt')
    git('commit', '-m', 'the model saved its work')

    ;(loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(0)
    globalContract.clear()
  }, 30000)
})

describe('the notice reaches the conversation', () => {
  it('injects the notice into the real message list when the threshold is crossed', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-cp-fire-')
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'nonexistent.txt')),
        textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    // One call short of the threshold. Reaching 150 honestly would need 150
    // scripted model turns; what is under test is the injection, not counting.
    ;(loop as any).callsSinceCommit = COMMIT_PRESSURE_PERIOD - 1

    await loop.handleUserMessage('keep going')
    spy.mockRestore()

    const notices = noticeText(loop)
    expect(notices.length).toBe(1)
    // This workspace is a fresh repo with nothing modified, so the notice takes
    // the clean branch — the run has drafted nothing, which is a different
    // failure from having drafted and not saved.
    expect(notices[0]).toContain(`${COMMIT_PRESSURE_PERIOD} tool calls`)
    expect(notices[0]).toContain('have not changed a single source file')
    expect(logs.some(l => l.includes('[loop] Commit pressure'))).toBe(true)
    expect(logs.some(l => l.includes('CLEAN — nothing drafted'))).toBe(true)
    globalContract.clear()
  }, 30000)

  it('takes the unsaved-work branch when a tracked file really is modified', async () => {
    // The other half. Without this, the selector could be hardwired to "clean"
    // and every test above would still pass — and a run that HAS unsaved work
    // would be told to stop drafting, which is the F107 mistake inverted.
    globalContract.clear()
    const cwd = tempDir('cynco-cp-dirty-')
    const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf-8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(cwd, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    git('commit', '-m', 'base')
    // Modify a TRACKED file. An untracked scratch file must not count as work
    // — that is precisely what Stage 11I's second attempt produced 38 times
    // while the product never moved — so this test would not discriminate if
    // it only wrote a new file.
    writeFileSync(join(cwd, 'a.txt'), 'the model drafted this and did not commit\n')

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'nonexistent.txt')),
        textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    ;(loop as any).callsSinceCommit = COMMIT_PRESSURE_PERIOD - 1
    await loop.handleUserMessage('keep going')

    const notices = noticeText(loop)
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('tool calls since the last commit')
    expect(notices[0]).toContain('commit it now')
    expect(notices[0]).not.toContain('have not changed a single source file')
    globalContract.clear()
  }, 30000)

  it('still fires when a parallel batch steps over the threshold', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-cp-step-')

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        // Two calls in one assistant message: 149 -> 151, never equal to 150.
        readToolUse(join(cwd, 'a.txt'), join(cwd, 'b.txt')),
        textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    ;(loop as any).callsSinceCommit = COMMIT_PRESSURE_PERIOD - 1

    await loop.handleUserMessage('keep going')

    expect((loop as any).callsSinceCommit).toBe(COMMIT_PRESSURE_PERIOD + 1)
    const notices = noticeText(loop)
    expect(notices.length).toBe(1)
    // Reported at the threshold it crossed, not at the counter's exact value —
    // an exact-equality check here would have found nothing to say at all.
    expect(notices[0]).toContain(`${COMMIT_PRESSURE_PERIOD} tool calls`)
    expect(notices[0]).not.toContain(`${COMMIT_PRESSURE_PERIOD + 1} tool calls`)
    // This workspace is clean, so the notice must take the clean branch. Kept
    // as a second guard on the selector: with `readTreeIsClean` stubbed out,
    // exactly one test in this file failed, which is a thin margin for a
    // mechanism whose whole job is to fire correctly on a rare condition.
    expect(notices[0]).toContain('have not changed a single source file')
    globalContract.clear()
  }, 30000)

  it('does not repeat the notice while the counter sits past a threshold', async () => {
    globalContract.clear()
    const cwd = tempDir('cynco-cp-once-')

    const loop = new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([
        readToolUse(join(cwd, 'a.txt')),
        readToolUse(join(cwd, 'b.txt')),
        readToolUse(join(cwd, 'c.txt')),
        textResponse('done'),
      ]),
      emit: () => {},
      allowedTools: ['Read'],
    })

    ;(loop as any).callsSinceCommit = COMMIT_PRESSURE_PERIOD - 1

    await loop.handleUserMessage('keep going')

    expect((loop as any).callsSinceCommit).toBe(COMMIT_PRESSURE_PERIOD + 2)
    expect(noticeText(loop).length).toBe(1)
    globalContract.clear()
  }, 30000)
})

/**
 * F110. Stage 11I's fourth attempt ran 161 tool calls without one notice
 * firing, on a tree that had never been touched — the exact condition the
 * notice exists to name. The reflog said why:
 *
 *   b63d9e0 HEAD@{1}: checkout: moving from 305daff to master
 *   305daff HEAD@{2}: checkout: moving from master to 305daff
 *
 * The model checked the base out in the live worktree to compare it, then
 * checked master back out. `accountCommitPressure` watches HEAD and treats any
 * new value as delivery, so those two checkouts each called `observeCommit()`
 * and each zeroed the clock. The instrument did not misreport — it went silent,
 * which in the ledger is indistinguishable from a run that was committing
 * properly.
 *
 * This matters beyond the model's own behaviour: these repositories are known
 * to have an external process that switches branches mid-run, so the pacing
 * clock could be reset by something the model never did.
 *
 * The rule that fixes it: a commit is a HEAD THIS RUN HAS NEVER SEEN whose
 * ancestry contains the HEAD it replaced. Checking out an older commit fails
 * the ancestry half; checking a previously-seen one back out fails the novelty
 * half. Both halves are needed — either alone still resets on the return trip.
 */
describe('moving HEAD is not the same as making a commit', () => {
  function repo(prefix: string) {
    const cwd = tempDir(prefix)
    const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf-8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(cwd, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    git('commit', '-m', 'first')
    const first = git('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(cwd, 'a.txt'), 'two\n')
    git('add', 'a.txt')
    git('commit', '-m', 'second')
    const second = git('rev-parse', 'HEAD').stdout.trim()
    return { cwd, git, first, second }
  }

  function loopOn(cwd: string): ConversationLoop {
    return new ConversationLoop({
      cwd,
      config: config(),
      provider: mockProvider([textResponse('done')]),
      emit: () => {},
      allowedTools: ['Read'],
    })
  }

  it('does not reset when an older commit is checked out', () => {
    globalContract.clear()
    const { cwd, git } = repo('cynco-cp-co-back-')
    const loop = loopOn(cwd)

    // Seed on the tip, then spend calls without committing.
    ;(loop as any).accountCommitPressure()
    for (let n = 0; n < 20; n++) (loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(21)

    // The model checks the base out to compare against it. Nothing was
    // delivered; the clock must keep running.
    git('checkout', '--detach', 'HEAD~1')
    ;(loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(22)
    globalContract.clear()
  }, 30000)

  it('does not reset when the newer commit is checked back out', () => {
    globalContract.clear()
    const { cwd, git, second } = repo('cynco-cp-co-fwd-')
    const loop = loopOn(cwd)

    ;(loop as any).accountCommitPressure()
    git('checkout', '--detach', 'HEAD~1')
    ;(loop as any).accountCommitPressure()

    // The return trip is the half an ancestry test alone gets wrong: the tip
    // really is a descendant of the base, so "descends from the last HEAD"
    // reads it as a commit. It is a HEAD we have already seen.
    git('checkout', second)
    ;(loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(3)
    globalContract.clear()
  }, 30000)

  it('still resets on a genuine commit made after a checkout round trip', () => {
    globalContract.clear()
    const { cwd, git, second } = repo('cynco-cp-co-real-')
    const loop = loopOn(cwd)

    ;(loop as any).accountCommitPressure()
    git('checkout', '--detach', 'HEAD~1')
    ;(loop as any).accountCommitPressure()
    git('checkout', second)
    ;(loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(3)

    // Now the model actually delivers. This must still be recognised, or the
    // fix for a silent instrument would be an instrument that never resets.
    writeFileSync(join(cwd, 'a.txt'), 'three\n')
    git('add', 'a.txt')
    git('commit', '-m', 'the model saved its work')
    ;(loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(0)
    globalContract.clear()
  }, 30000)

  it('resets once for a burst of several commits', () => {
    globalContract.clear()
    const { cwd, git } = repo('cynco-cp-co-burst-')
    const loop = loopOn(cwd)

    ;(loop as any).accountCommitPressure()
    for (let n = 0; n < 5; n++) (loop as any).accountCommitPressure()

    // Two commits land between one tool call and the next; HEAD jumps by two.
    // The new tip is unseen and descends from the old one, so this is delivery.
    for (const body of ['three\n', 'four\n']) {
      writeFileSync(join(cwd, 'a.txt'), body)
      git('add', 'a.txt')
      git('commit', '-m', body.trim())
    }
    ;(loop as any).accountCommitPressure()
    expect((loop as any).callsSinceCommit).toBe(0)
    globalContract.clear()
  }, 30000)
})
