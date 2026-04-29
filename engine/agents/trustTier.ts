import { ALL_TOOLS } from '../tools/registry.js'
import type { ToolImpl } from '../tools/types.js'
import type { TrustTier, AgentPersona } from './types.js'

const READONLY_TOOL_NAMES = new Set([
  'Read', 'Glob', 'Grep', 'CodeIndex', 'Ls', 'ImageView', 'Git',
])

export function getToolsForTier(tier: TrustTier, _persona: AgentPersona): ToolImpl[] {
  if (tier === 'readonly') {
    return ALL_TOOLS.filter(t => READONLY_TOOL_NAMES.has(t.name))
  }
  // Phase 2/3: specialist and full tiers add persona-specific tools.
  // For now, fall back to readonly.
  return ALL_TOOLS.filter(t => READONLY_TOOL_NAMES.has(t.name))
}
