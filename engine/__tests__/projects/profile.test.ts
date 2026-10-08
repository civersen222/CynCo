import { describe, it, expect } from 'bun:test'
import { assembleProjectPrompt, PROJECT_TOOL_NAMES } from '../../projects/profile.js'
import { VSM_GOVERNANCE, MEMORY, TOOL_USE, WORKFLOW, VERSION_CONTROL, CODE_QUALITY } from '../../engine/systemPromptText.js'

const input = { name: 'Front Garden Diorama', description: 'A 1:24 diorama for the front bed.', instructions: 'Metric units. Ask before buying.', toolNames: '- Read: read a file', cwd: 'C:/p/diorama' }

describe('assembleProjectPrompt', () => {
  it('keeps governance and memory, adds the project block, drops the code-shaped sections', () => {
    const text = assembleProjectPrompt(input).join('\n')
    expect(text).toContain(VSM_GOVERNANCE)
    expect(text).toContain(MEMORY)
    expect(text).toContain('<PROJECT>')
    expect(text).toContain('Front Garden Diorama')
    expect(text).toContain('A 1:24 diorama for the front bed.')
    expect(text).toContain('## Project instructions\nMetric units. Ask before buying.')
    expect(text).toContain('- Read: read a file')
    expect(text).toContain('Working directory: C:/p/diorama')
    for (const dropped of [TOOL_USE, WORKFLOW, VERSION_CONTROL, CODE_QUALITY]) expect(text).not.toContain(dropped)
    // "CodeIndex" alone is not used here: VSM_GOVERNANCE (kept verbatim, asserted
    // above) names CodeIndex in its VARIETY WARNING row as an example of tool
    // diversity, so a bare /CodeIndex/ match would fail against the section this
    // same test requires to be present. These two markers are unique to the
    // dropped TOOL_USE/WORKFLOW sections.
    expect(text).not.toMatch(/MANDATORY FIRST STEP|5\. \*\*COMMIT\*\*/)
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
    expect(text).toContain('propose two or three ways to approach it')
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
    expect(PROJECT_TOOL_NAMES).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Ls', 'Bash', 'WebSearch', 'WebFetch', 'ImageView', 'ProjectSearch', 'SaveArtifact', 'AddToKnowledge', 'AskUser'])
  })
})
