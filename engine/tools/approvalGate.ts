import { getToolByName } from './registry.js'
import type { ApprovalTier } from './types.js'

// `bashAutoApprove` used to live here: a list of glob patterns that would
// auto-approve matching Bash commands. It could never fire. The only call site
// passes three arguments, so the `bashCommand` parameter it tested was always
// undefined, and nothing in the config loader, the schema or the README could
// set the field in the first place. A trust setting that silently does nothing
// is worse than an absent one — an operator who wrote it would believe Bash was
// being filtered by their patterns when every command was reaching the ordinary
// approval path. Wiring it would have been inventing a way to auto-approve the
// highest-risk tool that nobody asked for, so it is gone instead.
export type ToolTrustProfile = {
  trust?: Record<string, ApprovalTier>
  deny?: string[]
}

export function shouldAutoApprove(
  toolName: string,
  profile: ToolTrustProfile | undefined,
  approveAll = false,
): boolean {
  if (approveAll) return true
  if (profile?.deny?.includes(toolName)) return false
  if (profile?.trust?.[toolName]) {
    return profile.trust[toolName] === 'auto'
  }
  const tool = getToolByName(toolName)
  if (!tool) return false
  return tool.tier === 'auto'
}

export function getToolRisk(toolName: string): 'low' | 'medium' | 'high' {
  const highRisk = ['Bash', 'SubAgent']
  const medRisk = ['Write', 'Edit', 'Git', 'NotebookEdit']
  if (highRisk.includes(toolName)) return 'high'
  if (medRisk.includes(toolName)) return 'medium'
  return 'low'
}
