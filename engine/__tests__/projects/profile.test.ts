import { describe, it, expect } from 'bun:test'
import { assembleProjectPrompt, PROJECT_TOOL_NAMES, projectTools } from '../../projects/profile.js'
import { ALL_TOOLS } from '../../tools/registry.js'
import { VSM_GOVERNANCE, MEMORY, TOOL_USE, WORKFLOW, VERSION_CONTROL, CODE_QUALITY } from '../../engine/systemPromptText.js'

const input = { name: 'Front Garden Diorama', description: 'A 1:24 diorama for the front bed.', instructions: 'Metric units. Ask before buying.', toolNames: '- Read: read a file', cwd: 'C:/p/diorama' }

describe('assembleProjectPrompt', () => {
  it('keeps governance and a project memory note, adds the project block, drops the code-shaped sections', () => {
    const text = assembleProjectPrompt(input).join('\n')
    // the governance section, with the chat's own search tool in its variety row
    expect(text).toContain(VSM_GOVERNANCE.replace('CodeIndex, Grep, Glob, Read', 'ProjectSearch, Grep, Glob, Read'))
    expect(text).toContain('Use more diverse tools — ProjectSearch, Grep, Glob, Read')
    // not the engine's MEMORY: it orders SaveLearning, which a project chat lacks
    expect(text).not.toContain(MEMORY)
    expect(text).toMatch(/<MEMORY>\nLearnings from previous sessions appear under "## Learnings from previous sessions"/)
    expect(text).toContain('what you produced earlier in this project is a draft they can overrule')
    expect(text).toContain("belongs in the project's instructions, so suggest the user add it there")
    expect(text).toContain('<PROJECT>')
    expect(text).toContain('Front Garden Diorama')
    expect(text).toContain('A 1:24 diorama for the front bed.')
    expect(text).toContain('## Project instructions\nMetric units. Ask before buying.')
    expect(text).toContain('- Read: read a file')
    expect(text).toContain('Working directory: C:/p/diorama')
    for (const dropped of [TOOL_USE, WORKFLOW, VERSION_CONTROL, CODE_QUALITY]) expect(text).not.toContain(dropped)
    // These two markers are unique to the dropped TOOL_USE/WORKFLOW sections.
    expect(text).not.toMatch(/MANDATORY FIRST STEP|5\. \*\*COMMIT\*\*/)
  })
  // The project prompt used to order SaveLearning (MEMORY) and suggest
  // CodeIndex (the governance variety row), neither of which a project chat
  // offers; the F171 chat's reasoning opened on memory after a correction.
  it('names no tool the project chat does not offer', () => {
    // the <TOOLS> block exactly as the loop builds it (review: an empty
    // toolNames hid Grep's "call CodeIndex first")
    const toolNames = projectTools(ALL_TOOLS).map(t => `- ${t.name}: ${t.description}`).join('\n')
    const text = assembleProjectPrompt({ ...input, toolNames }).join('\n')
    const offered = new Set(PROJECT_TOOL_NAMES)
    const named = ALL_TOOLS.map(t => t.name).filter(n => new RegExp(`\\b${n}\\b`).test(text))
    expect(named.filter(n => !offered.has(n))).toEqual([])
    expect(named).toContain('ProjectSearch')
  })
  it('is byte-identical for identical input (prefix stability) and omits an empty instructions block', () => {
    expect(assembleProjectPrompt(input)).toEqual(assembleProjectPrompt({ ...input }))
    const text = assembleProjectPrompt({ ...input, instructions: '' }).join('\n')
    expect(text).not.toContain('## Project instructions')
  })
  it('names the writable-root rule and the save/add tools', () => {
    const text = assembleProjectPrompt(input).join('\n')
    expect(text).toMatch(/Files: you may read and write only inside this project's folder\./)
    expect(text).toContain("ask them to add it to the project's Knowledge")
    expect(text).toContain('do not try to read it from its original location')
    expect(text).toContain('SaveArtifact only when the user asked for the document')
    expect(text).toContain('AddToKnowledge files it with its URL')
  })
  it('is clarify-first and saves only with consent (projects-fix-1 C)', () => {
    const text = assembleProjectPrompt(input).join('\n')
    expect(text).toContain('Understand before you act')
    expect(text).toContain('ONE focused question per turn, then end your turn and wait')
    // F171: options are drawn with RenderUI, and a request to see them
    // outranks asking first.
    expect(text).toContain('Options are drawn, not written')
    expect(text).toContain('Showing options is not drafting')
    expect(text).toContain('When the user asks to see options, designs, ideas or a comparison, show them now')
    expect(text).toContain('draw the options with RenderUI so the user can click one')
    expect(text).toContain('you show options, designs and comparisons as UI in this chat with RenderUI')
    expect(text).toContain('Save with consent')
    expect(text).toContain('Never save a draft the user has not seen in the chat first')
    expect(text).toContain('this is a conversation, not a mission')
    // the old act-first wording is gone
    expect(text).not.toContain('SaveArtifact it with a clear name')
    // the block opens with the clarify rule
    expect(text).toMatch(/<PROJECT_WORK>\n- Understand before you act\./)
    expect(text).toMatch(/\n<\/PROJECT_WORK>/)
  })
  it('keeps the tool name list', () => {
    expect(PROJECT_TOOL_NAMES).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Ls', 'Bash', 'WebSearch', 'WebFetch', 'ImageView', 'ProjectSearch', 'SaveArtifact', 'AddToKnowledge', 'AskUser', 'RenderUI'])
  })
})
