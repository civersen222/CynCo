import type { GovernanceReport } from '../vsm/types.js'
import type { S5Input, S5Decision, S5Interface, DecisionLogEntry } from './types.js'
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'

const MAX_HISTORY = 100

export type OrchestratorInput = {
  userMessage: string
  activeWorkflow: string | null
  currentPhase: string | null
  contextUsagePercent: number
  governance: GovernanceReport
  recentToolResults: { tool: string; success: boolean }[]
  availableModels: string[]
  turnCount: number
}

export class S5Orchestrator {
  private s5: S5Interface
  private history: DecisionLogEntry[] = []

  constructor(s5: S5Interface) {
    this.s5 = s5
  }

  async makeDecision(input: OrchestratorInput): Promise<S5Decision> {
    const s5Input: S5Input = {
      userMessage: input.userMessage,
      activeWorkflow: input.activeWorkflow,
      currentPhase: input.currentPhase,
      contextUsagePercent: input.contextUsagePercent,
      recentToolResults: input.recentToolResults,
      governanceStatus: input.governance.status,
      s3s4Balance: input.governance.s3s4Balance,
      modelLatencyTrend: input.governance.modelLatencyTrend,
      availableModels: input.availableModels,
      turnCount: input.turnCount,
    }

    const decision = await this.s5.decide(s5Input)

    const entry: DecisionLogEntry = {
      timestamp: Date.now(),
      input: s5Input,
      decision,
    }

    this.history.push(entry)
    if (this.history.length > MAX_HISTORY) {
      this.history.shift()
    }

    // Audit: log S5 decision
    try {
      const { AuditLogger } = require('../audit/auditLogger.js')
      const startMs = Date.now()
      AuditLogger.log('s5-decisions', {
        type: 's5.decision',
        input: { ...s5Input, userMessage: s5Input.userMessage?.slice(0, 200) },
        output: decision,
        applied: {}, // filled by conversationLoop after it processes the decision
        duration_ms: Date.now() - startMs,
      })
    } catch {}

    // S5 decision journal: policy decisions as training data
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: entry.timestamp.toString(),
        system: 'S5',
        input: { ...s5Input, userMessage: s5Input.userMessage?.slice(0, 200) },
        decision: {
          workflow: decision.workflow,
          contextAction: decision.contextAction,
          priority: decision.priority,
          reasoning: decision.reasoning,
        },
      }))
    }

    return decision
  }

  get decisionHistory(): readonly DecisionLogEntry[] {
    return this.history
  }

  setS5(s5: S5Interface): void {
    this.s5 = s5
  }

  get currentS5Name(): string {
    return this.s5.name
  }
}
