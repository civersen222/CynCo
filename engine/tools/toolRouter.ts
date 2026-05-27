import type { ToolImpl } from './types.js'

export const TOOL_CATEGORIES: Record<string, string[]> = {
  read: ['Read', 'Glob', 'Grep', 'Ls', 'CodeIndex'],
  write: ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'],
  search: ['Grep', 'Glob', 'WebSearch', 'WebFetch', 'IndexResearch'],
  execute: ['Bash', 'Git'],
  agent: ['SpawnAgent', 'CollectAgent'],
  all: [],
}

export const CATEGORY_SELECTOR_TOOL = {
  name: 'select_category',
  description: 'Select which category of tools you need for this step. Pick the most relevant category.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: Object.keys(TOOL_CATEGORIES),
        description: 'Tool category: read (view files), write (edit files), search (find code/web), execute (run commands), agent (spawn helpers), all (everything)',
      },
    },
    required: ['category'],
  },
}

export function getToolsForCategory(category: string, allTools: ToolImpl[]): ToolImpl[] {
  if (category === 'all') return allTools
  const names = TOOL_CATEGORIES[category]
  if (!names) return allTools
  const nameSet = new Set(names)
  return allTools.filter(t => nameSet.has(t.name))
}

export function shouldUseRouting(contextLength: number): boolean {
  return contextLength <= 65536 // Active for all local models (saves ~2000 schema tokens)
}
