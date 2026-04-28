import { getToolByName } from './registry.js'
import type { ApprovalTier } from './types.js'

export type ToolTrustProfile = {
  trust?: Record<string, ApprovalTier>
  deny?: string[]
  bashAutoApprove?: string[]  // glob-style patterns for bash commands that auto-approve
}

/** Check if a bash command matches any auto-approve pattern (simple wildcard matching). */
function matchesBashPattern(command: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    // Convert simple glob pattern to regex: * matches any chars
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    if (new RegExp(`^${escaped}$`).test(command.trim())) return true
  }
  return false
}

export function shouldAutoApprove(
  toolName: string,
  profile: ToolTrustProfile | undefined,
  approveAll = false,
  bashCommand?: string,
): boolean {
  if (approveAll) return true
  if (profile?.deny?.includes(toolName)) return false
  // Bash-specific auto-approve via pattern matching
  if (toolName === 'Bash' && bashCommand && profile?.bashAutoApprove?.length) {
    if (matchesBashPattern(bashCommand, profile.bashAutoApprove)) return true
  }
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
