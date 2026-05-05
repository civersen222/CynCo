import { randomBytes } from 'crypto'

// ─── Persona & Trust ──────────────────────────────────────────────────────────

export type AgentPersona = 'scout' | 'oracle' | 'kraken' | 'spark' | 'architect' | 'researcher'

export type TrustTier = 'readonly' | 'specialist' | 'full'

// ─── Sub-agent config ─────────────────────────────────────────────────────────

export interface SubAgentConfig {
  id: string
  task: string
  persona: AgentPersona
  trustTier: TrustTier
  policyConstraints: {
    allowedTools: string[]
    scopePaths?: string[]
    maxIterations: number
    maxTokenBudget: number
  }
  parentContext?: string
}

// ─── Sub-agent status ─────────────────────────────────────────────────────────

export interface SubAgentStatus {
  id: string
  persona: AgentPersona
  task: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'killed'
  currentTurn: number
  maxTurns: number
  tokensUsed: number
  startTime: number
  endTime?: number
}

// ─── Sub-agent result ─────────────────────────────────────────────────────────

export interface SubAgentResult {
  agentId: string
  success: boolean
  output: string
  turns: number
  tokensUsed: number
  governanceMetrics: {
    toolCalls: number
    toolErrors: number
    stuckTurns: number
    compactions: number
  }
}

// ─── S2 coordination types ────────────────────────────────────────────────────

export type S2DecisionType = 'schedule' | 'conflict' | 'algedonic'

export type S2Action = 'run' | 'queue' | 'wait' | 'absorb' | 'escalate' | 'kill'

export interface S2Decision {
  timestamp: number
  type: S2DecisionType
  agentId: string
  input: {
    gpuUtil: number
    queueDepth: number
    fileLocks: string[]
    signal?: string
  }
  decision: S2Action
  reasoning: string
}

export interface S2State {
  activeAgents: Map<string, SubAgentStatus>
  fileLocks: Map<string, string>
  gpuUtilization: number
  queueDepth: number
  decisions: S2Decision[]
}

// ─── Default tool sets per tier ───────────────────────────────────────────────

const READONLY_TOOLS: string[] = ['Read', 'Glob', 'Grep', 'CodeIndex', 'Ls', 'ImageView', 'Git']

const SPECIALIST_TOOLS: string[] = [...READONLY_TOOLS, 'WebSearch', 'WebFetch']

// Defaults for iterations and token budget indexed by trust tier
const TIER_DEFAULTS: Record<TrustTier, { maxIterations: number; maxTokenBudget: number }> = {
  readonly:   { maxIterations: 10, maxTokenBudget: 8192  },
  specialist: { maxIterations: 25, maxTokenBudget: 16384 },
  full:       { maxIterations: 50, maxTokenBudget: 32768 },
}

// ─── Factory functions ────────────────────────────────────────────────────────

export interface MakeSubAgentConfigOpts {
  task: string
  persona: AgentPersona
  trustTier?: TrustTier
  maxIterations?: number
  maxTokenBudget?: number
  parentContext?: string
  scopePaths?: string[]
}

export function makeSubAgentConfig(opts: MakeSubAgentConfigOpts): SubAgentConfig {
  const trustTier = opts.trustTier ?? 'readonly'
  const tierDefaults = TIER_DEFAULTS[trustTier]
  const id = `${opts.persona}-${randomBytes(3).toString('hex')}`

  return {
    id,
    task: opts.task,
    persona: opts.persona,
    trustTier,
    policyConstraints: {
      allowedTools: trustTier === 'readonly'
        ? READONLY_TOOLS
        : trustTier === 'specialist'
          ? SPECIALIST_TOOLS
          : [...SPECIALIST_TOOLS, 'Write', 'Edit', 'Bash'],
      ...(opts.scopePaths !== undefined ? { scopePaths: opts.scopePaths } : {}),
      maxIterations: opts.maxIterations ?? tierDefaults.maxIterations,
      maxTokenBudget: opts.maxTokenBudget ?? tierDefaults.maxTokenBudget,
    },
    ...(opts.parentContext !== undefined ? { parentContext: opts.parentContext } : {}),
  }
}

export function makeS2Decision(opts: Omit<S2Decision, 'timestamp'>): S2Decision {
  return {
    timestamp: Date.now(),
    ...opts,
  }
}
