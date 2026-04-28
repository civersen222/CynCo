/**
 * Vibe Guardian — risk classification for tool calls.
 *
 * Deterministic pattern matching on tool names and inputs.
 * No LLM needed — this is a fast pre-execution check.
 *
 * Risk levels:
 *   - safe: execute normally
 *   - risky: warn beginners, execute for others
 *   - dangerous: auto-block for beginners, warn for intermediate
 *
 * See spec: docs/superpowers/specs/2026-04-17-vibe-wizard-design.md §6
 */

export type RiskLevel = 'safe' | 'risky' | 'dangerous'

/** Patterns that indicate dangerous Bash commands. */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brm\s+-r\b/i,
  /\brm\s+--recursive\b/i,
  /\brmdir\s+\/\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]\b/i,
]

/** Patterns that indicate risky Bash commands. */
const RISKY_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bnpm\s+publish\b/i,
  /\bpip\s+install\b/i,
  /\bnpm\s+install\b/i,
  /\byarn\s+add\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bcurl\b.*\|\s*sh\b/i,
  /\bwget\b.*\|\s*sh\b/i,
  /\bsudo\b/i,
]

/**
 * Classify the risk level of a tool call.
 *
 * @param toolName - The name of the tool being called
 * @param toolInput - The tool's input parameters
 * @returns Risk level: 'safe', 'risky', or 'dangerous'
 */
export function classifyRisk(
  toolName: string,
  toolInput: Record<string, unknown>,
): RiskLevel {
  // Read, Grep, Glob are always safe — they don't modify anything
  if (['Read', 'Grep', 'Glob', 'Ls'].includes(toolName)) {
    return 'safe'
  }

  // Edit is always safe — it's targeted and reversible
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    return 'safe'
  }

  // Write: risky if overwriting an existing file
  if (toolName === 'Write') {
    // We can't know if the file exists without checking, so conservatively
    // treat all writes as safe (the model uses Write for new files too)
    return 'safe'
  }

  // Bash: check command string against patterns
  if (toolName === 'Bash') {
    const command = String(toolInput.command ?? '')
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) return 'dangerous'
    }
    for (const pattern of RISKY_PATTERNS) {
      if (pattern.test(command)) return 'risky'
    }
    return 'safe'
  }

  // Unknown tools: safe by default
  return 'safe'
}

/**
 * Generate a plain-language description of why an action is risky.
 *
 * @param toolName - The tool name
 * @param toolInput - The tool's input
 * @param risk - The classified risk level
 * @returns Human-readable warning string
 */
export function describeRisk(
  toolName: string,
  toolInput: Record<string, unknown>,
  risk: RiskLevel,
): string {
  if (risk === 'safe') return ''

  const command = String(toolInput.command ?? '').slice(0, 100)

  if (risk === 'dangerous') {
    if (/\brm\b/i.test(command)) {
      return `The AI wants to delete files (${command}). This could permanently remove your work.`
    }
    if (/\bgit\s+reset\s+--hard\b/i.test(command)) {
      return `The AI wants to discard all uncommitted changes. This cannot be undone.`
    }
    if (/\bdrop\b/i.test(command)) {
      return `The AI wants to delete a database table. This would destroy data.`
    }
    return `The AI wants to run a potentially destructive command: ${command}`
  }

  // risky
  if (/\bgit\s+push\b/i.test(command)) {
    return `The AI wants to push code to a remote server. Others may see these changes.`
  }
  if (/\b(npm|pip|yarn)\s+(install|add)\b/i.test(command)) {
    return `The AI wants to install packages from the internet: ${command}`
  }
  if (/\bsudo\b/i.test(command)) {
    return `The AI wants to run a command with administrator privileges: ${command}`
  }
  return `The AI wants to run: ${command}`
}
