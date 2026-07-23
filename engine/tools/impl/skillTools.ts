// engine/tools/impl/skillTools.ts
// run_skill / list_skills — the skill meta-tools. Both are core (always
// offered). run_skill loads a skill's prose body into context; the conversation
// loop separately surfaces the skill's declared tools[] through the same
// load-tools channel (see conversationLoop surface handling). These tools read
// the skill store via dynamic import to avoid a cycle back into the loop.

import type { ToolImpl } from '../types.js'

export const runSkillTool: ToolImpl = {
  name: 'run_skill',
  description:
    'Load a skill into this session: its full instructions enter the conversation and its declared tools become available. Pass the exact skill name (see the skill-index block). Use this when a named workflow (e.g. tdd, debug, review) fits the task.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Exact name of the skill to run.' } },
    required: ['name'],
  },
  tier: 'auto',
  core: true,
  execute: async (input) => {
    const name = (input as { name?: unknown }).name
    if (typeof name !== 'string' || name.trim() === '') {
      return { output: 'Error: `name` must be a skill-name string.', isError: true }
    }
    const { getSkillByName } = await import('../../skills/store.js')
    const skill = getSkillByName(name)
    if (!skill) return { output: `Error: unknown skill "${name}".`, isError: true }

    const { readSkillBody } = await import('../../skills/loader.js')
    const body = readSkillBody(skill.bodyPath)
    const toolsLine =
      skill.frontmatter.tools.length > 0
        ? `\n\n(Tools now available for this skill: ${skill.frontmatter.tools.join(', ')})`
        : ''
    return { output: `# Skill: ${skill.frontmatter.name}\n\n${body}${toolsLine}`, isError: false }
  },
}

export const listSkillsTool: ToolImpl = {
  name: 'list_skills',
  description:
    'List every skill available in this session with its one-line description. Use run_skill to load one.',
  inputSchema: { type: 'object', properties: {} },
  tier: 'auto',
  core: true,
  execute: async () => {
    const { getSkillIndex } = await import('../../skills/store.js')
    const index = getSkillIndex()
    if (index.length === 0) return { output: 'No skills are available.', isError: false }
    const lines = index.map(e => `- ${e.name} (${e.source}): ${e.description}`)
    return { output: `Available skills:\n${lines.join('\n')}`, isError: false }
  },
}
