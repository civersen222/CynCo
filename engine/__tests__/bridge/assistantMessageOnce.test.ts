/**
 * One assistant message per model call.
 *
 * callModel assembles the turn at every `content_block_stop` and yields it
 * cumulatively — the last yield is the turn. The loop used to push EVERY
 * yield: a turn of N blocks reached history N times, each copy a strict
 * prefix of the next, and the provider was sent consecutive assistant
 * messages. The model re-read its own narration and met a tool_use id in two
 * assistant messages before the one result for it; the journal and a project
 * chat's transcript (what the page replays on reload) carried the copies too.
 * The real providers emit no stops of their own (streamTranslator synthesises
 * one whenever a new block starts and at message_stop), so this was the
 * production path, not a mock artefact (review of 6cb97b4).
 *
 * The real ConversationLoop on the projects-mode scaffold, whose stream shape
 * is the providers' (deltas and block starts, no stops).
 */
import { describe, expect, it, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { globalContract } from '../../tools/contract.js'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { listChats, readTranscript } from '../../projects/chat.js'
import { makeLoop, type ScriptBlock } from '../projects/loopScaffold.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
const prevMax = process.env.LOCALCODE_MAX_ITERATIONS
afterEach(() => {
  if (prevMax === undefined) delete process.env.LOCALCODE_MAX_ITERATIONS; else process.env.LOCALCODE_MAX_ITERATIONS = prevMax
  globalContract.clear()
  setProjectToolContext(null)
})

const glob = (n: number): ScriptBlock => ({ type: 'tool_use', name: 'Glob', input: { pattern: `*.none-${n}` } })
const say = (text: string): ScriptBlock => ({ type: 'text', text })
/** `text` for a text block, `use:<id>` for a tool_use — the shape of one message. */
const shape = (m: any) => (m.content as any[]).map(b => b.type === 'tool_use' ? `use:${b.id}` : b.type)

describe('one assistant message per model call', () => {
  it('[text, tool_use] and [tool_use, tool_use] turns each reach history once, and no request carries two assistant messages in a row', async () => {
    process.env.LOCALCODE_MAX_ITERATIONS = '3'
    const made = makeLoop({ script: [[say('Let me look.'), glob(1)], [glob(2), glob(3)]] })
    await made.loop.handleUserMessage('look around')
    const assistants = (made.loop.getMessages() as any[]).filter(m => m.role === 'assistant').map(shape)
    expect(assistants.slice(0, 2)).toEqual([['text', 'use:tu-m0-1'], ['use:tu-m1-0', 'use:tu-m1-1']])
    for (const id of ['tu-m0-1', 'tu-m1-0', 'tu-m1-1']) {
      expect(assistants.filter(s => s.includes(`use:${id}`)), `${id} is in one assistant message`).toHaveLength(1)
    }
    expect(made.calls.length).toBeGreaterThanOrEqual(3)
    for (const [n, call] of made.calls.entries()) {
      const roles = (call.messages as any[]).map(m => m.role)
      const doubled = roles.findIndex((r, i) => i > 0 && r === 'assistant' && roles[i - 1] === 'assistant')
      expect(doubled, `call ${n} sent assistant messages back to back at ${doubled}: ${roles.join(' ')}`).toBe(-1)
    }
  }, 30000)

  it('a project chat transcript gets the turn once too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-once-proj-'))
    dirs.push(home)
    const slug = createProject(home, { name: 'Looking', instructions: '' }).slug
    const made = makeLoop({ script: [[say('Let me look.'), glob(1)], [say('Nothing there.')]] })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await made.loop.startProjectSession(b.binding, b.messages)
    await made.loop.handleUserMessage('look around')
    const t = readTranscript(join(home, slug), listChats(join(home, slug))[0].file)!
    const assistants = t.messages.filter(m => m.role === 'assistant').map(shape)
    expect(assistants).toEqual([['text', 'use:tu-m0-1'], ['text']])
  }, 30000)
})
