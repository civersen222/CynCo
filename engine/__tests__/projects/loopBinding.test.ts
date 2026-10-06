import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { ingestFile } from '../../projects/ingest.js'
import { openBinding } from '../../projects/binding.js'
import { listChats, readTranscript } from '../../projects/chat.js'
import { RETRIEVAL_TAG } from '../../projects/retrieval.js'
import { getProjectToolContext, setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { PROJECT_TOOL_NAMES } from '../../projects/profile.js'
import { makeLoop } from './loopScaffold.js'

const offered = (loop: unknown): Set<string> => (loop as any).offeredToolNames ?? new Set()

afterEach(() => {
  setProjectToolContext(null)
  globalContract.clear()
})

async function project(name: string, instructions: string) {
  const home = mkdtempSync(join(tmpdir(), 'cynco-loop-'))
  const slug = createProject(home, { name, instructions }).slug
  return { home, slug }
}

const retrievalMsgs = (msgs: any[]) => msgs.filter(m => m.role === 'system' && m.content[0]?.text?.startsWith(RETRIEVAL_TAG))

describe('ConversationLoop + ProjectBinding', () => {
  it('a project turn: project prompt, retrieval block, transcript, citations event, no contract, no code index', async () => {
    const { home, slug } = await project('Loop', 'Metric.')
    writeFileSync(join(home, slug, 'knowledge', 'a.md'), '# Resin\n\nEpoxy cures in a day.\n', 'utf8')
    await ingestFile({ home, embed: null, embedModel: 'none' }, slug, 'knowledge', 'a.md', 'pasted')
    const { loop, events, calls } = makeLoop({ script: [[{ type: 'text', text: 'It cures in a day [1].' }]] })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    expect(getProjectToolContext()?.slug).toBe(slug)
    await loop.handleUserMessage('how long does epoxy take to cure')
    const sys = calls[0].systemPrompt as string
    expect(sys).toContain('<PROJECT>')
    expect(sys).toContain('Metric.')
    expect(sys).not.toMatch(/MANDATORY FIRST STEP/)
    // The mock's model family is unknown to the capability table, so no native
    // tool array reaches the provider; the offered set is read off the loop.
    expect([...offered(loop)].sort()).toEqual([...PROJECT_TOOL_NAMES].sort())
    expect(sys).toContain('- ProjectSearch:')
    const msgs = calls[0].messages as any[]
    expect(retrievalMsgs(msgs)).toHaveLength(1)
    // no code index: the `[Project code context]` block never appears
    expect(msgs.some(m => m.role === 'system' && String(m.content[0]?.text ?? '').startsWith('[Project code context]'))).toBe(false)
    // no contract auto-created from a project message
    expect(globalContract.isActive()).toBe(false)
    expect(events.find(e => e.type === 'project.citations')).toMatchObject({ citations: [{ n: 1, filePath: 'knowledge/a.md' }] })
    const chats = listChats(join(home, slug))
    expect(chats).toHaveLength(1)
    const t = readTranscript(join(home, slug), chats[0].file)!
    expect(t.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(t.header.title).toBe('how long does epoxy take to cure')
    expect(events.some(e => e.type === 'project.opened')).toBe(true)
    // the retrieval block is replaced, not accumulated
    const before = calls.length
    // Names epoxy so keyword-only search (embed: null) has a hit to rebuild the
    // block from; a bare "and sanding?" matches nothing and builds no block.
    await loop.handleUserMessage('and does epoxy need sanding?')
    expect(retrievalMsgs(calls[before].messages as any[])).toHaveLength(1)
    expect(calls[before].systemPrompt).toBe(calls[0].systemPrompt) // byte-identical across turns
    // and never journaled into the conversation: the in-memory copy holds one too
    expect(retrievalMsgs(loop.getMessages() as any[])).toHaveLength(1)
  }, 60000)

  it('project.open during a streaming turn aborts it, marks the partial assistant text aborted, and the new session is clean', async () => {
    const { home, slug } = await project('Abort', '')
    let reached!: () => void
    const atHold = new Promise<void>(r => { reached = r })
    let release!: () => void
    const released = new Promise<void>(r => { release = r })
    const { loop } = makeLoop({
      script: [[{ type: 'text', text: ['Partial answ', 'er that never lands'] }]],
      hold: { call: 0, reached, release: released },
    })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    const turn = loop.handleUserMessage('tell me something long')
    await atHold
    const swap = loop.startProjectSession(null)
    release()
    await swap
    await turn
    const chats = listChats(join(home, slug))
    expect(chats).toHaveLength(1)
    const t = readTranscript(join(home, slug), chats[0].file)!
    const last = t.messages[t.messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.aborted).toBe(true)
    expect(last.content[0].text).toBe('Partial answ')
    expect(t.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(loop.currentProject()).toBeNull()
    expect(getProjectToolContext()).toBeNull()
    expect(loop.getMessages()).toEqual([])
    expect(loop.isProcessing).toBe(false)
  }, 60000)

  it('a Write outside the project is refused as dangerous and never asked', async () => {
    const { home, slug } = await project('Fence', '')
    const { loop, events } = makeLoop({
      script: [
        [{ type: 'tool_use', name: 'Write', input: { file_path: '../other/x.md', content: 'x' } }],
        [{ type: 'text', text: 'I could not write there.' }],
      ],
    })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    await loop.handleUserMessage('write a note in the other project')
    const chats = listChats(join(home, slug))
    const t = readTranscript(join(home, slug), chats[0].file)!
    const resultMsg = t.messages.find(m => m.role === 'user' && m.content.some(c => c.type === 'tool_result'))!
    expect(resultMsg).toBeDefined()
    const result = resultMsg.content.find(c => c.type === 'tool_result') as any
    const text = Array.isArray(result.content) ? result.content.map((c: any) => c.text).join('') : String(result.content)
    expect(text.startsWith('Refused: outside the project folder')).toBe(true)
    expect(result.is_error).toBe(true)
    expect(events.some(e => e.type === 'approval.request')).toBe(false)
    // user message, the Write call, its refused result, then the reply
    // The first four only: after a tool-using turn the coding loop's no-tool
    // nudges still fire in a project chat (not switched by this task), and
    // their replies land in the transcript after these.
    expect(t.messages.slice(0, 4).map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  }, 60000)

  it('startProjectSession(null) restores the coding prompt and tools', async () => {
    const { home, slug } = await project('Back', '')
    const { loop, calls, events } = makeLoop({ script: [[{ type: 'text', text: 'hi' }]] })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    await loop.startProjectSession(null)
    expect(loop.currentProject()).toBeNull()
    expect(events.filter(e => e.type === 'project.opened').map(e => e.slug)).toEqual([slug, null])
    await loop.handleUserMessage('hello there')
    expect(calls[0].systemPrompt).toContain('MANDATORY FIRST STEP')
    expect(calls[0].systemPrompt).not.toContain('<PROJECT>')
    expect(offered(loop).has('CodeIndex')).toBe(true)
    expect(offered(loop).has('ProjectSearch')).toBe(false)
    expect(calls[0].systemPrompt).toContain('- CodeIndex:')
    // nothing was written to the project once it was closed
    expect(listChats(join(home, slug))).toHaveLength(0)
  }, 60000)
})
