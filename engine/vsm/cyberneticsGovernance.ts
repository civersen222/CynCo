/**
 * Cybernetics-backed governance layer.
 *
 * Replaces hand-rolled counters with the real @cybernetics/core library:
 * - VarietyEngine for Ashby's Law (both sides: task complexity + tool variety)
 * - AlgedonicSignal for pain/pleasure alerts
 * - VSMNode for recursive viable system hierarchy
 * - Beer's variety balance equations for S3/S4
 *
 * Maps to Beer's VSM:
 *   S1 = individual tool executions (operational units)
 *   S2 = tool coordination / conflict detection (anti-oscillation)
 *   S3 = internal resource allocation (which tools, how much context)
 *   S4 = environment scanning (task complexity, user intent classification)
 *   S5 = policy/identity (expertise level, project goals, safety rules)
 */

// Import from the cybernetics library (vendored in-repo)
import {
  variety,
  vsm,
  events,
  NodeId,
} from '../cybernetics-core/src/index.js'
import { getEventBus } from './eventBus.js'
import { importParams } from './governanceParams.js'
import { AlgedonicIntegration } from './algedonicIntegration.js'
import { HomeostatIntegration } from './homeostatIntegration.js'
import { FeedbackControlIntegration, type FeedbackActions } from './feedbackControl.js'
import { PerformanceMetricsIntegration } from './performanceMetrics.js'
import { AutopoiesisIntegration } from './autopoiesisIntegration.js'
import { ConstraintChecksIntegration } from './constraintChecks.js'
import { HeterarchyIntegration } from './heterarchyIntegration.js'
import { ConversationTheoryIntegration } from './conversationTheory.js'
import { ObserverEffectsIntegration } from './observerEffects.js'
import { ConfigPopulation } from './population.js'
import { EssentialVariableRegistry } from './essentialVariables.js'
import { SessionHomeostat } from './sessionHomeostat.js'
import { S4Reflector } from './s4Reflector.js'
import { IdentityGuard } from './identityGuard.js'
import { AutopoiesisVerifier } from './autopoiesisVerifier.js'
import { StrategyMemory } from './strategyMemory.js'

import type { GovernanceReport, GovernanceAlert } from './types.js'
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'

// ─── Task Complexity Estimator (S4: environment scanning) ─────

type TaskType = 'simple_query' | 'file_operation' | 'code_generation' | 'debugging' | 'multi_step' | 'architectural'

function classifyTask(userMessage: string): { type: TaskType; complexity: number } {
  const msg = userMessage.toLowerCase()
  const wordCount = msg.split(/\s+/).length

  // Architectural: mentions design, architecture, refactor, system
  if (/\b(architect|design|refactor|restructur|system|pattern)\b/.test(msg)) {
    return { type: 'architectural', complexity: 8 }
  }
  // Multi-step: mentions multiple actions or "and then"
  if (/\b(and then|first.*then|step \d|multiple|several)\b/.test(msg) || wordCount > 50) {
    return { type: 'multi_step', complexity: 6 }
  }
  // Debugging: mentions error, bug, fix, broken, crash
  if (/\b(error|bug|fix|broken|crash|fail|debug|wrong)\b/.test(msg)) {
    return { type: 'debugging', complexity: 5 }
  }
  // Code generation: mentions create, build, implement, add, write
  if (/\b(create|build|implement|add|write|generate|make)\b/.test(msg)) {
    return { type: 'code_generation', complexity: 4 }
  }
  // File operation: mentions read, edit, file, change
  if (/\b(read|edit|file|change|modify|update|delete|move)\b/.test(msg)) {
    return { type: 'file_operation', complexity: 2 }
  }
  // Simple query
  return { type: 'simple_query', complexity: 1 }
}

// ─── Cybernetics Governance Layer ─────────────────────────────

export class CyberneticsGovernance {
  // Real cybernetics components
  private varietyEngine: InstanceType<typeof variety.VarietyEngine>
  private systemNode: InstanceType<typeof vsm.VSMNode>
  private onAlert?: (alert: GovernanceAlert) => void

  // Event bus — backbone for all cybernetics events
  private eventBus: InstanceType<typeof events.EventBus>
  private nodeId: InstanceType<typeof NodeId>
  // Algedonic — real pain/pleasure signaling with kill switch
  private algedonicIntegration: AlgedonicIntegration
  // Homeostat — Ashby's ultrastable system for S3/S4/context balance
  private homeostatIntegration: HomeostatIntegration
  // Feedback control — PID, context loop, ultrastable system
  private feedbackControl: FeedbackControlIntegration
  private lastFeedbackActions: FeedbackActions | null = null
  // Performance metrics — Achievement + CUSUM drift detection
  private performanceMetrics: PerformanceMetricsIntegration
  // Autopoiesis — self-modification governance
  private autopoiesisIntegration: AutopoiesisIntegration
  // Constraints — autonomy, POSIWID, freedom
  private constraintChecks: ConstraintChecksIntegration
  // Heterarchy — dynamic authority based on context
  private heterarchyIntegration: HeterarchyIntegration
  // Conversation theory — teachback, agreement
  private conversationTheory: ConversationTheoryIntegration
  // Observer effects — measurement divergence, eigenform
  private observerEffects: ObserverEffectsIntegration
  // Autopoietic governance components
  private _population: ConfigPopulation | null = null
  private _registry = new EssentialVariableRegistry()
  private _sessionHomeostat: SessionHomeostat | null = null
  private _reflector = new S4Reflector()
  private _identityGuard = new IdentityGuard()
  private _autopoiesisVerifier = new AutopoiesisVerifier()
  private _activeStrategy: string = ''
  private _strategyMemory: StrategyMemory = new StrategyMemory()
  private _db?: import('./governanceDb.js').GovernanceDB
  private _sessionId = `session-${Date.now()}`

  // Ablation toggle — when true, governance is a no-op passthrough
  private readonly _ablated: boolean

  // Metrics tracking
  private toolHistory: { name: string; success: boolean; latencyMs: number }[] = []
  private turnCount = 0
  private stuckCount = 0
  private lastResponses: string[] = []
  private currentTaskComplexity = 1

  constructor(onAlert?: (alert: GovernanceAlert) => void) {
    this.onAlert = onAlert
    this._ablated = process.env._ABLATION_VSM_DISABLED === '1'
    this.eventBus = getEventBus()
    this.nodeId = new NodeId()

    // Load optimized params if available
    const paramsPath = process.env.LOCALCODE_OPTIMIZED_PARAMS
    if (paramsPath) {
      try {
        const fs = require('fs')
        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf-8'))
        importParams(params, 'optimized-params-file')
        console.log(`[vsm] Loaded optimized params from ${paramsPath}`)
      } catch (e) {
        console.log(`[vsm] Could not load params: ${e}`)
      }
    }
    this.algedonicIntegration = new AlgedonicIntegration(this.nodeId)
    this.homeostatIntegration = new HomeostatIntegration(this.nodeId)
    this.feedbackControl = new FeedbackControlIntegration()
    this.performanceMetrics = new PerformanceMetricsIntegration(this.nodeId)
    this.autopoiesisIntegration = new AutopoiesisIntegration(this.nodeId)
    this.constraintChecks = new ConstraintChecksIntegration(this.nodeId)
    this.heterarchyIntegration = new HeterarchyIntegration()
    this.conversationTheory = new ConversationTheoryIntegration()
    this.observerEffects = new ObserverEffectsIntegration(this.nodeId)

    // Autopoietic: load population if available
    try {
      const os = require('os')
      const path = require('path')
      const popDir = path.join(os.homedir(), '.cynco', 'population')
      const fs = require('fs')
      if (fs.existsSync(path.join(popDir, 'config_00.json'))) {
        this._population = ConfigPopulation.load(popDir)
        this._strategyMemory = StrategyMemory.load(popDir)
        const selected = this._population.selectViable()
        importParams(selected.params, `population-config-${selected.index}`)
        this._activeStrategy = selected.strategy ?? ''
        this._population.maintainVariety(selected.index)
        console.log(`[vsm] Population: selected config_${String(selected.index).padStart(2, '0')} (viable=${selected.viable}, gen=${selected.generation})`)
        if (this._activeStrategy) console.log(`[vsm] Strategy: ${this._activeStrategy.slice(0, 80)}...`)
        const memSummary = this._strategyMemory.getSummaryForReflection()
        if (memSummary) console.log(`[vsm] Memory: ${this._strategyMemory['history'].length} prior sessions`)
      }
    } catch (e) {
      console.log(`[vsm] No population found, using default/optimized params`)
    }
    this._sessionHomeostat = new SessionHomeostat(this._registry)

    // Initialize variety engine — tracks the Ashby balance
    this.varietyEngine = new variety.VarietyEngine()
    this.varietyEngine.setInputCount(1)
    this.varietyEngine.setFilterCount(0)
    this.varietyEngine.setActiveTheories(0)
    this.varietyEngine.recalculate()

    // Initialize VSM node — LocalCode as a viable system
    this.systemNode = new vsm.VSMNode('LocalCode')

    // Initialize governance database for cross-session learning
    try {
      const os = require('os')
      const path = require('path')
      const dbDir = path.join(os.homedir(), '.cynco', 'governance')
      require('fs').mkdirSync(dbDir, { recursive: true })
      const { GovernanceDB } = require('./governanceDb.js')
      this._db = new GovernanceDB(path.join(dbDir, 'governance.db'))
      console.log('[vsm] GovernanceDB initialized')
    } catch (e) {
      console.log(`[vsm] GovernanceDB failed to init: ${e}`)
    }
  }

  onToolResult(name: string, success: boolean, latencyMs: number, _output?: string): void {
    // Reset stuck counter on successful write/edit/bash operations
    // These represent actual progress — the model is doing real work
    if (success && ['Write', 'Edit', 'MultiEdit', 'Bash', 'ApplyPatch'].includes(name)) {
      this.stuckCount = 0
    }

    // Always track basic metrics even when ablated (for measurement)
    this.toolHistory.push({ name, success, latencyMs })
    if (this.toolHistory.length > 50) {
      this.toolHistory = this.toolHistory.slice(-50)
    }
    if (this._ablated) return // Skip all governance when ablated

    // Route through real algedonic channel
    const action = this.algedonicIntegration.recordToolResult(name, success, latencyMs)

    // Emit domain event
    this.eventBus.emit(events.DomainEvent.algedonicFired(
      this.nodeId,
      success ? 'Pleasure' as any : 'Pain' as any,
      success ? 'Info' as any : 'Warning' as any,
      `Tool ${name}: ${success ? 'success' : 'failure'} (${latencyMs}ms)`,
    ))

    // Escalate immediate-action signals
    if (action.type === 'Immediate' && this.onAlert) {
      this.onAlert({
        type: 'algedonic',
        severity: 'critical',
        message: `Critical: Tool ${name} failure requires immediate attention`,
        timestamp: Date.now(),
      })
    } else if (action.type === 'Delayed' && this.onAlert) {
      this.onAlert({
        type: 'algedonic',
        severity: 'high',
        message: `Tool ${name} failure — monitoring for recovery`,
        timestamp: Date.now(),
      })
    }

    // S3 decision journal: governance response to tool result
    try {
      const journal = getJournal()
      if (journal) {
        const recent = this.toolHistory.slice(-20)
        const recentSuccessRate = recent.filter(t => t.success).length / Math.max(recent.length, 1)
        journal.log(makeJournalEntry({
          sessionId: 'governance',
          system: 'S3',
          input: { toolName: name, success, latencyMs, recentSuccessRate, stuckCount: this.stuckCount },
          decision: { algedonicAction: action.type },
          outcome: { toolHistoryLength: this.toolHistory.length },
        }))
      }
    } catch {}
  }

  /** Called when workspace files change — real progress detected via POSIWID. */
  onFileProgress(filesChanged: number, additions: number, deletions: number): void {
    if (filesChanged > 0) {
      this.stuckCount = 0
      console.log(`[governance] File progress: ${filesChanged} files, ${additions}+ ${deletions}- → stuck reset`)
    }
  }

  /** GSD: Goal-backward verification outcome — feeds algedonic channel. */
  onVerificationResult(passed: boolean, details?: string): void {
    if (passed) {
      // Pleasure signal — goal achieved
      this.algedonicIntegration.recordToolResult('Verification', true, 0)
      this.performanceMetrics.recordTaskCompletion(true)
      console.log(`[vsm] Verification PASS → pleasure signal`)
    } else {
      // Pain signal — goal NOT achieved despite tools succeeding
      this.algedonicIntegration.recordToolResult('Verification', false, 0)
      this.performanceMetrics.recordTaskCompletion(false)
      console.log(`[vsm] Verification FAIL → pain signal: ${details?.slice(0, 80)}`)
    }
  }

  /** GSD: Context exhaustion signal — resource pressure alarm. */
  onContextCritical(utilization: number): void {
    this.algedonicIntegration.recordToolResult('ContextBudget', false, 0)
    console.log(`[vsm] Context critical (${Math.round(utilization * 100)}%) → algedonic pain`)
  }

  onTurnComplete(metrics: {
    toolsCalled: number
    thinkingTokens: number
    totalTokens: number
    latencyMs: number
    response: string
    userMessage?: string
  }): void {
    this.turnCount++
    if (this._ablated) return // Skip all governance when ablated

    // S4: Classify task complexity from user message
    if (metrics.userMessage) {
      const classification = classifyTask(metrics.userMessage)
      this.currentTaskComplexity = classification.complexity
    }

    // Update variety engine with BOTH sides of Ashby's equation:
    // - Environmental variety (S4): task complexity
    // - Regulatory variety: number of distinct tools available * usage diversity
    const distinctToolsUsed = new Set(this.toolHistory.slice(-10).map(t => t.name)).size
    this.varietyEngine.setInputCount(this.currentTaskComplexity * 3) // Environmental variety
    this.varietyEngine.setFilterCount(0)
    this.varietyEngine.setActiveTheories(distinctToolsUsed) // Tool diversity as amplification
    this.varietyEngine.recalculate()

    // Observer: record measurements from S3 and S4 perspectives
    const sr = this.getSuccessRate()
    this.observerEffects.recordMeasurement('success_rate', sr, 'S3')
    this.observerEffects.recordMeasurement('success_rate',
      metrics.toolsCalled > 0 ? sr : 0.5, 'S4') // S4 sees differently when no tools

    // Heterarchy: determine who commands
    const govReport = this.getReport()
    const context = this.heterarchyIntegration.classifyContext(
      this.stuckCount,
      govReport.s3s4Balance === 'critical',
      this.turnCount <= 2,
      metrics.toolsCalled,
    )
    const commander = this.heterarchyIntegration.whoCommands(context)

    // Conversation: track exchange if user message present
    if (metrics.userMessage && metrics.response) {
      this.conversationTheory.recordExchange(
        `turn_${this.turnCount}`,
        metrics.response.slice(0, 200),
        metrics.userMessage.slice(0, 200),
      )
    }

    // Track structural coupling (user ↔ system co-drift)
    const userComplexity = this.currentTaskComplexity / 8.0 // normalize to 0-1
    const systemComplexity = metrics.toolsCalled / 5.0 // normalize
    this.autopoiesisIntegration.recordInteraction(userComplexity, systemComplexity)

    // Update performance metrics
    this.performanceMetrics.recordTaskAttempt()
    if (metrics.toolsCalled > 0) {
      this.performanceMetrics.recordTaskCompletion()
    }
    this.performanceMetrics.updateFailureRate(
      1.0 - this.getSuccessRate(),
      0.1, // expected baseline failure rate
    )

    // Update feedback control systems
    const successRate = this.getSuccessRate()
    const snap2 = this.varietyEngine.current()
    const varietyRatio = snap2?.ratio ?? 1.0
    this.lastFeedbackActions = this.feedbackControl.update(
      0, // context utilization — filled when available
      1.0 - successRate,
      varietyRatio,
      successRate, // approval rate approximated by success rate
    )

    // Update homeostat with current pressures
    const s3Pressure = metrics.toolsCalled > 0 ? Math.min(metrics.toolsCalled / 5.0, 1.0) : 0.1
    const s4Pressure = metrics.thinkingTokens > 0 ? Math.min(metrics.thinkingTokens / metrics.totalTokens, 1.0) : 0.3
    const contextPressure = 0 // TODO: pass from context status events
    this.homeostatIntegration.update(s3Pressure, s4Pressure, contextPressure, metrics.latencyMs)

    // Emit variety event to EventBus
    const snap = this.varietyEngine.current()
    if (snap) {
      this.eventBus.emit(events.DomainEvent.varietyRecalculated(
        this.nodeId,
        this.currentTaskComplexity * 3, // requisite (environmental)
        snap.amplified,                  // actual (regulatory)
        snap.balance as any,
      ))
    }

    // Stuck detection: same response pattern
    this.lastResponses.push(metrics.response?.slice(0, 100) ?? '')
    if (this.lastResponses.length > 5) this.lastResponses = this.lastResponses.slice(-5)
    const uniqueResponses = new Set(this.lastResponses).size
    if (this.lastResponses.length >= 3 && uniqueResponses === 1) {
      this.stuckCount++
    } else {
      this.stuckCount = Math.max(0, this.stuckCount - 1)
    }

    // Persist measurement to SQLite for cross-session learning
    if (this._db) {
      try {
        this._db.recordMeasurement({
          sessionId: this._sessionId,
          turn: this.turnCount,
          toolErrorRate: 1.0 - this.getSuccessRate(),
          contextUtilization: 0,
          stuckTurns: this.stuckCount,
          tokenEfficiency: 1.0,
          s4Composite: 5.0,
        })
      } catch {}
    }

    // Variety mismatch alert — Ashby's Law violation
    const snapshot = this.varietyEngine.current()
    if (snapshot && snapshot.balance === 'Overload' && this.onAlert) {
      this.onAlert({
        type: 'variety_mismatch',
        severity: 'medium',
        message: `Task complexity (${this.currentTaskComplexity}) exceeds tool variety (${distinctToolsUsed} tools). Model may need more diverse tool usage.`,
        timestamp: Date.now(),
      })
    }
  }

  onModelError(error: string): void {
    this.algedonicIntegration.recordModelError(error)
    if (this.onAlert) {
      this.onAlert({
        type: 'algedonic',
        severity: 'critical',
        message: `Model error: ${error}`,
        timestamp: Date.now(),
      })
    }
  }

  onModelTimeout(ms: number): void {
    if (this.onAlert) {
      this.onAlert({
        type: 'algedonic',
        severity: 'high',
        message: `Model timeout after ${ms}ms`,
        timestamp: Date.now(),
      })
    }
  }

  getReport(): GovernanceReport {
    // Need substantial data before variety judgments — early sessions are all Reads
    const hasEnoughData = this.toolHistory.length >= 10
    const snapshot = hasEnoughData ? this.varietyEngine.current() : null
    const successRate = this.getSuccessRate()

    // S3/S4 balance from real variety metrics
    let s3s4Balance: 'balanced' | 'critical'
    let varietyBalance: 'balanced' | 'underload' | 'overload'

    if (snapshot) {
      // Map library's VarietyBalance enum to governance report
      // Library values: 'Critical' | 'Overload' | 'Underload' | 'Balanced'
      switch (snapshot.balance) {
        case 'Critical':
          varietyBalance = 'overload' // severe mismatch
          s3s4Balance = 'critical'
          break
        case 'Overload':
          varietyBalance = 'overload' // environment exceeds regulatory capacity
          s3s4Balance = snapshot.ratio < 0.5 ? 'critical' : 'balanced'
          break
        case 'Underload':
          varietyBalance = 'underload' // excess regulatory capacity
          s3s4Balance = 'balanced'
          break
        case 'Balanced':
          varietyBalance = 'balanced'
          s3s4Balance = 'balanced'
          break
        default:
          varietyBalance = 'balanced'
          s3s4Balance = 'balanced'
      }
    } else {
      varietyBalance = 'balanced'
      s3s4Balance = 'balanced'
    }

    // Status derivation — variety alone should NOT trigger critical, need real failures
    let status: 'healthy' | 'warning' | 'critical'
    if (this.stuckCount >= 5 || (s3s4Balance === 'critical' && successRate < 0.5)) {
      status = 'critical'
    } else if (successRate < 0.5 || varietyBalance === 'overload' || this.stuckCount >= 3) {
      status = 'warning'
    } else {
      status = 'healthy'
    }

    return {
      status,
      varietyBalance,
      s3s4Balance,
      algedonicAlerts: this.eventBus.replayFiltered(
        e => e.payload.kind === 'AlgedonicFired' && (e.payload as any).severity !== 'Info'
      ).length,
      stuckTurns: this.stuckCount,
      modelLatencyTrend: this.getLatencyTrend(),
      toolSuccessRate: successRate,
    }
  }

  private getSuccessRate(): number {
    if (this.toolHistory.length === 0) return 1.0
    const recent = this.toolHistory.slice(-20)
    return recent.filter(t => t.success).length / recent.length
  }

  private getLatencyTrend(): number {
    const recent = this.toolHistory.slice(-10)
    if (recent.length === 0) return 0
    return recent.reduce((sum, t) => sum + t.latencyMs, 0) / recent.length
  }

  /** Get the current variety snapshot for display/debugging. */
  getVarietySnapshot() {
    return this.varietyEngine.current()
  }

  /** Get the current task classification. */
  getTaskComplexity(): number {
    return this.currentTaskComplexity
  }

  /** Get the homeostat integration for stability checks. */
  getHomeostat(): HomeostatIntegration {
    return this.homeostatIntegration
  }

  /** Is the homeostat stable? If not, S5 should intervene. */
  isStable(): boolean {
    return this.homeostatIntegration.isStable()
  }

  /** Get feedback control actions (compression, approval adjustment, perturbation). */
  getFeedbackActions(): FeedbackActions | null {
    return this.lastFeedbackActions
  }

  /** Should context be compressed based on feedback loop? */
  shouldCompress(): boolean {
    return this.lastFeedbackActions?.shouldCompress ?? false
  }

  /** Get performance metrics integration. */
  getPerformanceMetrics(): PerformanceMetricsIntegration {
    return this.performanceMetrics
  }

  /** Get autopoiesis integration (proposals, coupling, identity). */
  getAutopoiesis(): AutopoiesisIntegration {
    return this.autopoiesisIntegration
  }

  /**
   * Gate a parameter change through the autopoietic proposal system.
   * BEHAVIORAL EFFECT: changes are BLOCKED if they fail identity checks.
   */
  proposeParameterChange(name: string, newValue: number, bounds: { min: number; max: number }) {
    return this.autopoiesisIntegration.proposeParameterChange(name, newValue, bounds)
  }

  /** Get heterarchy integration (who commands in what context). */
  getHeterarchy(): HeterarchyIntegration { return this.heterarchyIntegration }

  /** Return the active tool mode based on heterarchy commander. */
  getRecommendedToolMode(): 'full' | 'read_only' | 'safe' {
    try {
      const het = this.heterarchyIntegration
      const report = this.getReport()
      const context = het.classifyContext(
        report.stuckTurns,
        report.s3s4Balance === 'critical',
        false,
        this.toolHistory.length,
      )
      const commander = het.whoCommands(context)
      if (commander === 'S5') return 'safe'
      if (commander === 'S4') return 'read_only'
      return 'full'
    } catch {
      return 'full'
    }
  }

  /** Get conversation theory integration (teachback, agreement). */
  getConversationTheory(): ConversationTheoryIntegration { return this.conversationTheory }

  /** Get observer effects integration (measurements, eigenform). */
  getObserverEffects(): ObserverEffectsIntegration { return this.observerEffects }

  /** Get constraint checks integration. */
  getConstraintChecks(): ConstraintChecksIntegration { return this.constraintChecks }

  /** Get the config population (null if not initialized). */
  getPopulation(): ConfigPopulation | null { return this._population }

  /** Get the essential variable registry. */
  getRegistry(): EssentialVariableRegistry { return this._registry }

  /** Get the session homeostat (null if not initialized). */
  getSessionHomeostat(): SessionHomeostat | null { return this._sessionHomeostat }

  /** Get the S4 reflector. */
  getReflector(): S4Reflector { return this._reflector }

  /** Get the identity guard. */
  getIdentityGuard(): IdentityGuard { return this._identityGuard }

  /** Get the autopoiesis verifier. */
  getAutopoiesisVerifier(): AutopoiesisVerifier { return this._autopoiesisVerifier }

  /** Get the active strategy prompt from the selected population config. */
  getActiveStrategy(): string { return this._activeStrategy }

  /** Get the strategy memory (entailment mesh + structural coupling). */
  getStrategyMemory(): StrategyMemory { return this._strategyMemory }

  /**
   * Check if the system is operational. Throws HaltedError if kill switch active.
   * BEHAVIORAL EFFECT: STOPS the conversation loop.
   * Call before every model invocation.
   */
  checkOrHalt(): void {
    if (this._ablated) return // No kill switch when ablated
    this.algedonicIntegration.checkOrHalt()
  }

  /** Reset the kill switch after user intervention. */
  resetKillSwitch(): void {
    this.algedonicIntegration.reset()
  }

  /** Get the EventBus for audit/debugging. */
  getEventBus() {
    return this.eventBus
  }

  /** Get recent event count by kind. */
  getEventCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const e of this.eventBus.replay()) {
      counts[e.payload.kind] = (counts[e.payload.kind] ?? 0) + 1
    }
    return counts
  }

  /** Persist session outcome to SQLite for cross-session autopoietic learning. */
  recordSessionOutcome(outcome: 'viable' | 'marginal' | 'non-viable', strategy: string, configIndex: number, filesChanged: number): void {
    if (!this._db) return
    try {
      const report = this.getReport()
      this._db.recordSession({
        sessionId: this._sessionId,
        outcome,
        configIndex,
        strategy,
        toolSuccessRate: report.toolSuccessRate,
        stuckTurns: report.stuckTurns,
        totalTurns: this.turnCount,
        filesChanged,
      })
      console.log(`[vsm] Session outcome persisted: ${outcome}`)
    } catch {}
  }

  getGovernanceDb(): import('./governanceDb.js').GovernanceDB | undefined {
    return this._db
  }
}
