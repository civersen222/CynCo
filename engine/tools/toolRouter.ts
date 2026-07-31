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

/**
 * Narrow `offered` to the tools in the routed category.
 *
 * Routing is a token-saving heuristic and every other narrowing in the loop is a
 * policy: the core-by-default tool gate, the workflow phase, the caller pin,
 * trust demotion, and S5's pre-loop restriction. The stage-2 tool list used to
 * be built by calling `getToolsForCategory(category, ALL_TOOLS)` and assigning
 * the result, which is a fresh derivation from the whole registry — so the
 * heuristic silently overruled all five policies, `[s5] ENFORCE` printed and the
 * model got the full tool set on the next line, and on the shipped 65536-token
 * profile that was the default path.
 *
 * Hence an intersection, and hence `offered` is the array being filtered: the
 * caller's definitions carry narrowing the registry entries do not.
 *
 * `conflict` means the router named a category that shares nothing with what
 * policy left offered. The offered set is returned unchanged in that case,
 * because the alternatives are handing the model nothing to act with — it cannot
 * then recover from whatever caused the restriction — or handing it the routed
 * set, which is the discard this function exists to prevent. Governance wins
 * over a heuristic; the caller is expected to say so out loud.
 */
export function applyCategoryRouting<T extends { name: string }>(
  offered: T[],
  routed: { name: string }[],
): { tools: T[]; conflict: boolean } {
  const routedNames = new Set(routed.map(t => t.name))
  const narrowed = offered.filter(t => routedNames.has(t.name))
  if (narrowed.length === 0) return { tools: offered, conflict: offered.length > 0 }
  return { tools: narrowed, conflict: false }
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
