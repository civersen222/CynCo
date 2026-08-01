import type { GovernanceReport } from '../vsm/types.js'
import type { S5Input, S5Decision, S5Interface, DecisionLogEntry, TaskClass } from './types.js'
import type { DifficultyLevel } from '../vsm/difficultyClassifier.js'
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
import { RuleWeightManager } from './ruleWeights.js'
import { cyncoHome } from '../paths.js'

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
  // Governance signals for S5 enforcement
  varietyBalance?: 'balanced' | 'underload' | 'overload' | 'critical'
  varietyRatio?: number
  homeostatStable?: boolean
  homeostatConsecutiveUnstable?: number
  driftDetected?: boolean
  driftDirection?: 'improving' | 'degrading' | null
  performanceHealth?: 'healthy' | 'warning' | 'critical'
  productivityRatio?: number
  recommendedToolMode?: string | null
  heterarchyAuthority?: 's3' | 's4' | 's5' | null
  promptDifficulty?: DifficultyLevel
  /** P4.5 Phase 3: STATE half of the surfacing triple. taskClass = keyword-classified
   *  request type; loadedTools = currently-loaded tool names. Both feed the P1
   *  proactive-surfacing rule and are journaled for training. */
  taskClass?: TaskClass | null
  loadedTools?: string[]
  /** Canonical session id — the join key for the decision-journal → outcome join. */
  sessionId?: string
}

export class S5Orchestrator {
  private s5: S5Interface
  private history: DecisionLogEntry[] = []
  private ruleWeights: RuleWeightManager | null = null
  private lastDecision: {
    decisionId: string
    ruleIds: string[]
    stuckTurnsBefore: number | null
    toolSuccessRateBefore: number | null
  } | null = null

  constructor(s5: S5Interface) {
    this.s5 = s5
    try {
      const os = require('os')
      const path = require('path')
      const dir = path.join(cyncoHome(), 'training')
      this.ruleWeights = new RuleWeightManager(dir)
    } catch {
      // Non-fatal — weights just won't persist
    }
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
      // Governance signals for S5 enforcement
      varietyBalance: input.varietyBalance ?? 'balanced',
      varietyRatio: input.varietyRatio ?? 1.0,
      homeostatStable: input.homeostatStable ?? true,
      homeostatConsecutiveUnstable: input.homeostatConsecutiveUnstable ?? 0,
      driftDetected: input.driftDetected ?? false,
      driftDirection: input.driftDirection ?? null,
      performanceHealth: input.performanceHealth ?? 'healthy',
      productivityRatio: input.productivityRatio ?? 0.8,
      recommendedToolMode: input.recommendedToolMode ?? null,
      heterarchyAuthority: input.heterarchyAuthority ?? null,
      agreementRatio: (input.governance as any).agreementRatio ?? 1.0,
      observerDivergence: (input.governance as any).observerDivergence ?? null,
      taskError: input.governance.taskError,
      errorTrend: input.governance.errorTrend,
      fingerprintAlarm: input.governance.fingerprintAlarm,
      infoGain: input.governance.infoGain,
      progressRate: input.governance.progressRate,
      explorationState: input.governance.explorationState,
      demotedTools: [],
      promptDifficulty: input.promptDifficulty ?? 'unknown',
      taskClass: input.taskClass ?? null,
      loadedTools: input.loadedTools ?? [],
      governance: input.governance as Record<string, unknown>,
    }

    const decision = await this.s5.decide(s5Input)

    if (decision.decisionId && (decision.ruleIds?.length ?? 0) > 0) {
      const gov = input.governance as Record<string, unknown> | undefined
      this.lastDecision = {
        decisionId: decision.decisionId,
        ruleIds: decision.ruleIds ?? [],
        // null, not 0/1.0. These are the "before" half of a delta that becomes a
        // training label; a fabricated baseline produces a fabricated label. The
        // old `?? 1.0` on success rate biased every unreported turn toward
        // "positive", which is the worst direction for a reward signal to lean.
        stuckTurnsBefore: typeof gov?.stuckTurns === 'number' ? gov.stuckTurns : null,
        toolSuccessRateBefore: typeof gov?.toolSuccessRate === 'number' ? gov.toolSuccessRate : null,
      }
    }

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
    } catch (e) { console.log(`[s5] audit log failed: ${e instanceof Error ? e.message : String(e)}`) }

    // S5 decision journal: policy decisions as training data
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: input.sessionId ?? process.env.LOCALCODE_SESSION_ID ?? entry.timestamp.toString(),
        system: 'S5',
        input: { ...s5Input, userMessage: s5Input.userMessage?.slice(0, 200) },
        decision: {
          workflow: decision.workflow,
          contextAction: decision.contextAction,
          priority: decision.priority,
          reasoning: decision.reasoning,
          // ACTION half of the (state, surfaced-tools, outcome) triple. STATE
          // (taskClass, loadedTools) rides in `input`; OUTCOME is backfilled by
          // evaluateLastDecision, keyed on decisionId. Always present ([] when
          // nothing surfaced) so the exporter sees a stable schema.
          surfaceTools: decision.surfaceTools ?? [],
          model: decision.model,
          tools: decision.tools,
          // The join key for the outcome backfill. Without it the record cannot be
          // matched to its own result: makeJournalEntry stamps its own Date.now(),
          // so the caller never learns the line's timestamp.
          decisionId: decision.decisionId ?? null,
          // Which rules produced this, and which fired and were overridden. The
          // losers are the only negative examples the rule engine generates; the
          // winners are what makes them interpretable. Both were dropped here
          // until now, so every journaled S5 line was unattributable.
          ruleIds: decision.ruleIds ?? [],
          rejected: decision.rejected ?? [],
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

  evaluateLastDecision(governance: Record<string, unknown>): { decisionId: string; ruleIds: string[]; outcome: 'positive' | 'negative' | 'unknown' } | null {
    if (!this.lastDecision) return null
    const { decisionId, ruleIds, stuckTurnsBefore, toolSuccessRateBefore } = this.lastDecision
    const stuckNow = typeof governance.stuckTurns === 'number' ? governance.stuckTurns : null
    const successNow = typeof governance.toolSuccessRate === 'number' ? governance.toolSuccessRate : null

    // A comparison needs both halves measured. Either side missing means this turn
    // produced no evidence — which is a fact worth recording, and is not the same
    // as evidence that the decision was bad. The previous `?? 0` / `?? 1.0` turned
    // "not reported" into a confident verdict.
    const stuckImproved = stuckTurnsBefore !== null && stuckNow !== null && stuckNow < stuckTurnsBefore
    const successImproved = toolSuccessRateBefore !== null && successNow !== null && successNow > toolSuccessRateBefore + 0.1
    const measurable = (stuckTurnsBefore !== null && stuckNow !== null) ||
      (toolSuccessRateBefore !== null && successNow !== null)

    const outcome: 'positive' | 'negative' | 'unknown' = !measurable
      ? 'unknown'
      : (stuckImproved || successImproved) ? 'positive' : 'negative'

    // Adjust rule weights based on outcome — but never on an unmeasured one, which
    // would move the weights on no information.
    if (this.ruleWeights && outcome !== 'unknown') {
      for (const ruleId of ruleIds) {
        this.ruleWeights.recordOutcome(ruleId, outcome)
      }
    }

    // Backfill the journal so the decision carries its own result. Keyed on
    // decisionId: exact, and unlike the entry timestamp it is known to both sides.
    // Unknown outcomes are written too — the exporter needs to tell "measured and
    // bad" from "never measured", and a missing line cannot say which it was.
    try {
      getJournal()?.backfill('S5', { decisionId }, {
        outcome,
        measured: outcome !== 'unknown',
        ruleIds,
        // The raw deltas ride along so a later reader can re-derive the verdict
        // instead of trusting this function's thresholds. null means not reported.
        stuckTurnsBefore, stuckTurnsAfter: stuckNow,
        toolSuccessRateBefore, toolSuccessRateAfter: successNow,
      })
    } catch (e) { console.log(`[s5] outcome backfill failed: ${e instanceof Error ? e.message : String(e)}`) }

    this.lastDecision = null
    return { decisionId, ruleIds, outcome }
  }

  /** Record user dismissal of a governance recommendation. */
  recordDismissal(ruleIds: string[]): void {
    if (this.ruleWeights) {
      for (const ruleId of ruleIds) {
        this.ruleWeights.recordOutcome(ruleId, 'dismissed')
      }
    }
  }

  /** Save rule weights at session end. */
  saveWeights(): void {
    this.ruleWeights?.save()
  }
}
