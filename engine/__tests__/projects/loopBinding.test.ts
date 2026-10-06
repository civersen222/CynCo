import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ensureHistory, commitHistory } from '../../projects/history.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { ingestFile } from '../../projects/ingest.js'
import { openBinding } from '../../projects/binding.js'
import { listChats, readTranscript } from '../../projects/chat.js'
import { RETRIEVAL_TAG } from '../../projects/retrieval.js'
import { getProjectToolContext, setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { globalAskBroker } from '../../tools/askBroker.js'
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
    const { loop, events, calls } = makeLoop({
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
    // user message, the Write call, its refused result, then the reply — and
    // nothing after it: a project turn that ends in prose after a tool call is
    // not re-prompted with the coding loop's "call a tool" nudge or a summary
    // follow-up.
    expect(t.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(calls).toHaveLength(2)
    expect(events.some(e => e.type === 'summary.injected')).toBe(false)
    const injected = (loop.getMessages() as any[]).filter(m => m.role === 'user' && m.content.some((c: any) => c.type === 'text' && /call a tool|CONTINUE WORKING|You MUST call a tool/i.test(c.text)))
    expect(injected).toEqual([])
  }, 60000)

  it('a project turn that ends in prose after a tool call gets exactly one assistant reply, with no re-prompt', async () => {
    const { home, slug } = await project('Prose', '')
    writeFileSync(join(home, slug, 'knowledge', 'n.md'), '# Notes\n\nPaint the base first.\n', 'utf8')
    const { loop, calls } = makeLoop({
      script: [
        [{ type: 'tool_use', name: 'Read', input: { file_path: 'knowledge/n.md' } }],
        [{ type: 'text', text: 'Paint the base first.' }],
      ],
    })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    await loop.handleUserMessage('what goes first?')
    const t = readTranscript(join(home, slug), listChats(join(home, slug))[0].file)!
    const prose = t.messages.filter(m => m.role === 'assistant' && m.content.every(c => c.type === 'text'))
    expect(prose).toHaveLength(1)
    expect(prose[0].content[0].text).toBe('Paint the base first.')
    expect(calls).toHaveLength(2)
  }, 60000)

  it('a project session takes no workspace snapshot: the project repo, its exclude file and the folder are untouched', async () => {
    const { home, slug } = await project('Snap', '')
    const dir = join(home, slug)
    writeFileSync(join(dir, 'knowledge', 'n.md'), '# Notes\n\nPaint the base first.\n', 'utf8')
    await ensureHistory(dir)
    const seeded = await commitHistory(dir, ['.'], 'seed')
    expect(seeded).toEqual({ ok: true })
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    const exclude = join(dir, '.git', 'info', 'exclude')
    const readExclude = () => existsSync(exclude) ? readFileSync(exclude, 'utf8') : null

    const { loop } = makeLoop({
      script: [
        [{ type: 'tool_use', name: 'Read', input: { file_path: 'knowledge/n.md' } }],
        [{ type: 'text', text: 'Paint the base first.' }],
      ],
    })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    // Taken after openBinding, which journals `chat.opened` by design: what is
    // measured is the loop's session switch and turn.
    const before = { log: git('log', '--format=%H'), status: git('status', '--porcelain'), exclude: readExclude() }
    expect(before.log.trim()).not.toBe('')
    await loop.startProjectSession(b.binding, b.messages)
    // opening the session changes nothing a git user can see
    expect(git('log', '--format=%H')).toBe(before.log)
    expect(git('status', '--porcelain')).toBe(before.status)
    expect(readExclude()).toBe(before.exclude)
    expect(existsSync(join(dir, '.cynco-snapshots'))).toBe(false)

    // a turn with a tool batch (the snapshot track point) adds only its chat transcript
    await loop.handleUserMessage('what goes first?')
    expect(git('log', '--format=%H')).toBe(before.log)
    const added = git('status', '--porcelain').split('\n').filter(Boolean).filter(l => !before.status.includes(l))
    expect(added.filter(l => !/^\?\? chats\//.test(l))).toEqual([])
    expect(readExclude()).toBe(before.exclude)
    expect(existsSync(join(dir, '.cynco-snapshots'))).toBe(false)
    expect(loop.undoLastBatch().ok).toBe(false)
  }, 60000)

  it('an unfinished coding contract does not follow the user into a project chat', async () => {
    const { home, slug } = await project('Clean', '')
    const { loop, calls } = makeLoop({ script: [[{ type: 'text', text: 'Here is the plan.' }]] })
    // An incomplete contract from a coding task in this session.
    globalContract.create('coding task', '', ['File seat.py exists after changes'])
    expect(globalContract.isActive() && !globalContract.isComplete()).toBe(true)
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    expect(globalContract.isActive()).toBe(false)
    await loop.handleUserMessage('draft me a plan')
    expect(calls[0].systemPrompt).not.toContain('## Active Contract')
    // the contract tool floor would have restored Bash/ContractAssert*; the set is exactly the project's
    expect([...offered(loop)].sort()).toEqual([...PROJECT_TOOL_NAMES].sort())
    // one prose reply ends the turn: no enforcement re-prompt, no "Contract unresolved"
    expect(calls).toHaveLength(1)
    const t = readTranscript(join(home, slug), listChats(join(home, slug))[0].file)!
    expect(t.messages.map(m => m.role)).toEqual(['user', 'assistant'])
  }, 60000)

  it('a switch during a pending AskUser question completes promptly and the aborted turn is transcribed', async () => {
    const { home, slug } = await project('Ask', '')
    const { loop, events } = makeLoop({
      script: [[{ type: 'tool_use', name: 'AskUser', input: { question: 'Which colour for the base?' } }]],
    })
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    const turn = loop.handleUserMessage('paint the base')
    const deadline = Date.now() + 20000
    while (!events.some(e => e.type === 'ask.request')) {
      if (Date.now() > deadline) throw new Error('AskUser never asked')
      await new Promise(r => setTimeout(r, 10))
    }
    const started = Date.now()
    await loop.startProjectSession(null)
    await turn
    expect(Date.now() - started).toBeLessThan(10000) // not the broker's 300 s timeout
    expect(globalAskBroker.pendingCount).toBe(0)
    expect(loop.currentProject()).toBeNull()
    const t = readTranscript(join(home, slug), listChats(join(home, slug))[0].file)!
    expect(t.messages.slice(0, 2).map(m => m.role)).toEqual(['user', 'assistant'])
    const resultMsg = t.messages.find(m => m.role === 'user' && m.content.some(c => c.type === 'tool_result'))!
    expect(resultMsg).toBeDefined()
    const result = resultMsg.content.find(c => c.type === 'tool_result') as any
    const text = Array.isArray(result.content) ? result.content.map((c: any) => c.text).join('') : String(result.content)
    expect(text).toContain('Question withdrawn before the user answered (the user switched to another conversation)')
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
