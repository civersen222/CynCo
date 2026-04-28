/**
 * Conversation loop for the CynCo engine.
 *
 * Handles the full cycle: user message -> model -> tool calls -> execute -> feed back -> model -> ...
 */

import { randomUUID } from 'crypto'
import type { EngineEvent, TUICommand } from './protocol.js'
import type { ThinkingConfig } from '../types.js'
import { asSystemPrompt } from '../types.js'
import type { LocalCodeConfig } from '../config.js'
import type { Provider } from '../provider.js'
import { localCallModel, type CallModelDeps } from '../engine/callModel.js'
import { ALL_TOOLS } from '../tools/registry.js'
import { ToolExecutor, type RequestApprovalFn } from '../tools/executor.js'
import type { ToolTrustProfile } from '../tools/approvalGate.js'
import { WorkflowEngine } from '../workflows/engine.js'
import type { WorkflowDefinition } from '../workflows/types.js'
import { LSPManager } from '../lsp/manager.js'
import { CyberneticsGovernance as GovernanceLayer } from '../vsm/cyberneticsGovernance.js'
import { WorkspaceSnapshot } from '../snapshot/snapshot.js'
// Advisor system imported dynamically in handleMessage to avoid circular deps
import { DecisionLogger } from '../decisions/logger.js'
import { ContextCompressor, FileOperationTracker } from '../context/compressor.js'
import type { S5Orchestrator } from '../s5/orchestrator.js'
import { SubAgentRunner } from '../agents/runner.js'
import { shouldInjectSummary, buildSummaryInjectionMessage } from './summaryInjection.js'
import { SteeringQueue } from './steeringQueue.js'
import { JSONLStore } from '../session/jsonlStore.js'
import { TemplateLoader } from '../prompts/templateLoader.js'
import {
  assembleBasePrompt,
  LEARNINGS_HEADER,
  FIRST_TIME_PROJECT,
  FRESH_PROJECT,
} from '../engine/systemPromptText.js'

type Message = {
  role: 'user' | 'assistant' | 'system'
  content: { type: string; text?: string; [key: string]: unknown }[]
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'CodeSearch', 'Ls', 'Git', 'ImageView']
const SAFE_MODE_TOOLS = [...READ_ONLY_TOOLS, 'Bash']

// S3 Resource Management: prevent single tool output from consuming all context
const TOOL_OUTPUT_LIMITS: Record<string, { maxLines: number; maxBytes: number }> = {
  Read:       { maxLines: 200, maxBytes: 50_000 },
  Bash:       { maxLines: 100, maxBytes: 20_000 },
  Grep:       { maxLines: 100, maxBytes: 30_000 },
  Glob:       { maxLines: 100, maxBytes: 30_000 },
  CodeSearch: { maxLines: 100, maxBytes: 30_000 },
  WebFetch:   { maxLines: 200, maxBytes: 50_000 },
  _default:   { maxLines: 200, maxBytes: 30_000 },
}
const NO_TRUNCATE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch'])

function truncateToolOutput(toolName: string, output: string): string {
  if (NO_TRUNCATE_TOOLS.has(toolName)) return output
  const limits = TOOL_OUTPUT_LIMITS[toolName] ?? TOOL_OUTPUT_LIMITS._default
  const lines = output.split('\n')
  const bytes = Buffer.byteLength(output, 'utf-8')
  if (lines.length <= limits.maxLines && bytes <= limits.maxBytes) return output

  // Truncate by lines first, then by bytes
  let truncated = lines.slice(0, limits.maxLines).join('\n')
  if (Buffer.byteLength(truncated, 'utf-8') > limits.maxBytes) {
    truncated = truncated.slice(0, limits.maxBytes)
  }
  const note = `\n\n[Output truncated: ${lines.length} lines / ${bytes} bytes → showing first ${limits.maxLines} lines / ${limits.maxBytes} bytes]`
  return truncated + note
}

/** S1: Group tool calls into batches for parallel/sequential execution. */
function classifyParallelBatches(toolBlocks: any[], readOnlySet: Set<string>): any[][] {
  const batches: any[][] = []
  let currentReadBatch: any[] = []

  for (const block of toolBlocks) {
    const name = block.name ?? 'unknown'
    if (readOnlySet.has(name)) {
      currentReadBatch.push(block)
    } else {
      // Flush read batch before write tool
      if (currentReadBatch.length > 0) {
        batches.push(currentReadBatch)
        currentReadBatch = []
      }
      batches.push([block]) // Write tools get their own batch
    }
  }
  if (currentReadBatch.length > 0) batches.push(currentReadBatch)
  return batches
}

export type ConversationLoopOptions = {
  config: LocalCodeConfig
  provider: Provider
  emit: (event: EngineEvent) => void
  cwd?: string
  trustProfile?: ToolTrustProfile
  workflowEngine?: WorkflowEngine
  s5?: S5Orchestrator
}

export class ConversationLoop {
  private messages: Message[] = []
  private abortController: AbortController | null = null
  private processing = false
  private config: LocalCodeConfig
  private provider: Provider
  private emit: (event: EngineEvent) => void
  private executor: ToolExecutor
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  private workflowEngine: WorkflowEngine
  private lspManager: LSPManager
  private governance: GovernanceLayer
  private decisionLogger = new DecisionLogger()
  private compressor = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
  private fileTracker = new FileOperationTracker()
  private s5?: S5Orchestrator
  private agentRunner: SubAgentRunner
  private toolHistory: string[] = []  // Track tool names for VSM advisors
  private toolFailureCounts: Map<string, number> = new Map()
  private consecutiveNudges = 0
  private steering = new SteeringQueue()
  private journal: JSONLStore
  private snapshot?: WorkspaceSnapshot
  private lastSnapshotHash?: string
  private vibeMode = false

  constructor(opts: ConversationLoopOptions) {
    this.config = opts.config
    this.provider = opts.provider
    this.emit = opts.emit

    const requestApproval: RequestApprovalFn = async (toolName, input, risk) => {
      const requestId = randomUUID()
      const description = this.formatToolDescription(toolName, input)
      this.emit({ type: 'approval.request', requestId, toolName, description, risk })
      return new Promise<boolean>((resolve) => {
        this.pendingApprovals.set(requestId, resolve)
        // Auto-deny after 5 minutes if no response
        setTimeout(() => {
          if (this.pendingApprovals.has(requestId)) {
            this.pendingApprovals.delete(requestId)
            resolve(false)
          }
        }, 300000)
      })
    }

    this.executor = new ToolExecutor({
      cwd: opts.cwd ?? process.cwd(),
      requestApproval,
      trustProfile: opts.trustProfile,
    })

    this.workflowEngine = opts.workflowEngine ?? new WorkflowEngine()
    this.lspManager = new LSPManager(opts.cwd ?? process.cwd())
    this.governance = new GovernanceLayer((alert) => {
      this.emit({ type: 'governance.alert', severity: alert.severity, message: alert.message, source: alert.source } as any)
    })
    this.s5 = opts.s5
    this.agentRunner = new SubAgentRunner(async (task) => {
      // Simplified sub-agent execution — full execution comes later
      return `[SubAgent completed] ${task.task}`
    })

    // Initialize workspace snapshot for governance
    try {
      const fs = require('fs')
      const path = require('path')
      const { execSync } = require('child_process')
      const cwd = this.executor['cwd']
      // If not a git repo, make it one — snapshots need git
      if (!fs.existsSync(path.join(cwd, '.git'))) {
        execSync('git init', { cwd, stdio: 'pipe' })
        console.log('[snapshot] Initialized git repo in project directory')
      }
      this.snapshot = new WorkspaceSnapshot(cwd)
      this.snapshot.init()
      this.lastSnapshotHash = this.snapshot.track()
      console.log('[snapshot] Initialized workspace snapshot')
    } catch (e) {
      console.log(`[snapshot] Failed to initialize: ${e instanceof Error ? e.message : String(e)}`)
    }

    // S5: Session journal for crash recovery
    this.journal = new JSONLStore(`session-${Date.now()}`)
    console.log(`[session] Journal: ${this.journal.path}`)
  }

  get isProcessing(): boolean {
    return this.processing
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
      this.processing = false
    }
  }

  updateModel(model: string): void {
    this.config = { ...this.config, model }
  }

  handleApprovalResponse(requestId: string, approved: boolean): void {
    const resolve = this.pendingApprovals.get(requestId)
    if (resolve) {
      this.pendingApprovals.delete(requestId)
      resolve(approved)
    }
  }

  setApproveAll(value: boolean): void {
    this.executor.setApproveAll(value)
  }

  /** Append message to both in-memory array and JSONL journal. */
  private addMessage(msg: Message): void {
    this.messages.push(msg)
    try { this.journal.appendMessage(msg) } catch {}
  }

  /** Resume a previous session from JSONL journal. */
  resume(sessionId: string): boolean {
    const store = new JSONLStore(sessionId)
    const messages = store.loadMessages()
    if (messages.length > 0) {
      this.messages = messages
      this.journal = store
      console.log(`[session] Resumed ${sessionId}: ${messages.length} messages`)
      return true
    }
    return false
  }

  resetGovernance(): void {
    this.governance.resetKillSwitch()
    this.consecutiveNudges = 0
    this.toolFailureCounts.clear()
    console.log('[loop] Governance reset — kill switch, nudges, and tool failure counts cleared')
  }

  setVibeMode(enabled: boolean): void {
    this.vibeMode = enabled
    console.log(`[loop] Vibe mode: ${enabled ? 'ON' : 'OFF'}`)
  }

  get isVibeMode(): boolean {
    return this.vibeMode
  }

  async handleUserMessage(text: string): Promise<void> {
    if (this.processing) {
      console.log('[loop] Already processing, ignoring message')
      return
    }
    this.processing = true
    console.log(`[loop] Handling message: "${text.slice(0, 80)}..."`)

    this.addMessage({
      role: 'user',
      content: [{ type: 'text', text }],
    })

    this.abortController = new AbortController()
    this.toolFailureCounts.clear()
    this.consecutiveNudges = 0
    this.steering.clear()

    // Auto-inject CodeIndex results as system context — don't modify user message
    // (modifying user message leaks into memory recall display as "Prior: [Relevant code...]")
    try {
      const { ProjectIndexer } = await import('../index/indexer.js')
      const indexer = new ProjectIndexer(this.executor['cwd'])
      const results = await indexer.query({ query: text, topK: 5 })
      if (results.length > 0) {
        const context = indexer.formatResults(results)
        this.messages.splice(this.messages.length - 1, 0, {
          role: 'system',
          content: [{ type: 'text', text: `[Project code context]\n${context}` }],
        })
        console.log(`[index] Injected ${results.length} relevant chunks as system context`)
      }
      indexer.close()
    } catch {
      // Index not available — proceed without it
    }

    // GSD: Inject project state as system context — don't modify user message
    try {
      const fs = require('fs')
      const path = require('path')
      const statePath = path.join(this.executor['cwd'], '.cynco-state.md')
      if (fs.existsSync(statePath)) {
        const stateContent = fs.readFileSync(statePath, 'utf-8')
        if (stateContent.trim()) {
          this.messages.splice(this.messages.length - 1, 0, {
            role: 'system',
            content: [{ type: 'text', text: `[Prior session state]\n${stateContent}` }],
          })
          console.log(`[state] Injected .cynco-state.md as system context (${stateContent.length} chars)`)
        }
      }
    } catch {}

    // Determine active tool set — workflow may restrict tools
    let activeTools = ALL_TOOLS
    if (this.workflowEngine.isActive) {
      const allowed = this.workflowEngine.getAllowedTools()
      if (allowed) {
        activeTools = ALL_TOOLS.filter(t => allowed.includes(t.name))
      }
    }

    // Build tool definitions in the format callModel expects (inputJSONSchema)
    const toolDefs = activeTools.map(t => ({
      name: t.name,
      description: t.description,
      inputJSONSchema: t.inputSchema,
    }))
    const toolNames = activeTools.map(t => `- ${t.name}: ${t.description}`).join('\n')

    const promptParts = assembleBasePrompt(toolNames, this.executor['cwd'])

    // Inject saved learnings from previous sessions
    try {
      const crypto = await import('crypto')
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8)
      const learningsPath = path.join(os.homedir(), '.cynco', 'continuity', projectHash, 'learnings.json')
      if (fs.existsSync(learningsPath)) {
        const learnings = JSON.parse(fs.readFileSync(learningsPath, 'utf-8'))
        if (learnings.length > 0) {
          const recent = learnings.slice(-20)
          const learningLines = recent.map((l: any) =>
            `- [${l.type}] ${l.content}${l.context ? ` (${l.context})` : ''}`
          ).join('\n')
          promptParts.push('')
          promptParts.push(LEARNINGS_HEADER + learningLines)
        }
      }
    } catch {}

    // First-message project audit: if no memory exists, scan the project
    if (this.messages.length === 1) {
      try {
        const crypto = await import('crypto')
        const os = await import('os')
        const path = await import('path')
        const fs = await import('fs')
        const cwd = this.executor['cwd'] ?? process.cwd()
        const projectHash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 8)
        const continuityDir = path.join(os.homedir(), '.cynco', 'continuity', projectHash)
        const hasLedger = fs.existsSync(path.join(continuityDir, 'ledger.json'))
        const hasLearnings = fs.existsSync(path.join(continuityDir, 'learnings.json'))
        const hasFiles = fs.existsSync(cwd) && fs.readdirSync(cwd).filter(
          (f: string) => !f.startsWith('.') && !f.startsWith('node_modules')
        ).length > 0

        if (!hasLedger && !hasLearnings && hasFiles) {
          // Project exists but no memory — do an audit
          promptParts.push('')
          promptParts.push(FIRST_TIME_PROJECT)
        } else if (!hasLedger && !hasLearnings && !hasFiles) {
          // Empty project directory — fresh start
          promptParts.push('')
          promptParts.push(FRESH_PROJECT)
        }
      } catch {}
    }

    // S4: Load system.md template extension
    try {
      const templates = new TemplateLoader(this.executor['cwd'])
      const systemExt = templates.loadSystemExtension()
      if (systemExt) {
        promptParts.push('')
        promptParts.push('## User Custom Instructions\n' + systemExt)
      }
    } catch {}

    // Autopoietic strategy injection — the population-evolved behavioral directive
    const activeStrategy = this.governance.getActiveStrategy()
    if (activeStrategy) {
      promptParts.push('')
      promptParts.push('## Strategy\n' + activeStrategy)
    }

    // VSM Governance Signals — pure state machine outputs, NO model calls.
    // Each signal is computed from metrics in microseconds, not LLM inference.
    {
      try {
        const govReport = this.governance.getReport()
        const signals: string[] = []

        // Variety signal: if task complexity exceeds tool variety
        if (govReport.varietyBalance === 'overload') {
          signals.push('VARIETY WARNING: Task complexity exceeds your current tool usage. Try using more diverse tools (Grep, Glob, Read) to build understanding before editing.')
        }

        // Homeostat signal: if system is unstable
        if (!this.governance.isStable()) {
          signals.push('STABILITY WARNING: System metrics are oscillating. Focus on one approach before switching.')
        }

        // Feedback control: if context needs compression
        if (this.governance.shouldCompress()) {
          signals.push('CONTEXT PRESSURE: Context window filling up. Be concise. Consider compacting.')
        }

        // Performance signal: check achievement health
        const pm = this.governance.getPerformanceMetrics()
        const health = pm.getHealthStatus()
        if (health === 'red') {
          signals.push('PERFORMANCE ALERT: Low task completion rate. Simplify your approach — solve one thing at a time.')
        }

        // CUSUM drift: failure rate shifting
        if (pm.isDriftDetected()) {
          signals.push('DRIFT DETECTED: Tool failure rate has shifted. Check recent errors and adjust approach.')
        }

        // Stuck detection
        if (govReport.stuckTurns >= 2) {
          signals.push(`STUCK: ${govReport.stuckTurns} turns without progress. Try a completely different approach.`)
        }

        // Heterarchy: who commands in this context
        const het = this.governance.getHeterarchy()
        const context = het.classifyContext(
          govReport.stuckTurns,
          govReport.s3s4Balance === 'critical',
          this.messages.length <= 2,
          this.toolHistory.length,
        )
        const commander = het.whoCommands(context)
        if (commander !== 'S3') { // Only inject when not normal operations
          const contextLabel = { crisis: 'CRISIS MODE', exploration: 'EXPLORATION MODE', stuck: 'RECOVERY MODE', routine: 'ROUTINE' }[context] ?? ''
          if (contextLabel) {
            signals.push(`${contextLabel}: ${commander} has authority. ${
              commander === 'S5' ? 'Focus on safety and identity.' :
              commander === 'S4' ? 'Explore alternatives before committing.' :
              commander === 'S1' ? 'Execute autonomously.' :
              'Coordinate with other systems.'
            }`)
          }
        }

        if (signals.length > 0) {
          promptParts.push('')
          promptParts.push('## Governance Signals\n' + signals.map(s => `- ${s}`).join('\n'))
          console.log(`[vsm] ${signals.length} governance signals injected`)
        }
      } catch (err) {
        console.log(`[vsm] Governance signal error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Prepend workflow instructions when a workflow is active
    if (this.workflowEngine.isActive) {
      const override = this.workflowEngine.getSystemPromptOverride()
      if (override) {
        promptParts.unshift(override, '')
      }
    }

    const systemPrompt = asSystemPrompt(promptParts)

    // Thinking config: disabled for Ollama (provider ignores it, model thinks natively)
    const thinkingConfig: ThinkingConfig = { type: 'disabled' }

    const deps: CallModelDeps = {
      getProvider: () => this.provider,
      loadConfig: () => this.config,
    }

    // S5 decision before model loop
    if (this.s5) {
      try {
        const estimatedTokens = this.messages.reduce((sum, m) =>
          sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? JSON.stringify(b).length) / 4, 0), 0)
        const ctxLength = this.config.contextLength ?? 32768
        const decision = await this.s5.makeDecision({
          userMessage: text.slice(0, 200),
          activeWorkflow: this.workflowEngine.state?.workflow.name ?? null,
          currentPhase: this.workflowEngine.currentPhase?.name ?? null,
          contextUsagePercent: estimatedTokens / ctxLength,
          governance: this.governance.getReport(),
          recentToolResults: [],
          availableModels: [this.config.model ?? 'unknown'],
          turnCount: this.messages.filter(m => m.role === 'user').length,
        })

        // L3: APPLY S5 decisions, not just log them
        if (decision.contextAction === 'compact') {
          console.log(`[s5] Decision: compact context (${decision.reasoning})`)
          // Trigger compaction via the S5 decision path
          const ctxLen = this.config.contextLength ?? 32768
          const estTokens = this.messages.reduce((sum, m) =>
            sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? JSON.stringify(b).length) / 4, 0), 0)
          if (this.compressor.shouldCompress(this.messages, estTokens, ctxLen)) {
            const toCompress = this.compressor.selectForCompression(this.messages)
            const prompt = this.compressor.buildStructuredSummaryPrompt(toCompress, this.fileTracker)
            try {
              const summary = await this.sideQuery(prompt)
              this.messages = this.compressor.compressMessages(this.messages, summary, this.fileTracker)
              console.log(`[s5] Context compacted by S5 decision`)
            } catch {}
          }
        }
        if (decision.tools) {
          // Reorder tools so S5's preferred tools appear first (don't remove — removal kills model)
          const preferred = new Set(decision.tools)
          toolDefs.sort((a, b) => {
            const aP = preferred.has(a.name) ? 0 : 1
            const bP = preferred.has(b.name) ? 0 : 1
            return aP - bP
          })
          console.log(`[s5] Tool order adjusted: ${decision.tools.join(', ')} prioritized`)
        }
        console.log(`[s5] Priority: ${decision.priority} | ${decision.reasoning}`)
      } catch (err) {
        console.log(`[s5] Decision error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    try {
      await this.runModelLoop(systemPrompt, thinkingConfig, toolDefs, deps)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[loop] ERROR: ${msg}`)
      this.emit({ type: 'session.error', error: msg })
    } finally {
      // ─── Session End: Autopoietic evaluation ─────────────────
      try {
        const pop = this.governance.getPopulation()
        const sh = this.governance.getSessionHomeostat()
        const guard = this.governance.getIdentityGuard()
        const verifier = this.governance.getAutopoiesisVerifier()

        if (pop && sh) {
          // If S4 never ran during the session, run one final reflection now.
          // This catches short sessions where the model finishes before turn X.
          const reflector = this.governance.getReflector()

          // Build session context so the reflector knows what actually happened
          const userTask = this.messages.find(m => m.role === 'user')?.content
            .filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').slice(0, 200) ?? ''
          const uniqueTools = [...new Set(this.toolHistory)]
          const iterationCount = this.toolHistory.length
          reflector.setSessionContext([
            `Task: ${userTask}`,
            `Tools used (${iterationCount} calls): ${uniqueTools.join(', ')}`,
            `Messages exchanged: ${this.messages.length}`,
          ].join('\n'))

          if (reflector.getHistory().length === 0) {
            try {
              const finalText = await this.sideQuery(reflector.getReflectionPrompt())
              const scores = reflector.parseResponse(finalText)
              const composite = reflector.recordScores(scores)
              console.log(`[vsm] Final S4 reflection: progress=${scores.progress} composite=${composite.toFixed(1)}`)
              // Feed into homeostat so viability check includes self-assessment
              sh.update({
                tool_error_rate: 0,
                context_utilization: 0,
                stuck_turns: 0,
                token_efficiency: 1.0,
                reflection_frequency: reflector.getFrequency(),
                s4_composite: composite,
              })
            } catch (e) {
              console.log(`[vsm] Final reflection failed: ${e}`)
            }
          }

          // S4 composite override: if the model says it failed, it failed.
          // The per-turn viability ratio can't see s4_composite (it's only set
          // when S4 fires), so a bad self-assessment gets diluted by clean turns.
          // The final S4 score is the ground truth for task outcome.
          const lastComposite = reflector.getHistory().at(-1) ?? 10
          const s4Bound = this.governance.getRegistry().get('s4_composite')
          const s4Breached = s4Bound ? lastComposite < s4Bound.bounds[0] : false
          let outcome = sh.getSessionOutcome()
          if (s4Breached && outcome === 'viable') {
            outcome = 'non-viable'
            console.log(`[vsm] S4 override: composite=${lastComposite.toFixed(1)} < bound=${s4Bound!.bounds[0]} → non-viable`)
          }

          const guardResult = guard.evaluate({
            toolsUsed: [...new Set(this.toolHistory)],
            toolErrors: this.toolHistory.length - this.toolHistory.filter(() => true).length,
            toolSuccesses: this.toolHistory.length,
            userMessagesHandled: this.messages.filter(m => m.role === 'user').length,
            governanceSignalsInjected: 0,
            killSwitchTriggered: false,
            parametersModified: [],
            metaBoundsWidened: false,
          })

          const finalOutcome = guardResult.passed ? outcome : 'non-viable'

          // Find which config was selected (most recently used)
          const configs = Array.from({ length: pop.size() }, (_, i) => pop.getConfig(i))
          const selected = configs.reduce((a, b) => a.lastUsed > b.lastUsed ? a : b)

          // Record outcome in strategy memory (structured relational graph)
          const stratMem = this.governance.getStrategyMemory()
          stratMem.recordOutcome({
            strategy: selected.strategy ?? '',
            configIndex: selected.index,
            outcome: finalOutcome as 'viable' | 'marginal' | 'non-viable',
            viabilityRatio: sh.getViabilityRatio(),
            perturbations: sh.getPerturbationCount(),
            toolsUsed: [...new Set(this.toolHistory)],
            timestamp: Date.now(),
          })

          if (finalOutcome === 'viable') {
            pop.markViable(selected.index)
          } else if (finalOutcome === 'marginal') {
            pop.markMarginal(selected.index)
          } else {
            // NON-VIABLE: the system writes its own new strategy from its own reflection
            // informed by the FULL HISTORY of what worked and what didn't.
            const reflector = this.governance.getReflector()
            const reflectionHistory = reflector.getHistory()
            const lastSignal = reflector.getLastSignal()
            const viabilityRatio = sh.getViabilityRatio()
            const perturbCount = sh.getPerturbationCount()
            const memoryContext = stratMem.getSummaryForReflection()

            try {
              const reflectionPrompt = [
                `You are a governance system reflecting on a failed coding session.`,
                `The session used this strategy: "${selected.strategy}"`,
                `Results: viability ratio ${(viabilityRatio * 100).toFixed(0)}%, ${perturbCount} mid-session perturbations, final signal: ${lastSignal}`,
                reflectionHistory.length > 0 ? `Self-report scores over session: ${reflectionHistory.map(s => s.toFixed(1)).join(', ')}` : '',
                `Tools used: ${[...new Set(this.toolHistory)].join(', ')}`,
                memoryContext ? `\n${memoryContext}` : '',
                ``,
                `Write a NEW strategy (2-3 sentences) that fixes what went wrong. Use the strategy history to inform what works. Be specific. Do not repeat the failed strategy.`,
              ].filter(Boolean).join('\n')
              const newStrategy = (await this.sideQuery(reflectionPrompt)).trim().slice(0, 500)
              if (newStrategy.length > 20) {
                selected.strategy = newStrategy
                console.log(`[vsm] Autopoietic strategy rewrite: "${newStrategy.slice(0, 80)}..."`)
              }
            } catch (e) {
              console.log(`[vsm] Strategy self-write failed, falling back to crossover: ${e}`)
            }

            pop.markNonViable(selected.index)
          }

          const registry = this.governance.getRegistry()
          registry.evolveBounds(sh.getMeasurements())

          // Persist everything — population configs, strategy memory graph
          const os = require('os')
          const path = require('path')
          const popDir = path.join(os.homedir(), '.cynco', 'population')
          pop.save()
          stratMem.save(popDir)

          const assessment = verifier.assess({
            populationExists: true,
            registryEvolvable: true,
            identityGuardActive: guardResult.passed,
          })

          console.log(`[vsm] Session end: outcome=${finalOutcome}, autopoietic=${assessment.isAutopoietic}, config=${selected.index}`)
        }
      } catch (e) {
        console.log(`[vsm] Session-end evaluation error: ${e}`)
      }

      this.processing = false
      this.abortController = null
    }
  }

  buildHandoff(): { goal: string; now: string; status: string; model?: string; what_was_done: string[]; files_modified: string[] } {
    // Extract first user message as the goal
    const firstUser = this.messages.find(m => m.role === 'user')
    const goal = firstUser?.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .slice(0, 200) || 'Unknown task'

    // Extract last assistant message as current state
    const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant')
    const now = lastAssistant?.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .slice(0, 200) || ''

    // Unique tools used
    const uniqueTools = [...new Set(this.toolHistory)]
    const what_was_done = uniqueTools.length > 0
      ? [`Used tools: ${uniqueTools.join(', ')}`]
      : ['No tools used']

    // Files modified — extract from Write/Edit/MultiEdit tool_use blocks
    const files_modified: string[] = []
    for (const msg of this.messages) {
      for (const block of msg.content) {
        if ((block as any).type === 'tool_use' && ['Write', 'Edit', 'MultiEdit'].includes((block as any).name)) {
          const path = (block as any).input?.file_path || (block as any).input?.path
          if (path && !files_modified.includes(path)) {
            files_modified.push(path)
          }
        }
      }
    }

    // Determine status from governance
    const govReport = this.governance.getReport()
    const status = govReport.stuckTurns >= 5 ? 'blocked'
      : this.messages.length <= 2 ? 'abandoned'
      : 'in_progress'

    return { goal, now, status, model: this.config.model, what_was_done, files_modified }
  }

  /** Quick side query — no tools, no thinking, returns plain text. */
  private async sideQuery(prompt: string): Promise<string> {
    // Use native Ollama API (not OpenAI-compatible) with think:false.
    // qwen3.6 burns all tokens on chain-of-thought reasoning via the
    // OpenAI endpoint, returning empty content. Native API + think:false
    // forces direct text output.
    const baseUrl = this.config.baseUrl || 'http://localhost:11434'
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        options: { num_predict: 200, temperature: 0.3 },
        think: false,
        stream: false,
      }),
    })
    const data: any = await resp.json()
    return data.message?.content ?? ''
  }

  private async runModelLoop(
    systemPrompt: ReturnType<typeof asSystemPrompt>,
    thinkingConfig: ThinkingConfig,
    toolDefs: { name: string; description: string; inputJSONSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }[],
    deps: CallModelDeps,
    maxIterations = 500,
  ): Promise<void> {
    // Session-scoped accumulators (survive across iterations within a single runModelLoop invocation)
    const toolsUsedInSession: string[] = []
    let summaryInjected = false

    for (let i = 0; i < maxIterations; i++) {
      const iterationStartMs = Date.now()

      // S2: Check for steering interrupts
      const steer = this.steering.nextSteer()
      if (steer) {
        console.log(`[s2] Steering from ${steer.source}`)
        this.addMessage({
          role: 'user',
          content: [{ type: 'text', text: steer.text }],
        })
        continue
      }

      const lastMsg = this.messages[this.messages.length - 1]
      const lastRole = lastMsg?.role ?? 'none'
      const lastType = lastMsg?.content?.[0]?.type ?? 'empty'
      console.log(`[loop] Model call iteration ${i + 1} | messages: ${this.messages.length} | last: ${lastRole}/${lastType}`)

      // S4 Reflector: periodic model self-report
      const reflector = this.governance.getReflector()
      if (reflector.shouldReflect(i + 1)) {
        try {
          const sideText = await this.sideQuery(reflector.getReflectionPrompt())
          console.log(`[vsm] S4 raw response: ${sideText.slice(0, 200)}`)
          let scores = reflector.parseResponse(sideText)
          // If parse returned all-5 defaults, fall back to metrics-derived scores
          if (scores.progress === 5 && scores.confidence === 5 && scores.toolQuality === 5 && scores.stuckness === 5) {
            const govReport = this.governance.getReport()
            scores = reflector.deriveFromMetrics({
              stuckTurns: govReport.stuckTurns,
              toolSuccessRate: govReport.toolSuccessRate,
              contextUtilization: 0,
            })
            console.log(`[vsm] S4 parse failed — using metrics-derived scores`)
          }
          const composite = reflector.recordScores(scores)
          console.log(`[vsm] S4 reflection: progress=${scores.progress} confidence=${scores.confidence} stuck=${scores.stuckness} composite=${composite.toFixed(1)} X=${reflector.getFrequency()}`)

          // Feed S4 composite into essential variables — this is how the system
          // feels pain from task failure, not just process failure
          const sh = this.governance.getSessionHomeostat()
          if (sh) {
            const govReport = this.governance.getReport()
            sh.update({
              tool_error_rate: 1.0 - govReport.toolSuccessRate,
              context_utilization: 0,
              stuck_turns: govReport.stuckTurns,
              token_efficiency: this.governance.getVarietySnapshot()?.ratio ?? 1.0,
              reflection_frequency: reflector.getFrequency(),
              s4_composite: composite,
            })
          }

          if (reflector.shouldTriggerPerturbation()) {
            if (sh) {
              console.log('[vsm] S4 triggered perturbation due to high stuckness')
            }
          }
        } catch (e) {
          console.log(`[vsm] S4 reflection failed: ${e}`)
        }
      }

      // Context compression check
      const estimatedTokensBefore = this.messages.reduce((sum, m) =>
        sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? JSON.stringify(b).length) / 4, 0), 0)
      const ctxLen = this.config.contextLength ?? 32768

      if (this.compressor.shouldCompress(this.messages, estimatedTokensBefore, ctxLen)) {
        console.log(`[loop] Context at ${Math.round(estimatedTokensBefore / ctxLen * 100)}% — compressing`)
        this.emit({ type: 'stream.token', text: '\n[System] Compressing context to free space...\n' })
        const toCompress = this.compressor.selectForCompression(this.messages)
        // S4: structured compaction with file operation tracking
        const prompt = this.compressor.buildStructuredSummaryPrompt(toCompress, this.fileTracker)
        let summary: string
        try {
          summary = await this.sideQuery(prompt)
        } catch {
          // Fallback: simple concatenation if sideQuery fails
          summary = toCompress.map(m =>
            m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join(' ').slice(0, 100)
          ).join('; ')
        }
        this.messages = this.compressor.compressMessages(this.messages, summary, this.fileTracker)
        try { this.journal.appendCompaction(summary, this.fileTracker.serialize()) } catch {}
        console.log(`[loop] Compressed to ${this.messages.length} messages (files tracked: ${this.fileTracker.getModifiedFiles().length} modified, ${this.fileTracker.getReadFiles().length} read)`)
      }

      // Algedonic kill switch — HALT if critical failures accumulated
      try {
        this.governance.checkOrHalt()
      } catch (haltErr: any) {
        console.log(`[loop] HALTED: ${haltErr.message}`)
        this.emit({ type: 'stream.token', text: `\n[System] ${haltErr.message}\nType /reset to continue.\n` })
        this.emit({ type: 'message.complete', messageId: '', stopReason: 'halted' })
        return
      }

      // VSM agent mode: log but NEVER restrict tools.
      // Removing write tools when the model needs to write is actively harmful —
      // it causes the model to narrate instead of act, which looks like "dying."
      const toolMode = this.governance.getRecommendedToolMode()
      const iterationTools = toolDefs
      if (toolMode !== 'full') {
        console.log(`[vsm] Tool mode is ${toolMode} but NOT restricting — tool removal causes model death`)
      }

      const gen = localCallModel({
        messages: this.messages,
        systemPrompt,
        thinkingConfig,
        tools: iterationTools,
        signal: this.abortController?.signal ?? new AbortController().signal,
        options: { model: this.config.model! },
        deps,
      })

      let lastMessageId = ''
      let tokenCount = 0
      let reasoningTokenCount = 0
      let stopReason = 'end_turn'
      let assistantContent: unknown[] = []
      const toolsUsedThisTurn: string[] = []
      const toolResultsThisTurn: ('success' | 'failure' | 'denied')[] = []
      let streamedText = ''

      for await (const yielded of gen) {
        if (this.abortController?.signal.aborted) return

        if (yielded.type === 'stream_event') {
          const event = yielded.event as any
          if (!event?.type) continue

          switch (event.type) {
            case 'content_block_delta': {
              const delta = event.delta
              if (delta?.type === 'text_delta' && delta.text) {
                tokenCount++
                streamedText += delta.text
                if (!this.vibeMode) {
                  this.emit({ type: 'stream.token', text: delta.text })
                }
              }
              // Track reasoning tokens (qwen3, deepseek-r1, etc.)
              // Accumulated silently — not shown in chat (noise for users)
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                reasoningTokenCount++
              }
              break
            }
            case 'message_start':
              lastMessageId = event.message?.id ?? ''
              break
            case 'message_delta':
              stopReason = event.delta?.stop_reason ?? stopReason
              break
            case 'message_stop': {
              console.log(`[loop] message_stop, tokens=${tokenCount}, stop=${stopReason}`)
              // Debug: write conversation state to file for diagnosis
              try {
                const debugPath = require('path').join(this.executor['cwd'], '.cynco-debug.json')
                require('fs').writeFileSync(debugPath, JSON.stringify({
                  iteration: i + 1,
                  messageCount: this.messages.length,
                  tokenCount,
                  stopReason,
                  messages: this.messages.map((m: any) => ({
                    role: m.role,
                    contentTypes: m.content?.map((b: any) => b.type) ?? [],
                    textPreview: m.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text?.slice(0, 200)).join('') ?? '',
                  })),
                }, null, 2))
              } catch {}

              // Governance: record turn completion with user message for task classification
              const lastUserMsg = this.messages.filter(m => m.role === 'user').pop()
              const userMsgText = lastUserMsg?.content?.[0]?.text ?? ''
              this.governance.onTurnComplete({
                toolsCalled: (assistantContent as any[]).filter((b: any) => b.type === 'tool_use').length,
                thinkingTokens: reasoningTokenCount,
                totalTokens: tokenCount + reasoningTokenCount,
                latencyMs: Date.now() - iterationStartMs,
                response: '',
                userMessage: userMsgText,
              })

              // Emit governance status to TUI
              const turnReport = this.governance.getReport()
              this.emit({
                type: 'governance.status',
                health: turnReport.status,
                s3s4Balance: turnReport.s3s4Balance,
                toolSuccessRate: turnReport.toolSuccessRate,
                stuckTurns: turnReport.stuckTurns,
                suggestion: turnReport.stuckTurns > 0 ? 'Model may be stuck — consider changing approach' : null,
              })

              // Stream debug log
              try {
                const fs = require('fs')
                const path = require('path')
                fs.appendFileSync(
                  path.join(this.executor['cwd'], '.cynco-stream.log'),
                  `\n--- Iteration ${i + 1} | tokens=${tokenCount} reasoning=${reasoningTokenCount} stop=${stopReason} ---\n${streamedText}\n`
                )
              } catch {}
            }
              break
            case 'content_block_start': {
              const block = event.content_block
              if (block?.type === 'tool_use') {
                this.emit({
                  type: 'tool.start',
                  toolId: block.id ?? randomUUID(),
                  toolName: block.name ?? 'unknown',
                  input: {},
                })
              }
              break
            }
            case 'context_budget_warning':
            case 'context_budget_exceeded':
              this.emit({
                type: 'context.warning',
                utilization: event.utilization ?? 0,
                message: `Context ${event.type === 'context_budget_exceeded' ? 'exceeded' : 'warning'}: ${Math.round((event.utilization ?? 0) * 100)}%`,
              })
              break
            case 'memory_data': {
              // Forward memory recall + session context to TUI
              // This arrives before stream tokens (ordering guarantee from callModel.ts)
              this.emit({
                type: 'memory.recalled',
                memories: (event as any).memories ?? [],
                sessionContext: (event as any).sessionContext ?? undefined,
              })
              break
            }
          }
        } else if (yielded.type === 'assistant') {
          const msg = yielded as any
          assistantContent = msg.message?.content ?? []
          this.addMessage({
            role: 'assistant',
            content: assistantContent as Message['content'],
          })
        }
      }

      // Check if model wants to use tools
      let toolUseBlocks = (assistantContent as any[]).filter(
        (b: any) => b.type === 'tool_use'
      )

      // Fallback: if model output <tool_call> XML text instead of native tool_use blocks,
      // extract tool calls from the text. This happens when native models occasionally
      // fall back to XML-style tool calling mid-conversation.
      if (toolUseBlocks.length === 0 && stopReason === 'tool_use') {
        const textContent = (assistantContent as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text ?? '')
          .join('')
        const toolCallMatch = textContent.match(/<tool_call[|]?>\s*(\{[\s\S]*?\})\s*<\/tool_call>/)
        if (toolCallMatch) {
          try {
            const parsed = JSON.parse(toolCallMatch[1])
            if (parsed.name) {
              console.log(`[loop] Extracted XML tool call fallback: ${parsed.name}`)
              toolUseBlocks = [{
                type: 'tool_use',
                id: randomUUID(),
                name: parsed.name,
                input: parsed.arguments ?? parsed.input ?? {},
              }]
            }
          } catch { /* ignore parse errors */ }
        }
        // If still no tool calls found, treat as end_turn
        if (toolUseBlocks.length === 0) {
          console.log(`[loop] stop_reason was tool_use but no tool blocks found — treating as end_turn`)
          stopReason = 'end_turn'
        }
      }

      // Emit context utilization after each model turn
      const estimatedTokens = this.messages.reduce((sum, m) => {
        return sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? JSON.stringify(b).length) / 4, 0)
      }, 0)
      const contextLength = this.config.contextLength ?? 32768
      this.emit({
        type: 'context.status',
        utilization: Math.min(1, estimatedTokens / contextLength),
        estimatedTokens: Math.round(estimatedTokens),
        contextLength,
        action: estimatedTokens / contextLength > 0.8 ? 'compact' : 'proceed',
      })

      // GSD: Context monitor — warn model before overflow
      const ctxUtilization = estimatedTokens / contextLength
      if (ctxUtilization > 0.80) {
        this.addMessage({
          role: 'user',
          content: [{ type: 'text', text: '[CONTEXT CRITICAL: 80% used] Finish current task NOW. Do not read more files. Write your changes immediately.' }],
        })
        this.governance.onContextCritical(ctxUtilization)
        console.log(`[context] CRITICAL: ${Math.round(ctxUtilization * 100)}% — injected finish warning + algedonic pain`)
        continue
      } else if (ctxUtilization > 0.65) {
        console.log(`[context] WARNING: ${Math.round(ctxUtilization * 100)}% — model should start implementing`)
      }

      // Governance status log
      const govReport = this.governance.getReport()
      console.log(`[governance] status=${govReport.status} s3s4=${govReport.s3s4Balance} tools=${govReport.toolSuccessRate.toFixed(2)} stuck=${govReport.stuckTurns}`)

      // Auto-retry: if the model produced no tool calls despite having tools available,
      // nudge it to use tools. Track consecutive nudges to escalate or give up.
      const noToolsEndTurn = toolUseBlocks.length === 0 && stopReason === 'end_turn'
      // Case 1: Only thinking tokens, no content — model deliberated but didn't act
      const isThinkingWithoutActing = noToolsEndTurn && reasoningTokenCount > 0 && tokenCount === 0
      // Case 2: Short text + heavy thinking — describing instead of doing
      const isDescribingInsteadOfDoing = noToolsEndTurn && tokenCount > 0 && tokenCount < 100 && reasoningTokenCount > tokenCount * 2
      // Case 3: Tools were used earlier in session but model stopped using them.
      // This catches the "let me check... actually... wait..." narration pattern
      // where the model writes hundreds of tokens of internal monologue instead of calling Read.
      // No token count cap — any text-only response mid-session gets one nudge attempt.
      const isMidPlanStop = noToolsEndTurn && toolsUsedInSession.length > 0
      if (isThinkingWithoutActing || isDescribingInsteadOfDoing || isMidPlanStop) {
        this.consecutiveNudges++
        if (this.consecutiveNudges <= 5) {
          const nudgeText = this.consecutiveNudges <= 1
            ? 'Do not describe what you will do. Call a tool now. If you need to read a file, call Read. If you need to write, call Write. If you need to search, call Grep. Act, do not narrate.'
            : this.consecutiveNudges <= 3
              ? `WARNING ${this.consecutiveNudges}: You MUST call a tool. Do not explain, do not plan, do not narrate. Call Read, Write, Edit, Grep, or Bash RIGHT NOW.`
              : 'FINAL WARNING: Call a tool immediately or your turn ends.'
          console.log(`[s2] Nudge ${this.consecutiveNudges}: ${nudgeText.slice(0, 50)}...`)
          // Push directly and continue — steering queue gets consumed too late (after exit)
          this.addMessage({ role: 'user', content: [{ type: 'text', text: nudgeText }] })
          continue
        } else {
          // Exhausted nudges — inject continuation with original task
          const firstUserMsg = this.messages.find(m => m.role === 'user')
          const originalTask = firstUserMsg?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').slice(0, 200) ?? ''
          console.log(`[s2] Nudge exhausted — injecting continuation with original task`)
          this.consecutiveNudges = 0
          this.addMessage({ role: 'user', content: [{ type: 'text', text: `CONTINUE WORKING. You stopped without finishing. Your original task was: "${originalTask}". Call a tool now to make progress.` }] })
          continue
        }
      }

      if (toolUseBlocks.length === 0 || stopReason !== 'tool_use') {
        // Before exiting: check whether the model ended silently after tool use
        // and if so, queue a summary follow-up to force one more turn.
        if (!this.vibeMode && shouldInjectSummary(streamedText, stopReason, toolsUsedInSession, summaryInjected)) {
          summaryInjected = true
          console.log(`[s2] Summary follow-up queued`)
          this.emit({ type: 'summary.injected', toolsUsed: Array.from(new Set(toolsUsedInSession)) })
          const summaryMsg = buildSummaryInjectionMessage(toolsUsedInSession)
          this.steering.followUp(summaryMsg.content[0].text, 'summary')
        }

        // S2: Check for follow-up messages
        const followUpMsg = this.steering.nextFollowUp()
        if (followUpMsg) {
          console.log(`[s2] Follow-up from ${followUpMsg.source}`)
          this.addMessage({
            role: 'user',
            content: [{ type: 'text', text: followUpMsg.text }],
          })
          continue
        }

        // Check workflow gate and auto-advance at end of turn
        if (this.workflowEngine.isActive) {
          this.workflowEngine.incrementTurn()
          const gateSatisfied = this.workflowEngine.checkGate(stopReason, null)
          if (gateSatisfied) {
            const phase = this.workflowEngine.currentPhase
            const transitions = phase?.transitions ?? []
            if (transitions.length === 1 && transitions[0] !== 'done') {
              this.workflowEngine.advance(transitions[0])
              this.emit({ type: 'stream.token', text: `\n[Workflow] Phase: ${transitions[0]}\n` })
            }
          }
        }

        // No tool calls — we're done
        this.emit({
          type: 'message.complete',
          messageId: lastMessageId,
          stopReason,
        })

        // Decision logging
        try {
          this.decisionLogger.log({
            timestamp: Date.now(),
            userMessageSummary: this.messages.filter(m => m.role === 'user').pop()?.content?.[0]?.text?.slice(0, 200) ?? '',
            activeWorkflow: this.workflowEngine.state?.workflow.name ?? null,
            contextUsagePercent: estimatedTokens / contextLength,
            toolsCalled: toolsUsedThisTurn,
            toolResults: toolResultsThisTurn,
            modelUsed: this.config.model ?? 'unknown',
            stopReason,
            tokenCount,
            latencyMs: Date.now() - iterationStartMs,
          })
        } catch {}

        return
      }

      // Execute tool calls and feed results back
      // S1: Group read-only tools for parallel execution
      this.consecutiveNudges = 0
      const toolResults: Message['content'] = []
      const P_READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'CodeSearch', 'Ls', 'ImageView', 'Git'])
      const batches = classifyParallelBatches(toolUseBlocks, P_READ_ONLY)

      for (const batch of batches) {
        if (batch.length > 1) {
          console.log(`[s1] Parallel batch: ${batch.map((b: any) => b.name).join(', ')}`)
          await Promise.all(batch.map((block: any) =>
            this.executeOneTool(block, toolResults, toolsUsedThisTurn, toolResultsThisTurn, toolsUsedInSession)
          ))
        } else {
          await this.executeOneTool(batch[0], toolResults, toolsUsedThisTurn, toolResultsThisTurn, toolsUsedInSession)
        }
      }

      // Snapshot: track workspace state after tool batch
      if (this.snapshot) {
        try {
          const newHash = this.snapshot.track()
          if (this.lastSnapshotHash && newHash !== this.lastSnapshotHash) {
            const diff = this.snapshot.diff(this.lastSnapshotHash, newHash)
            // Filter out index/debug files — only count user code changes
            const userFiles = diff.files.filter((f: any) =>
              !f.path?.includes('.cynco') && !f.path?.includes('.cynco') && !f.path?.includes('.cynco-')
            )
            if (userFiles.length > 0) {
              console.log(`[snapshot] ${userFiles.length} user files changed (${diff.totalAdditions}+ ${diff.totalDeletions}-)`)
              this.governance.onFileProgress(userFiles.length, diff.totalAdditions, diff.totalDeletions)
            }
          }
          this.lastSnapshotHash = newHash
        } catch (e) {
          console.log(`[snapshot] Track failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // Read loop detection: track consecutive read-only tool calls.
      // If the model reads extensively without writing, nudge it to act.
      // Uses a ratio: after the model has read 3x more than it's written,
      // and at least 6 consecutive reads, suggest implementing.
      const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'CodeSearch', 'Ls', 'ImageView'])
      const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'Bash'])
      const totalReads = toolsUsedInSession.filter(t => READ_ONLY.has(t)).length
      const totalWrites = toolsUsedInSession.filter(t => WRITE_TOOLS.has(t)).length
      const recentTools = this.toolHistory.slice(-6)
      const inReadLoop = recentTools.length >= 6 && recentTools.every(t => READ_ONLY.has(t))
      if (inReadLoop && totalReads > (totalWrites + 1) * 3) {
        console.log(`[s2] Read-heavy pattern: ${totalReads} reads vs ${totalWrites} writes`)
        this.steering.steer(
          `SYSTEM: You have read ${totalReads} times and written ${totalWrites} times. Your last 6 tool calls were all read-only. Consider whether you have enough information to start implementing. Use Write or Edit to make changes.`,
          'readLoop'
        )
      }

      // Add tool results as a user message (OpenAI format for Ollama)
      this.addMessage({
        role: 'user',
        content: toolResults,
      })

      // Loop back to call model again with tool results
    }

    console.warn('[loop] Max iterations reached')
    this.emit({ type: 'stream.token', text: '\n[System] Max tool call iterations reached. Stopping.\n' })
    this.emit({ type: 'message.complete', messageId: '', stopReason: 'max_iterations' })
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  startWorkflow(workflow: WorkflowDefinition): void {
    this.workflowEngine.start(workflow)
  }

  cancelWorkflow(): void {
    this.workflowEngine.cancel()
  }

  get activeWorkflow(): string | null {
    return this.workflowEngine.state?.workflow.name ?? null
  }

  getGovernanceReport() {
    return this.governance.getReport()
  }

  /** GSD→VSM: Report verification outcome as algedonic signal. */
  reportVerification(passed: boolean, details?: string): void {
    this.governance.onVerificationResult(passed, details)
  }

  /** GSD→VSM: Report context exhaustion as algedonic signal. */
  reportContextCritical(utilization: number): void {
    this.governance.onContextCritical(utilization)
  }

  private async executeOneTool(
    block: any,
    toolResults: Message['content'],
    toolsUsedThisTurn: string[],
    toolResultsThisTurn: ('success' | 'failure' | 'denied')[],
    toolsUsedInSession: string[],
  ): Promise<void> {
    const toolId = block.id ?? randomUUID()
    const toolName = block.name ?? 'unknown'
    const toolInput = block.input ?? {}

    console.log(`[loop] Executing tool: ${toolName}`)

    // Vibe Guardian: check risk level before execution
    const { classifyRisk, describeRisk } = await import('./guardianRules.js')
    const risk = classifyRisk(toolName, toolInput)
    const expertise = this.config.expertise ?? 'advanced'

    if (expertise === 'beginner' && risk === 'dangerous') {
      // Auto-block dangerous actions for beginners
      const riskDesc = describeRisk(toolName, toolInput, risk)
      console.log(`[guardian] BLOCKED (dangerous, beginner): ${toolName}`)
      this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
      this.emit({ type: 'stream.token', text: `\n[Guardian] Blocked: ${riskDesc}\nThe AI has been asked to find a safer approach.\n` })
      this.emit({ type: 'tool.complete', toolId, result: `BLOCKED: ${riskDesc}`, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: `This action was blocked by the safety guardian: ${riskDesc}. Find a safer way to accomplish this.` }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('denied')
      toolsUsedInSession.push(toolName)
      return
    }

    if (expertise === 'beginner' && risk === 'risky') {
      // Warn via approval request for risky actions
      const riskDesc = describeRisk(toolName, toolInput, risk)
      console.log(`[guardian] WARNING (risky, beginner): ${toolName}`)
      this.emit({
        type: 'approval.request',
        requestId: toolId,
        toolName,
        description: riskDesc,
        risk: 'medium',
      })
      // For now, proceed with execution (full approval flow requires async wait)
      // TODO: wire into approval response system for actual blocking
    }

    this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })

    const toolStartMs = Date.now()
    const result = await this.executor.execute(toolName, toolInput)

    console.log(`[loop] Tool result: ${toolName} isError=${result.isError}`)

    // Circuit breaker: track consecutive failures per tool
    if (result.isError) {
      const count = (this.toolFailureCounts.get(toolName) ?? 0) + 1
      this.toolFailureCounts.set(toolName, count)
      if (count >= 3) {
        console.log(`[loop] Circuit breaker: ${toolName} failed ${count} times — overriding result`)
        result.output = `CIRCUIT BREAKER: ${toolName} has failed ${count} consecutive times with errors. STOP using ${toolName} with these arguments. Try a DIFFERENT approach:\n- If running a script that has import errors, fix the imports first with Edit\n- If a file path is wrong, use Glob or Ls to find the correct path\n- If a command fails, read the error carefully before retrying\n\nOriginal error: ${result.output.slice(0, 300)}`
      }
    } else {
      this.toolFailureCounts.delete(toolName)
    }

    if (!this.vibeMode) {
      this.emit({
        type: 'tool.complete',
        toolId,
        result: result.output.slice(0, 500),
        isError: result.isError,
      })
    }

    // Governance: record tool result
    this.governance.onToolResult(toolName, !result.isError, Date.now() - toolStartMs, result.output)

    // Autopoietic: update session homeostat with current measurements
    const sessionH = this.governance.getSessionHomeostat()
    if (sessionH) {
      // Essential variables computed from REAL cybernetics outputs
      const govReport = this.governance.getReport()
      const feedbackActions = this.governance.getFeedbackActions()
      const varietySnap = this.governance.getVarietySnapshot()
      const turnResult = sessionH.update({
        tool_error_rate: 1.0 - govReport.toolSuccessRate,           // from AlgedonicChannel
        context_utilization: feedbackActions?.compressionUrgency ?? 0, // from FeedbackControl
        stuck_turns: govReport.stuckTurns,                            // from stuck detection
        token_efficiency: varietySnap?.ratio ?? 1.0,                  // from VarietyEngine
        reflection_frequency: this.governance.getReflector().getFrequency(),
      })
      if (turnResult.perturbed) {
        console.log(`[vsm] Mid-session perturbation: mag=${turnResult.magnitude.toFixed(1)}, breached=${turnResult.breached.join(',')}`)
      }
    }

    // Track for decision logging
    toolsUsedThisTurn.push(toolName)
    toolResultsThisTurn.push(result.isError ? 'failure' : 'success')
    toolsUsedInSession.push(toolName)
    this.toolHistory.push(toolName)
    if (this.toolHistory.length > 50) this.toolHistory = this.toolHistory.slice(-50)

    // S4: Track file operations for structured compaction
    const filePath = (toolInput.file_path as string) ?? (toolInput.path as string) ?? ''
    if (filePath) {
      this.fileTracker.record(filePath, toolName)
    }

    // Collect LSP diagnostics after Edit/Write operations
    let lspContext = ''
    if (!result.isError && ['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
      const filePath = (toolInput.file_path as string) ?? ''
      if (filePath) {
        try {
          const diags = await this.lspManager.getDiagnostics(filePath)
          if (diags.length > 0) {
            lspContext = '\n' + this.lspManager.formatForModel(diags)
          }
        } catch { /* ignore LSP errors */ }

        // Re-index the modified file so CodeIndex stays current
        try {
          const { ProjectIndexer } = await import('../index/indexer.js')
          const path = require('path')
          const indexer = new ProjectIndexer(this.executor['cwd'])
          const relative = path.relative(this.executor['cwd'], path.resolve(this.executor['cwd'], filePath))
          await indexer.reindexFile(relative)
          indexer.close()
        } catch { /* index not available — non-fatal */ }
      }
    }

    const fullOutput = result.output + lspContext
    const truncatedOutput = truncateToolOutput(toolName, fullOutput)
    if (truncatedOutput.length < fullOutput.length) {
      console.log(`[s3] Truncated ${toolName} output: ${fullOutput.length} → ${truncatedOutput.length} bytes`)
      // For Bash, write full output to disk so user can inspect
      if (toolName === 'Bash') {
        try {
          const fs = require('fs')
          const path = require('path')
          fs.writeFileSync(path.join(this.executor['cwd'], '.cynco-bash-output.txt'), result.output)
        } catch {}
      }
    }
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolId,
      content: [{ type: 'text', text: truncatedOutput }],
      is_error: result.isError,
    })

    // Check workflow gate after each tool result
    if (this.workflowEngine.isActive) {
      const gateSatisfied = this.workflowEngine.checkGate('tool_result', {
        tool: toolName,
        output: result.output,
      })
      if (gateSatisfied) {
        console.log(`[loop] Workflow gate satisfied by ${toolName}`)
      }
    }
  }

  private formatToolDescription(toolName: string, input: Record<string, unknown>): string {
    const entries = Object.entries(input)
      .map(([k, v]) => {
        const val = typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '...' : String(v)
        return `${k}: ${val}`
      })
      .join('\n  ')
    return `${toolName}\n  ${entries}`
  }
}
