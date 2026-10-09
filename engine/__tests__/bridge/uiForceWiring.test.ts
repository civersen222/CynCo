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
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { genuiOptionsExampleCall } from '../../genui/prompt.js'
import { UI_FORCE_MAX_CALLS } from '../../genui/intent.js'
import { makeLoop, type ScriptBlock } from '../projects/loopScaffold.js'

afterEach(() => {
  setProjectToolContext(null)
  globalContract.clear()
})

const ALIENS = "I think we need to more fully step back you decided also on the story etc. forget all of the decisions you made alone. let's figure out the aliens. work with me and show me a few different designs of the aliens"
const draw: ScriptBlock = { type: 'tool_use', name: 'RenderUI', input: genuiOptionsExampleCall() as unknown as Record<string, unknown> }
const names = (c: { tools: { name: string }[] }) => c.tools.map(t => t.name)

async function projectLoop(script: ScriptBlock[][], model = 'qwen3.8') {
  const home = mkdtempSync(join(tmpdir(), 'cynco-uiforce-'))
  const slug = createProject(home, { name: 'Front Yard Diorama', instructions: '' }).slug
  const made = makeLoop({ script, model })
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
})
