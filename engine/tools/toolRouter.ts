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

let routingOverride: boolean | null = null

export function setRoutingEnabled(enabled: boolean | null): void {
  routingOverride = enabled
}

export function isRoutingEnabled(): boolean {
  return routingOverride !== null ? routingOverride : false
}

/**
 * Whether to ATTEMPT two-stage routing. The caller must stop attempting once the
 * model has ignored the selector — see ConversationLoop.routingDeclined.
 *
 * The saving is real but small: the stage-2 call omits the schemas of the tools
 * outside the chosen category, on the order of 2000 tokens, which at a measured
 * ~0.5 ms/token prefill is about 1s. The stage-1 call that buys it costs a full
 * prefill of the whole conversation plus a full generation — 3.1s on average
 * across the 56 stage-1 calls measured on the Gilded UI Wave 1 run. So routing
 * only pays when the model actually narrows; when it does not, this is a pure
 * loss and the caller must stop asking.
 */
export function shouldUseRouting(contextLength: number): boolean {
  if (routingOverride !== null) return routingOverride
  return contextLength <= 65536 // every local model we run
}
