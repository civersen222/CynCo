/**
 * F171 on the live loop: in a project chat, a message that asks to SEE
 * options, designs or a comparison makes its model calls go out with
 * tool_choice 'required' — with the same system prompt and tool list, so the
 * cached prefix holds — until a RenderUI surface draws; an AskUser call is
 * redirected to RenderUI meanwhile; forcing stops after UI_FORCE_MAX_CALLS
 * calls. An ordinary message, a click, and a coding session are never forced.
 * Before this, Qwen3.8-27B answered "show me a few different designs of the
 * aliens" with four markdown sections and no surface.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { ingestFile } from '../../projects/ingest.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { genuiOptionsExampleCall } from '../../genui/prompt.js'
import { UI_FORCE_MAX_CALLS } from '../../genui/intent.js'
import { makeLoop, type ScriptBlock, type Hold } from '../projects/loopScaffold.js'

afterEach(() => {
  setProjectToolContext(null)
  globalContract.clear()
})

const ALIENS = "I think we need to more fully step back you decided also on the story etc. forget all of the decisions you made alone. let's figure out the aliens. work with me and show me a few different designs of the aliens"
const draw: ScriptBlock = { type: 'tool_use', name: 'RenderUI', input: genuiOptionsExampleCall() as unknown as Record<string, unknown> }
const names = (c: { tools: { name: string }[] }) => c.tools.map(t => t.name)

async function projectLoop(script: ScriptBlock[][], model = 'qwen3.8', hold?: Hold, knowledge?: string) {
  const home = mkdtempSync(join(tmpdir(), 'cynco-uiforce-'))
  const slug = createProject(home, { name: 'Front Yard Diorama', instructions: '' }).slug
  if (knowledge) {
    writeFileSync(join(home, slug, 'knowledge', 'a.md'), knowledge, 'utf8')
    await ingestFile({ home, embed: null, embedModel: 'none' }, slug, 'knowledge', 'a.md', 'pasted')
  }
  const made = makeLoop({ script, model, hold })
  const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
  if (!b.ok) throw new Error(b.reason)
  await made.loop.startProjectSession(b.binding, b.messages)
  return made
}

describe('generative-UI forcing on the live loop (F171)', () => {
  it('"show me a few different designs" forces a tool call until RenderUI draws, then releases', async () => {
    const { loop, calls, events } = await projectLoop([[draw], [{ type: 'text', text: 'Pick the one that feels right.' }]])
    await loop.handleUserMessage(ALIENS)
    expect(calls).toHaveLength(2)
    expect(calls[0].toolChoice).toBe('required')
    expect(names(calls[0])).toContain('RenderUI')
    // after the surface drew, the model may end the turn in words
    expect(calls[1].toolChoice).toBeUndefined()
    // only the grammar changed: same system prompt, same tool list
    expect(calls[1].systemPrompt).toBe(calls[0].systemPrompt)
    expect(names(calls[1])).toEqual(names(calls[0]))
    const final = events.find(e => e?.type === 'ui.render' && !e.partial)
    expect(final?.surfaceId).toBe('path-options')
    expect(final?.spec?.elements?.a?.type).toBe('Card')
    expect((loop as any).uiForce).toBeNull()
  }, 60000)

  it('an AskUser call while forced is not asked; the result points at RenderUI and the next call is still forced', async () => {
    const ask: ScriptBlock = { type: 'tool_use', name: 'AskUser', input: { question: 'Which alien?', options: ['Tall', 'Small', 'Stones'] } }
    const { loop, calls, events } = await projectLoop([[ask], [draw], [{ type: 'text', text: 'Over to you.' }]])
    await loop.handleUserMessage(ALIENS)
    const askDone = events.find(e => e?.type === 'tool.complete' && e.toolName === 'AskUser')
    expect(askDone?.isError).toBe(false)
    expect(String(askDone?.result)).toMatch(/^Not asked: the user asked to see this drawn\. Call RenderUI instead/)
    expect(calls.map(c => c.toolChoice)).toEqual(['required', 'required', undefined])
    expect(events.some(e => e?.type === 'ui.render' && !e.partial && e.spec)).toBe(true)
  }, 60000)

  it(`forcing stops after ${UI_FORCE_MAX_CALLS} forced calls without a surface`, async () => {
    const search: ScriptBlock = { type: 'tool_use', name: 'ProjectSearch', input: { query: 'aliens' } }
    const script = Array.from({ length: UI_FORCE_MAX_CALLS }, () => [search]).concat([[{ type: 'text', text: 'Here are some thoughts.' }]])
    const { loop, calls } = await projectLoop(script)
    await loop.handleUserMessage(ALIENS)
    expect(calls).toHaveLength(UI_FORCE_MAX_CALLS + 1)
    expect(calls.slice(0, UI_FORCE_MAX_CALLS).every(c => c.toolChoice === 'required')).toBe(true)
    expect(calls[UI_FORCE_MAX_CALLS].toolChoice).toBeUndefined()
  }, 60000)

  it('a surface that draws nothing keeps the turn forced so the model can fix it', async () => {
    const empty: ScriptBlock = { type: 'tool_use', name: 'RenderUI', input: { spec: 'nope' } }
    const { loop, calls } = await projectLoop([[empty], [draw], [{ type: 'text', text: 'ok' }]])
    await loop.handleUserMessage(ALIENS)
    expect(calls.map(c => c.toolChoice)).toEqual(['required', 'required', undefined])
  }, 60000)

  it('an ordinary message, a click and the next message after a forced turn go out with tool_choice auto', async () => {
    const { loop, calls } = await projectLoop([[draw], [{ type: 'text', text: 'ok' }], [{ type: 'text', text: 'About a day.' }], [{ type: 'text', text: 'Noted.' }]])
    await loop.handleUserMessage(ALIENS)
    await loop.handleUserMessage('how long does epoxy take to cure?')
    expect(calls[2].toolChoice).toBeUndefined()
    loop.handleUiAction({ type: 'ui.action', surfaceId: 'path-options', action: 'choose', label: 'Choose A', context: { option: 'A' } })
    await (loop as any).currentTurn
    expect(calls).toHaveLength(4)
    expect(calls[3].toolChoice).toBeUndefined()
    expect(String(JSON.stringify(calls[3].messages))).toContain('[UI action]')
  }, 60000)

  it('an unknown model family sends no tools, so nothing is forced on the wire', async () => {
    const { loop, calls } = await projectLoop([[draw], [{ type: 'text', text: 'ok' }]], 'test-model')
    await loop.handleUserMessage(ALIENS)
    expect(calls[0].tools).toEqual([])
    expect(calls[0].toolChoice).toBeUndefined()
  }, 60000)

  it('a coding session that loaded RenderUI is not forced', async () => {
    const load: ScriptBlock = { type: 'tool_use', name: 'load_tools', input: { tools: ['RenderUI'] } }
    const { loop, calls } = makeLoop({ script: [[load], [{ type: 'text', text: 'Some options: A, B.' }]], model: 'qwen3.8' })
    await loop.handleUserMessage('show me some options for the parser design')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(names(calls[1])).toContain('RenderUI')
    expect(calls.every(c => c.toolChoice === undefined)).toBe(true)
  }, 60000)

  // ── final review ───────────────────────────────────────────────────────
  it('a profile that scopes RenderUI out is never forced (the call would have to pick another tool)', async () => {
    const { loop, calls } = await projectLoop([[{ type: 'text', text: 'Here are some thoughts.' }]])
    ;(loop as any).config.tools = { allowed: ['Read', 'Write', 'Edit', 'Bash'] }
    await loop.handleUserMessage(ALIENS)
    expect(calls[0].tools.map(t => t.name)).not.toContain('RenderUI')
    expect(calls[0].toolChoice).toBeUndefined()
  }, 60000)

  it('a FollowUps chip drained at the turn\'s end is forced like the same chip sent idle', async () => {
    let reached!: () => void
    const atHold = new Promise<void>(r => { reached = r })
    let release!: () => void
    const hold: Hold = { call: 1, reached: () => reached(), release: new Promise<void>(r => { release = r }) }
    const { loop, calls } = await projectLoop([[draw], [{ type: 'text', text: 'Pick the one that feels right.' }], [draw], [{ type: 'text', text: 'Darker ones.' }]], 'qwen3.8', hold)
    const turn = loop.handleUserMessage(ALIENS)
    await atHold
    loop.handleUiAction({ type: 'ui.action', surfaceId: 'path-options', action: 'followup', label: 'Show me three darker designs of the aliens', userMessage: 'Show me three darker designs of the aliens' })
    release()
    await turn
    expect(calls.map(c => c.toolChoice)).toEqual(['required', undefined, 'required', undefined])
  }, 60000)

  it('the last forced call\'s AskUser is redirected too; the next call goes out auto', async () => {
    const search: ScriptBlock = { type: 'tool_use', name: 'ProjectSearch', input: { query: 'aliens' } }
    const ask: ScriptBlock = { type: 'tool_use', name: 'AskUser', input: { question: 'Which alien?' } }
    const { loop, calls, events } = await projectLoop([[search], [search], [ask], [{ type: 'text', text: 'Some thoughts.' }]])
    await loop.handleUserMessage(ALIENS)
    expect(calls.map(c => c.toolChoice)).toEqual(['required', 'required', 'required', undefined])
    expect(events.some(e => e?.type === 'ask.request')).toBe(false)
    expect(String(events.find(e => e?.type === 'tool.complete' && e.toolName === 'AskUser')?.result)).toMatch(/^Not asked/)
  }, 60000)

  it('a surface of nothing but unknown-component notes does not release the forcing', async () => {
    const junk: ScriptBlock = { type: 'tool_use', name: 'RenderUI', input: { surface: 'aliens', spec: { root: 'a', elements: { a: { type: 'Grid', children: ['b', 'c'] }, b: { type: 'AlienCard' }, c: { type: 'AlienCard' } } } } }
    const { loop, calls } = await projectLoop([[junk], [draw], [{ type: 'text', text: 'ok' }]])
    await loop.handleUserMessage(ALIENS)
    expect(calls.map(c => c.toolChoice)).toEqual(['required', 'required', undefined])
  }, 60000)

  it('citations inside a drawn surface reach the page like citations in prose', async () => {
    const cited: ScriptBlock = { type: 'tool_use', name: 'RenderUI', input: { surface: 'finishes', spec: { root: 'c', elements: { c: { type: 'Card', props: { title: 'Epoxy finishes' }, children: ['t'] }, t: { type: 'Text', props: { text: 'Epoxy cures in a day [1].' } } } } } }
    const { loop, events } = await projectLoop([[cited], [{ type: 'text', text: 'ok' }]], 'qwen3.8', undefined, '# Resin\n\nEpoxy cures in a day.\n')
    await loop.handleUserMessage('show me a few options for epoxy finishes')
    expect(events.find(e => e?.type === 'project.citations')).toMatchObject({ citations: [{ n: 1, filePath: 'knowledge/a.md' }] })
  }, 60000)

  it('the page\'s "Show as UI" click (a followup ui.action) is forced when it arrives idle', async () => {
    const { loop, calls } = await projectLoop([[draw], [{ type: 'text', text: 'ok' }]])
    loop.handleUiAction({ type: 'ui.action', surfaceId: 'show-as-ui', action: 'followup', label: 'Show as UI', userMessage: 'Show your previous reply as UI with RenderUI: the same content, no new facts. The reply to show is the one that begins: "Design A - The Tall Ones".' })
    await new Promise(r => setTimeout(r, 0))
    await (loop as any).currentTurn
    expect(calls[0].toolChoice).toBe('required')
    expect(JSON.stringify(calls[0].messages)).toContain('Show your previous reply as UI')
  }, 60000)
})
