import { ALL_TOOLS } from '../tools/registry.js'
import type { ToolImpl } from '../tools/types.js'
import { READONLY_TOOLS, SPECIALIST_TOOLS, type TrustTier, type AgentPersona } from './types.js'

/**
 * What the run that starts a sub-agent may itself do without asking anyone: its tool pin, when
 * it has one, and whether its executor would run a tool unasked.
 *
 * A sub-agent approves its own calls, because it has nobody to ask. So a tool its tier adds to
 * the read-only set is handed on only when the parent could have used it unasked. Without this
 * a researcher started by a run pinned away from the web, or by an owner whose trust profile
 * asks before a fetch, would reach the web behind both.
 */
export interface ParentToolAuthority {
  /** The run's hard tool pin (one-shots, missions); null or absent when the run has none. */
  pin?: readonly string[] | null
  /** `ToolExecutor.runsUnasked` of the run's own executor. */
  runsUnasked(toolName: string): boolean
}

/**
 * The tools a sub-agent is offered and may call.
 *
 * - `readonly`: the read-only set.
 * - `specialist` (the researcher): the read-only set, plus WebSearch and WebFetch where the
 *   parent vouches for them (owner's decision of 2026-11-17, row 22). With no `parent` nothing
 *   is added: a caller that forgets to say what its run may do gets a researcher without the
 *   web, which shows, and not one that reaches it behind a pin, which would not.
 * - `full`: not built. No production caller asks for it and it runs on the read-only set
 *   until writing sub-agents are designed; `makeSubAgentConfig` lists what it would have.
 *
 * The read-only set never consults `parent`: it is what every sub-agent has always had.
 */
export function getToolsForTier(tier: TrustTier, _persona: AgentPersona, parent?: ParentToolAuthority): ToolImpl[] {
  const names = new Set(READONLY_TOOLS)
  if (tier === 'specialist' && parent) {
    for (const name of SPECIALIST_TOOLS) {
      if (names.has(name)) continue
      const pinnedAway = parent.pin != null && !parent.pin.includes(name)
      if (!pinnedAway && parent.runsUnasked(name)) names.add(name)
    }
  }
  return ALL_TOOLS.filter(t => names.has(t.name))
}
