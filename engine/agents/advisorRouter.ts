/**
 * VSM Advisor System — Beer's Viable System Model as live model advisors.
 *
 * Each VSM system (S2, S3, S3*, S4, S5) is an actual model inference call
 * that monitors the system state and provides advice to the executor.
 * NOT keyword matching. Actual intelligence observing the system.
 *
 * Architecture (Beer's VSM):
 *   S2 (Coordination):  Detects conflicts between operations
 *   S3 (Operations):    Manages resource allocation, tool selection
 *   S3* (Audit):        Spot-checks output quality, catches confident errors
 *   S4 (Intelligence):  Classifies task domain, scans environment
 *   S5 (Policy):        Maintains identity, enforces expertise level
 *
 * Each advisor:
 *   - Receives the full conversation state + metrics
 *   - Has a VSM-specific system prompt defining its role
 *   - Produces advice injected into executor context
 *   - Fires based on CONDITIONS, not every turn
 */

// ─── VSM System Definitions ──────────────────────────────────

export type VSMSystem = 'S2' | 'S3' | 'S3star' | 'S4' | 'S5'

export interface AdvisorConfig {
  system: VSMSystem
  name: string
  role: string
  systemPrompt: string
  /** When should this advisor fire? Returns true if the advisor should be consulted. */
  shouldFire: (state: SystemState) => boolean
}

export interface SystemState {
  turnCount: number
  toolsUsedThisTurn: string[]
  toolsUsedTotal: string[]
  toolFailureRate: number
  varietyBalance: string  // from cybernetics engine
  stuckTurns: number
  contextUtilization: number
  expertise: string  // beginner | intermediate | advanced
  lastUserMessage: string
  conversationLength: number
}

export interface AdvisorAdvice {
  system: VSMSystem
  name: string
  advice: string
}

// ─── VSM Advisor Definitions ─────────────────────────────────

const ADVISORS: AdvisorConfig[] = [
  {
    system: 'S4',
    name: 'Intelligence (S4)',
    role: 'Environment scanning — understands what the user needs',
    systemPrompt:
      'You are System 4 (Intelligence) in a Viable System Model. '
      + 'Your role is to scan the environment — understand what the user is really asking for, '
      + 'what domain this falls in, what expertise is needed, and what approach will work best.\n\n'
      + 'Given the user\'s message and the current system state, provide:\n'
      + '1. What domain is this task? (coding, writing, data, devops, design, general)\n'
      + '2. What specific expertise does this task need?\n'
      + '3. What approach should the executor take?\n'
      + '4. What pitfalls should it watch for?\n\n'
      + 'Be specific and concise. Under 100 words. Your advice will be injected into the executor\'s context.',
    shouldFire: (state) => {
      // Fire on first turn, or when user message is long/complex
      return state.turnCount <= 1
        || state.lastUserMessage.length > 200
        || state.conversationLength <= 2
    },
  },
  {
    system: 'S3',
    name: 'Operations (S3)',
    role: 'Resource allocation — which tools to use, how to use context',
    systemPrompt:
      'You are System 3 (Operations Management) in a Viable System Model. '
      + 'Your role is internal resource allocation — advising on which tools to use, '
      + 'how to manage context window budget, and when to compact.\n\n'
      + 'Given the current tool usage pattern and context utilization, advise:\n'
      + '1. Are the right tools being used? Should different tools be tried?\n'
      + '2. Is context being used efficiently? Should we compact?\n'
      + '3. Are there resource allocation issues?\n\n'
      + 'Be specific. Under 80 words.',
    shouldFire: (state) => {
      // Fire when variety is mismatched or context is getting full
      return state.varietyBalance === 'overload'
        || state.varietyBalance === 'critical'
        || state.contextUtilization > 0.6
        || state.toolFailureRate > 0.3
    },
  },
  {
    system: 'S3star',
    name: 'Audit (S3*)',
    role: 'Quality spot-check — is the output actually correct?',
    systemPrompt:
      'You are System 3* (Audit) in a Viable System Model. '
      + 'Your role is to spot-check quality — verify the executor is actually doing what was asked, '
      + 'catch cases where it might be confidently wrong, and flag when output quality is degrading.\n\n'
      + 'Given the recent tool calls and their results, assess:\n'
      + '1. Is the executor on track to accomplish the user\'s goal?\n'
      + '2. Any signs of confident-but-wrong behavior?\n'
      + '3. Is output quality degrading (repetition, shallow responses)?\n\n'
      + 'Only flag real concerns. Under 60 words. Say "No concerns" if everything looks fine.',
    shouldFire: (state) => {
      // Fire every 5 turns, or when stuck, or when failure rate is high
      return state.turnCount > 0 && state.turnCount % 5 === 0
        || state.stuckTurns >= 2
        || state.toolFailureRate > 0.5
    },
  },
  {
    system: 'S2',
    name: 'Coordination (S2)',
    role: 'Anti-oscillation — detect conflicting operations',
    systemPrompt:
      'You are System 2 (Coordination) in a Viable System Model. '
      + 'Your role is anti-oscillation — detect when the executor is doing contradictory things, '
      + 'undoing its own work, or oscillating between approaches.\n\n'
      + 'Given the recent tool call sequence, flag:\n'
      + '1. Is the executor editing the same file repeatedly? (doom loop)\n'
      + '2. Is it undoing previous changes?\n'
      + '3. Is it oscillating between approaches?\n\n'
      + 'Only flag real oscillation. Under 50 words. Say "No oscillation" if fine.',
    shouldFire: (state) => {
      // Fire when same tool used repeatedly or when stuck
      const toolCounts = new Map<string, number>()
      for (const t of state.toolsUsedTotal.slice(-10)) {
        toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1)
      }
      const maxRepeat = Math.max(...Array.from(toolCounts.values()), 0)
      return maxRepeat >= 4 || state.stuckTurns >= 2
    },
  },
  {
    system: 'S5',
    name: 'Policy (S5)',
    role: 'Identity and values — enforce expertise level and safety',
    systemPrompt:
      'You are System 5 (Policy) in a Viable System Model. '
      + 'Your role is maintaining system identity — ensuring behavior matches the user\'s '
      + 'expertise level, safety requirements, and project goals.\n\n'
      + 'Given the current expertise level and system state, advise:\n'
      + '1. Is the executor respecting the user\'s expertise level?\n'
      + '2. Are safety guardrails appropriate?\n'
      + '3. Any policy-level concerns?\n\n'
      + 'Under 50 words. Say "Policy OK" if no concerns.',
    shouldFire: (state) => {
      // Fire when expertise is beginner (extra oversight) or when critical
      return state.expertise === 'beginner'
        || state.varietyBalance === 'critical'
    },
  },
]

// ─── Advisor Orchestrator ─────────────────────────────────────

/**
 * Determine which advisors should fire given current system state.
 * Returns the list of advisors that should be consulted.
 */
export function getActiveAdvisors(state: SystemState): AdvisorConfig[] {
  return ADVISORS.filter(a => a.shouldFire(state))
}

/**
 * Build the advisor query for a specific VSM system.
 * The caller sends this to the model via wizard.query and gets advice back.
 */
export function buildAdvisorQuery(
  advisor: AdvisorConfig,
  state: SystemState,
): { systemPrompt: string; prompt: string } {
  const stateContext = [
    `Turn: ${state.turnCount}`,
    `Tools used this turn: ${state.toolsUsedThisTurn.join(', ') || 'none'}`,
    `Recent tools: ${state.toolsUsedTotal.slice(-10).join(', ') || 'none'}`,
    `Tool failure rate: ${(state.toolFailureRate * 100).toFixed(0)}%`,
    `Variety balance: ${state.varietyBalance}`,
    `Stuck turns: ${state.stuckTurns}`,
    `Context: ${(state.contextUtilization * 100).toFixed(0)}% used`,
    `Expertise: ${state.expertise}`,
    `User message: ${state.lastUserMessage.slice(0, 300)}`,
  ].join('\n')

  return {
    systemPrompt: advisor.systemPrompt,
    prompt: `Current system state:\n${stateContext}\n\nProvide your ${advisor.role} assessment:`,
  }
}

/**
 * Format multiple advisor responses into a system prompt section.
 */
export function formatAdvisorAdvice(advice: AdvisorAdvice[]): string {
  if (advice.length === 0) return ''

  const lines = ['## VSM Advisor Guidance']
  for (const a of advice) {
    lines.push(`\n### ${a.name}`)
    lines.push(a.advice)
  }
  return lines.join('\n')
}

/**
 * Get all advisor definitions (for display/debugging).
 */
export function getAdvisors(): AdvisorConfig[] {
  return ADVISORS
}
