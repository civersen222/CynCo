import type { ToolImpl } from '../types.js'

/**
 * Partition requested tool names into those that exist in the registry and
 * those that do not. Unknown names are ignored (not fatal) so a single typo
 * doesn't block loading the rest.
 *
 * The registry is pulled in via a runtime dynamic `import()` rather than a
 * top-level import: registry.ts imports this tool, so a static import would
 * form a module-load cycle that leaves an undefined slot in ALL_TOOLS
 * depending on entry order. Dynamic import defers resolution to call time,
 * by which point the cycle has fully settled.
 */
export async function resolveRequestedTools(
  names: string[],
): Promise<{ resolved: string[]; unknown: string[] }> {
  const { getToolByName } = await import('../registry.js')
  const resolved: string[] = []
  const unknown: string[] = []
  for (const name of names) {
    if (getToolByName(name)) resolved.push(name)
    else unknown.push(name)
  }
  return { resolved, unknown }
}

/**
 * Meta-tool the model calls to pull load-on-demand (extended) tools into the
 * active set. `execute` only validates and reports — the actual surfacing
 * side-effect (growing the session's LoadedToolSet + emitting a tool-
 * availability block) is performed by the conversation loop, which inspects
 * the `load_tools` call and calls `LoadedToolSet.surface(resolved)`.
 */
export const loadToolsTool: ToolImpl = {
  name: 'load_tools',
  description:
    'Load additional tools into this session so you can call them. Pass the exact tool names you need ' +
    '(the loadable set is listed in the tool-availability block). Once loaded, a tool stays available ' +
    'for the rest of the session.',
  inputSchema: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact registry names of the tools to load.',
      },
    },
    required: ['tools'],
  },
  tier: 'auto',
  core: true,
  execute: async (input) => {
    const raw = (input as { tools?: unknown }).tools
    if (!Array.isArray(raw) || raw.some(n => typeof n !== 'string')) {
      return { output: 'Error: `tools` must be an array of tool-name strings.', isError: true }
    }
    const { resolved, unknown } = await resolveRequestedTools(raw as string[])
    const lines: string[] = []
    if (resolved.length > 0) lines.push(`Loaded: ${resolved.join(', ')}`)
    else lines.push('No known tools requested.')
    if (unknown.length > 0) lines.push(`Ignored (not in registry): ${unknown.join(', ')}`)
    return { output: lines.join('\n'), isError: false }
  },
}
