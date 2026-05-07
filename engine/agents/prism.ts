/**
 * PRISM persona trimming for agent system prompts.
 *
 * PRISM rules:
 * 1. Role identity under 50 tokens
 * 2. Real job titles only (no "world's best", "expert", superlatives)
 * 3. One role per agent
 * 4. Task instruction at END of prompt (primacy/recency effect)
 */

export type PersonaConfig = {
  role: string        // e.g., "senior software engineer" (< 50 tokens)
  focus: string       // e.g., "codebase exploration and pattern finding"
  constraints?: string[]  // Optional behavioral constraints
}

/**
 * Predefined personas for known agent types.
 * All must pass validatePersona().
 */
export const AGENT_PERSONAS: Record<string, PersonaConfig> = {
  scout: {
    role: 'software engineer',
    focus: 'codebase exploration and pattern finding',
  },
  oracle: {
    role: 'technical researcher',
    focus: 'external documentation and API research',
  },
  kraken: {
    role: 'software engineer',
    focus: 'test-driven implementation',
  },
  spark: {
    role: 'software engineer',
    focus: 'targeted bug fixes and quick changes',
  },
  architect: {
    role: 'software architect',
    focus: 'system design and implementation planning',
  },
  researcher: {
    role: 'research analyst',
    focus: 'multi-source information gathering, evidence evaluation, and synthesis with citations',
  },
}

/** Words that violate the "no superlatives" PRISM rule. Case-insensitive. */
const SUPERLATIVE_WORDS = [
  'best',
  'expert',
  'world',
  'greatest',
  'ultimate',
  'unmatched',
  'unparalleled',
  'leading',
  'top',
  'premier',
  'foremost',
  'superior',
]

/** Maximum token count for role identity (whitespace-separated). */
const MAX_ROLE_TOKENS = 50

/**
 * Build an agent prompt following PRISM rules:
 * - Role at TOP (primacy)
 * - Task instruction at END (recency)
 * - Constraints in between
 *
 * Format:
 * "You are a {role} focused on {focus}.\n\n{constraints}\n\n{taskInstruction}"
 */
export function buildAgentPrompt(persona: PersonaConfig, taskInstruction: string): string {
  const parts: string[] = []

  // Role at the top (primacy effect)
  parts.push(`You are a ${persona.role} focused on ${persona.focus}.`)

  // Constraints in the middle
  if (persona.constraints && persona.constraints.length > 0) {
    parts.push(persona.constraints.join('\n'))
  }

  // Task instruction at the end (recency effect)
  parts.push(taskInstruction)

  return parts.join('\n\n')
}

/**
 * Validate a persona config against PRISM rules.
 * Returns { valid, issues } where issues is an array of human-readable
 * descriptions of what failed.
 */
export function validatePersona(persona: PersonaConfig): { valid: boolean; issues: string[] } {
  const issues: string[] = []

  // Check token count (whitespace-separated words)
  const tokenCount = persona.role.split(/\s+/).filter(t => t.length > 0).length
  if (tokenCount > MAX_ROLE_TOKENS) {
    issues.push(
      `Role exceeds ${MAX_ROLE_TOKENS} token limit (has ${tokenCount} tokens)`,
    )
  }

  // Check for superlatives (case-insensitive)
  const roleLower = persona.role.toLowerCase()
  const foundSuperlatives = SUPERLATIVE_WORDS.filter(word =>
    roleLower.includes(word),
  )
  if (foundSuperlatives.length > 0) {
    issues.push(
      `Role contains superlative language: ${foundSuperlatives.join(', ')}. Use real job titles only.`,
    )
  }

  return {
    valid: issues.length === 0,
    issues,
  }
}
