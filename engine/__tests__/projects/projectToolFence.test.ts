/**
 * A project chat is offered PROJECT_TOOL_NAMES and nothing else, and nothing it
 * is shown may name a tool outside that set (review of the F171 follow-ups):
 * the engine's MEMORY ordered SaveLearning, the governance row and Grep's
 * description pointed at CodeIndex, the skill index told it to call run_skill,
 * and the CodeIndex nudge was prepended to its Grep results. Worse, a refused
 * load_tools/run_skill call still ran the surfacing step, which rebuilt the
 * tool list from the coding core set (and a refused run_skill started a
 * workflow) — one remembered call broke the project's tool fence.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { PROJECT_TOOL_NAMES, projectTools } from '../../projects/profile.js'
import { ALL_TOOLS } from '../../tools/registry.js'
import { globalContract } from '../../tools/contract.js'
import { makeLoop, type ScriptBlock } from './loopScaffold.js'

afterEach(() => {
  setProjectToolContext(null)
  globalContract.clear()
})

const offered = new Set(PROJECT_TOOL_NAMES)
const notOffered = (text: string) => ALL_TOOLS.map(t => t.name).filter(n => !offered.has(n) && new RegExp(`\\b${n}\\b`).test(text))

async function boundLoop(script: ScriptBlock[][]) {
  const home = mkdtempSync(join(tmpdir(), 'cynco-fence-'))
  const slug = createProject(home, { name: 'Fence', instructions: '' }).slug
  const made = makeLoop({ script, model: 'qwen3.8' })
  const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
  if (!b.ok) throw new Error(b.reason)
  await made.loop.startProjectSession(b.binding, b.messages)
  return made
}

describe('the project tool fence', () => {
  it('projectTools is the project set, with a Grep description that names no missing tool', () => {
    const tools = projectTools(ALL_TOOLS)
    expect(tools.map(t => t.name).sort()).toEqual([...PROJECT_TOOL_NAMES].sort())
    const grep = tools.find(t => t.name === 'Grep')!
    expect(grep.description).toMatch(/use ProjectSearch/)
    expect(notOffered(tools.map(t => `- ${t.name}: ${t.description}`).join('\n'))).toEqual([])
    // the registry's own Grep is untouched (coding sessions keep CodeIndex-first)
    expect(ALL_TOOLS.find(t => t.name === 'Grep')!.description).toMatch(/CodeIndex/)
  })

  it('on the live loop: the prompt and tool list name no missing tool, a refused load_tools/run_skill changes nothing, Grep gets no CodeIndex nudge', async () => {
    const { loop, calls, events } = await boundLoop([
      [{ type: 'tool_use', name: 'run_skill', input: { name: 'research' } }],
      [{ type: 'tool_use', name: 'load_tools', input: { tools: ['CodeIndex', 'Git'] } }],
      [{ type: 'tool_use', name: 'Grep', input: { pattern: 'zzzz-no-such-text-anywhere' } }],
      [{ type: 'text', text: 'Nothing found.' }],
    ])
    await loop.handleUserMessage('is there anything about the alien height in here?')
    expect(calls).toHaveLength(4)
    expect(notOffered(String(calls[0].systemPrompt))).toEqual([])
    expect(notOffered(calls[0].tools.map((t: any) => `${t.name}: ${t.description}`).join('\n'))).toEqual([])
    // the refused calls surfaced nothing: the same project tool list on every call, no workflow
    const names = (i: number) => calls[i].tools.map(t => t.name)
    expect(names(0).sort()).toEqual([...PROJECT_TOOL_NAMES].sort())
    for (const i of [1, 2, 3]) expect(names(i)).toEqual(names(0))
    expect((loop as any).workflowEngine.isActive).toBe(false)
    for (const n of ['run_skill', 'load_tools']) {
      expect(String(events.find(e => e?.type === 'tool.complete' && e.toolName === n)?.result)).toMatch(/is not available this turn/)
    }
    const grep = events.find(e => e?.type === 'tool.complete' && e.toolName === 'Grep')
    expect(grep).toBeDefined()
    expect(String(grep.result)).not.toMatch(/CodeIndex/)
  }, 60000)
})
