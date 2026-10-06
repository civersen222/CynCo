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
    expect(text).toMatch(/only inside this project's folder/i)
    expect(text).toContain('SaveArtifact')
    expect(text).toContain('AddToKnowledge')
    expect(PROJECT_TOOL_NAMES).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Ls', 'Bash', 'WebSearch', 'WebFetch', 'ImageView', 'ProjectSearch', 'SaveArtifact', 'AddToKnowledge', 'AskUser'])
  })
})
