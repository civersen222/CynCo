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

/*
 * Downloads always require the user (2026-08-26 directive): CynCo MAY fetch
 * from the internet, but never on its own signature. Auto-approve — including
 * the mission driver's approve-all — must not cover a network fetch, because
 * an unattended run would otherwise pull arbitrary bytes with nobody watching.
 * Package managers are included on purpose: `pip install` is a download with
 * extra steps. Unattended missions get a refusal that names the staging path,
 * which is the sanctioned route (assets staged by the operator, brief copies
 * them in).
 */
const DOWNLOAD_COMMANDS = [
  'curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod',
  'start-bitstransfer', 'bitsadmin', 'certutil',
]
const PACKAGE_FETCHES = [
  /\bpip3?\s+install\b/, /\bpip3?\s.*-m\s+pip\s+install\b/, /\bpython3?\s+-m\s+pip\s+install\b/,
  /\bnpm\s+(install|i|add|ci)\b/, /\bbun\s+(install|add)\b/, /\byarn\s+(add|install)\b/,
  /\bcargo\s+(add|install)\b/, /\buv\s+pip\s+install\b/,
]

/** A Bash command that would fetch bytes from the network. */
export function isDownloadCommand(command: string): boolean {
  const lower = command.toLowerCase()
  const words = lower.split(/[\s;|&()]+/)
  if (DOWNLOAD_COMMANDS.some(c => words.includes(c))) return true
  return PACKAGE_FETCHES.some(re => re.test(lower))
}

export const DOWNLOAD_REFUSAL =
  'Downloads require explicit user approval and none is available in this run. '
  + 'If the mission needs a file from the internet, check whether it is already staged '
  + '(the brief will say where, typically under ~/.cynco/staging/) and copy it from there. '
  + 'Otherwise, state in your reply exactly what you need and why, so the operator can '
  + 'stage or approve it.'

export function getToolRisk(toolName: string): 'low' | 'medium' | 'high' {
  const highRisk = ['Bash', 'SubAgent']
  const medRisk = ['Write', 'Edit', 'Git', 'NotebookEdit']
  if (highRisk.includes(toolName)) return 'high'
  if (medRisk.includes(toolName)) return 'medium'
  return 'low'
}
