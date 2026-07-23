/**
 * Conversation loop for the CynCo engine.
 *
 * Handles the full cycle: user message -> model -> tool calls -> execute -> feed back -> model -> ...
 */

import { randomUUID } from 'crypto'
import type { EngineEvent, TUICommand, DiffHunk, DiffLine } from './protocol.js'
import type { ThinkingConfig } from '../types.js'
import { asSystemPrompt } from '../types.js'
import type { LocalCodeConfig } from '../config.js'
import { isS5EnforcementEnabled } from '../config.js'
import type { Provider } from '../provider.js'
import { localCallModel, type CallModelDeps } from '../engine/callModel.js'
import { ALL_TOOLS } from '../tools/registry.js'
import { ToolExecutor, type RequestApprovalFn } from '../tools/executor.js'
import { ToolScorer } from '../tools/toolScorer.js'
import { DifficultyClassifier } from '../vsm/difficultyClassifier.js'
import { withReflexion } from '../vsm/reflexionFeedback.js'
import { ToolGating, applyToolGate } from '../vsm/toolGating.js'
import { TestDrivenGovernor, shouldNudgeTests } from '../vsm/testDrivenGov.js'
import type { ToolTrustProfile } from '../tools/approvalGate.js'
import { WorkflowEngine } from '../workflows/engine.js'
import type { WorkflowDefinition } from '../workflows/types.js'
import { LSPManager } from '../lsp/manager.js'
import { CyberneticsGovernance as GovernanceLayer } from '../vsm/cyberneticsGovernance.js'
import { buildGovernanceSignal } from '../vsm/governanceSignal.js'
import { WorkspaceSnapshot } from '../snapshot/snapshot.js'
import type { SnapshotHash } from '../snapshot/types.js'
import { runAdvisors, type SystemState as AdvisorState } from '../agents/advisorRouter.js'
import { DecisionLogger } from '../decisions/logger.js'
import { ContextCompressor, FileOperationTracker } from '../context/compressor.js'
import type { S5Orchestrator } from '../s5/orchestrator.js'
import { SubAgentRunner } from '../agents/runner.js'
import { S2Coordinator } from '../agents/s2Coordinator.js'
import { SubAgent } from '../agents/subAgent.js'
import type { SubAgentConfig, SubAgentResult } from '../agents/types.js'
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
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'
import { buildConceptTableForCwd } from '../vsm/conceptTable.js'
import { evaluateGrounding, extractAddedText, extractTargetPaths } from '../vsm/groundingTrigger.js'
import { ReadLoopGate, signature as readSignature } from '../vsm/readLoopGate.js'
import { ToolDivergenceDetector } from '../brain/toolDivergence.js'
import { pruneRedundantReads } from './contextHygiene.js'
import { probeEdit } from '../vsm/groundingProbe.js'
import { loadInterventionRates, saveInterventionRates } from '../vsm/interventionPersistence.js'
import { applyNudgeTemperature } from '../vsm/controlSignals.js'
import { globalContract } from '../tools/contract.js'
import { applyHarnessContract, maybeAutoCreateContract, type HarnessContractSpec } from './contractAutoCreate.js'
import { globalAskBroker } from '../tools/askBroker.js'
import { setSideQuery, resetMergeTracking } from '../tools/impl/edit.js'
import { estimateTokensAsync } from '../engine/contextBudget.js'
import { isMalformedInput } from '../engine/toolCallRepair.js'
import { extractSimulatedToolCalls } from '../ollama/simulated.js'
import { ThinkingRecorder } from '../memory/thinkingRecorder.js'
import { UncertaintyTracker } from '../memory/uncertaintyTracker.js'

/**
 * Phase 6: build structured diff hunks from a write-tool input for the file.diff
 * event. Whole-content add-hunk for Write; a single old→new hunk for Edit.
 * No LCS — a coarse line-by-line diff is enough for the TUI preview.
 */
export function buildDiffHunks(toolName: string, input: Record<string, unknown>): DiffHunk[] {
  if (toolName === 'Write') {
    const content = String(input.content ?? '')
    if (!content) return []
    const lines: DiffLine[] = content.split('\n').map(text => ({ kind: 'add' as const, text }))
    return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
  }
  if (toolName === 'Edit') {
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    if (!oldStr && !newStr) return []
    const oldLines = oldStr ? oldStr.split('\n') : []
    const newLines = newStr ? newStr.split('\n') : []
    const lines: DiffLine[] = [
      ...oldLines.map(text => ({ kind: 'del' as const, text })),
      ...newLines.map(text => ({ kind: 'add' as const, text })),
    ]
    return [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines }]
  }
  // MultiEdit: concatenate each edit's old→new as one hunk.
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    const lines: DiffLine[] = []
    for (const e of edits as Array<Record<string, unknown>>) {
      const oldStr = String(e.old_string ?? '')
      const newStr = String(e.new_string ?? '')
      if (oldStr) for (const text of oldStr.split('\n')) lines.push({ kind: 'del', text })
      if (newStr) for (const text of newStr.split('\n')) lines.push({ kind: 'add', text })
    }
    if (lines.length === 0) return []
    return [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines }]
  }
  return []
}

type Message = {
  role: 'user' | 'assistant' | 'system'
  content: { type: string; text?: string; [key: string]: unknown }[]
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Ls', 'Git', 'ImageView']
const SAFE_MODE_TOOLS = [...READ_ONLY_TOOLS, 'Bash']

// S3 Resource Management: prevent single tool output from consuming all context
const TOOL_OUTPUT_LIMITS: Record<string, { maxLines: number; maxBytes: number }> = {
  Read:       { maxLines: 200, maxBytes: 50_000 },
  Bash:       { maxLines: 100, maxBytes: 20_000 },
  Grep:       { maxLines: 100, maxBytes: 30_000 },
  Glob:       { maxLines: 100, maxBytes: 30_000 },
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
  /** Hard-pin the tool set (e.g. unattended one-shot mission runs). Applied on top of workflow restrictions. */
  allowedTools?: string[]
  /** Direct dashboard broadcast for brain.* messages (NOT the engine→TUI protocol). Optional. */
  dashboardBroadcast?: (msg: Record<string, unknown>) => void
}

export class ConversationLoop {
  private messages: Message[] = []
  private abortController: AbortController | null = null
  private processing = false
  private config: LocalCodeConfig
  private provider: Provider
  private emit: (event: EngineEvent) => void
  private executor: ToolExecutor
  private toolScorer = new ToolScorer()
  private toolScorerPath = require('path').join(require('os').homedir(), '.cynco', 'tool-scores.json')
  // Observed task difficulty from turn telemetry — feeds S5Input.promptDifficulty
  private difficultyClassifier = new DifficultyClassifier()
  // Grounding trigger: concepts fired on, awaiting a re-edit to judge intervention success
  private pendingGroundingConcepts = new Set<string>()
  private groundingRatesLoaded = false
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  private workflowEngine: WorkflowEngine
  private lspManager: LSPManager
  private governance: GovernanceLayer
  private decisionLogger = new DecisionLogger()
  private compressor = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
  private fileTracker = new FileOperationTracker()
  private s5?: S5Orchestrator
  private agentRunner: SubAgentRunner
  private s2: S2Coordinator
  private runningAgents = new Map<string, SubAgent>()
  private agentResults = new Map<string, SubAgentResult>()
  private toolHistory: string[] = []  // Track tool names for VSM advisors
  private toolFailureCounts: Map<string, number> = new Map()
  private consecutiveNudges = 0
  private lastTokPerSec = 0
  private lastModelCallMs = 0
  private steering = new SteeringQueue()
  private readLoopGate = new ReadLoopGate()
  private toolDivergence = new ToolDivergenceDetector()
  private lastToolEntropy: number | null = null
  // _TRACE_STEERING=1: records the source of the intervention injected on the
  // PREVIOUS iteration so the next model-call trace line can attribute the
  // model's resulting action to it. Diagnostic only; null when tracing is off.
  private traceLastInjected: string | null = null
  private journal: JSONLStore
  private sessionId: string = ''
  // Index-degradation state surfaced on context.status (Task 13).
  private indexDegraded?: boolean
  private lastQueryMode?: 'hybrid' | 'vector' | 'keyword'
  private snapshot?: WorkspaceSnapshot
  private snapshotCwd?: string
  private lastSnapshotHash?: SnapshotHash
  /** Undo targets: one entry per write batch that changed user files (P1.4). */
  private snapshotUndoStack: Array<{ prevHash: SnapshotHash; newHash: SnapshotHash; filesChanged: number; additions: number; deletions: number }> = []
  private vibeMode = false
  private _correctionAttempts = 0
  /** P1.8 bounded retry: consecutive malformed tool-call parses. 0 = healthy. */
  private _malformedToolCalls = 0
  private toolGating = new ToolGating()
  private tddGov = new TestDrivenGovernor()
  private allowedTools?: string[]
  // Tool names actually offered to the model in the current iteration (after
  // S5 restrictions, demotions, routing). In one-shot runs this is enforced
  // at execution time too — see executeOneTool.
  private offeredToolNames: Set<string> | null = null
  // Brain stream: thinking persistence + uncertainty tracking
  private thinkingRecorder: ThinkingRecorder | null = null
  private uncertainty = new UncertaintyTracker()
  /** Direct dashboard broadcast (NOT protocol) — brain.* messages only. Optional. */
  private dashboardBroadcast: ((msg: Record<string, unknown>) => void) | null = null
  private uncertaintyBatch: { i: number; h: number; kind: 'thinking' | 'output' | 'tool'; top: { token: string; logprob: number }[] }[] = []
  private uncertaintyIndex = 0

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

    this.toolScorer.load(this.toolScorerPath)
    this.executor = new ToolExecutor({
      cwd: opts.cwd ?? process.cwd(),
      requestApproval,
      trustProfile: opts.trustProfile,
      approveAll: opts.config.approveAll,
      toolScorer: this.toolScorer,
    })

    // Inject sideQuery into Edit tool for semantic merge fallback
    setSideQuery((prompt: string, system?: string) => {
      const fullPrompt = system ? `${system}\n\n${prompt}` : prompt
      return this.sideQuery(fullPrompt)
    })

    this.workflowEngine = opts.workflowEngine ?? new WorkflowEngine((event) => {
      // Translate internal workflow events to protocol events for the TUI
      if (event.type === 'workflow.phase_changed') {
        const wf = this.workflowEngine.state?.workflow
        this.emit({ type: 'workflow.status', active: true, workflow: wf?.name ?? null, phase: event.toPhase, displayName: wf?.displayName ?? null })
        // Inform governance about read-only phases so stuck detection pauses
        const phase = wf?.phases[event.toPhase]
        const isReadOnly = phase?.allowedTools != null && !phase.allowedTools.some(t => ['Write', 'Edit', 'MultiEdit', 'Bash', 'ApplyPatch'].includes(t))
        this.governance.setWorkflowReadOnlyPhase(isReadOnly)
      } else if (event.type === 'workflow.started') {
        // Check if initial phase is read-only
        const wf = this.workflowEngine.state?.workflow
        const phase = wf?.phases[event.phase]
        const isReadOnly = phase?.allowedTools != null && !phase.allowedTools.some(t => ['Write', 'Edit', 'MultiEdit', 'Bash', 'ApplyPatch'].includes(t))
        this.governance.setWorkflowReadOnlyPhase(isReadOnly)
      } else if (event.type === 'workflow.completed' || event.type === 'workflow.cancelled') {
        this.emit({ type: 'workflow.status', active: false, workflow: null, phase: null, displayName: null })
        this.governance.setWorkflowReadOnlyPhase(false)
      }
    })
    this.lspManager = new LSPManager(opts.cwd ?? process.cwd())
    this.governance = new GovernanceLayer((alert) => {
      this.emit({ type: 'governance.alert', severity: alert.severity, message: alert.message, source: alert.source })
    })
    this.s5 = opts.s5
    this.allowedTools = opts.allowedTools
    this.agentRunner = new SubAgentRunner(async (task) => {
      // Simplified sub-agent execution — full execution comes later
      return `[SubAgent completed] ${task.task}`
    })

    this.s2 = new S2Coordinator({
      pollGpuUtil: async () => {
        try {
          const resp = await fetch(`${this.config.baseUrl}/api/ps`)
          const data = await resp.json() as any
          if (data.models?.length > 0) {
            const model = data.models[0]
            const used = model.size_vram ?? 0
            const total = model.size ?? used
            return total > 0 ? used / total : 0.5
          }
          return 0
        } catch {
          return 0.5
        }
      },
    })

    // Initialize workspace snapshot for governance
    this.initSnapshot(this.executor['cwd'])

    // S5: Session journal for crash recovery
    this.sessionId = `session-${Date.now()}`
    this.journal = new JSONLStore(this.sessionId)
    // Stamp the session id so SaveLearning tags learnings for AWM promotion.
    process.env.LOCALCODE_SESSION_ID = this.sessionId
    // Unify governance's session id with the conversation loop's so the
    // decision journal and the outcome/prediction rows share one join key.
    this.governance.setSessionId(this.sessionId)
    console.log(`[session] Journal: ${this.journal.path}`)

    // Brain stream: thinking recorder uses same session id as the JSONL journal
    this.thinkingRecorder = new ThinkingRecorder(this.sessionId)
    this.dashboardBroadcast = opts.dashboardBroadcast ?? null

    // Human-in-the-loop: surface AskUser questions to the TUI over the bridge.
    globalAskBroker.setEmitter(({ requestId, question, options }) => {
      this.emit({ type: 'ask.request', requestId, question, options })
    })
  }

  /**
   * (Re)initialize the workspace snapshot for the given cwd.
   * Called at construction and again whenever the executor cwd changes
   * (e.g. a user.message arrives with a different project directory) —
   * otherwise snapshots run `git add -A` against the engine's startup dir.
   */
  /** Reset per-model-call brain state; called at model-call start so aborted/failed calls can't bleed. */
  private resetBrainTurnState(): void {
    this.uncertainty.reset()
    this.uncertaintyBatch = []
    this.uncertaintyIndex = 0
    this.thinkingRecorder?.discardBuffer()
  }

  /** Track entropy + batch brain.uncertainty messages to the dashboard. */
  private observeUncertainty(kind: 'thinking' | 'output' | 'tool', logprobs: import('../types.js').TokenLogprob[]): void {
    this.uncertainty.observe(kind, logprobs)
    if (!this.dashboardBroadcast) return
    for (const tl of logprobs) {
      const h = UncertaintyTracker.entropy(tl)
      if (h === null) continue
      if (kind === 'tool') { this.toolDivergence.observeEntropy(h); this.lastToolEntropy = h }
      this.uncertaintyBatch.push({ i: this.uncertaintyIndex++, h, kind, top: tl.top.slice(0, 8) })
    }
    if (this.uncertaintyBatch.length >= 16) this.flushUncertainty()
  }

  private flushUncertainty(): void {
    if (this.uncertaintyBatch.length === 0 || !this.dashboardBroadcast) return
    const toolPts = this.uncertaintyBatch.filter(p => p.kind === 'tool')
    const restPts = this.uncertaintyBatch.filter(p => p.kind !== 'tool')
    try {
      if (restPts.length) this.dashboardBroadcast({ type: 'brain.uncertainty', points: restPts })
      if (toolPts.length) this.dashboardBroadcast({ type: 'brain.toolUncertainty', points: toolPts })
    } catch (err) {
      console.log(`[brain] uncertainty broadcast failed: ${err}`)
    }
    this.uncertaintyBatch = []
  }

  private initSnapshot(cwd: string): void {
    // Undo entries reference tree objects in the previous cwd's snapshot repo —
    // unrestorable after re-init, so drop them (P1.4 review I1).
    this.snapshotUndoStack = []
    try {
      const fs = require('fs')
      const path = require('path')
      const { execSync } = require('child_process')
      // If not a git repo, make it one — snapshots need git
      if (!fs.existsSync(path.join(cwd, '.git'))) {
        execSync('git init', { cwd, stdio: 'pipe' })
        console.log('[snapshot] Initialized git repo in project directory')
      }
      this.snapshot = new WorkspaceSnapshot(cwd)
      this.snapshot.init()
      this.lastSnapshotHash = this.snapshot.track()
      this.snapshotCwd = cwd
      console.log(`[snapshot] Initialized workspace snapshot for ${cwd}`)
    } catch (e) {
      this.snapshot = undefined
      this.snapshotCwd = cwd
      console.log(`[snapshot] Failed to initialize: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  get isProcessing(): boolean {
    return this.processing
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      // Don't null the controller — the model loop checks signal.aborted
      // Setting it to null makes the check `this.abortController?.signal.aborted`
      // return undefined instead of true, so the loop never stops.
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

  /** Route a human's answer to a pending AskUser question back to the broker. */
  handleAskAnswer(requestId: string, answer: string): void {
    globalAskBroker.answer(requestId, answer)
  }

  setApproveAll(value: boolean): void {
    this.executor.setApproveAll(value)
  }

  /** Append message to both in-memory array and JSONL journal. */
  private addMessage(msg: Message): void {
    this.messages.push(msg)
    try { this.journal.appendMessage(msg) } catch (e) { console.log(`[session] journal append failed: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /** Resume a previous session from JSONL journal. */
  resume(sessionId: string): boolean {
    const store = new JSONLStore(sessionId)
    const messages = store.loadMessages()
    if (messages.length > 0) {
      this.messages = messages
      this.journal = store
      this.sessionId = sessionId
      this.thinkingRecorder = new ThinkingRecorder(this.sessionId)
      process.env.LOCALCODE_SESSION_ID = sessionId
      this.governance.setSessionId(sessionId)
      // Rehydrate the file-operation tracker from the last journaled compaction
      // so a resumed session doesn't "forget" what it already read/edited.
      try {
        const ops = store.loadFileOps()
        if (ops) this.fileTracker = FileOperationTracker.deserialize(ops)
      } catch { /* non-fatal */ }
      // S5 Identity Continuity: distinguish a clean prior shutdown from a crash.
      const priorClean = (() => { try { return store.hasEnded() } catch { return false } })()
      console.log(`[session] Resumed ${sessionId}: ${messages.length} messages (prior session ${priorClean ? 'ended cleanly' : 'did not end cleanly — possible crash'})`)
      return true
    }
    return false
  }

  /**
   * Proactive scout dispatch — the engine decides when to spawn scouts.
   *
   * Analyzes the user message and spawns read-only scout agents to gather
   * codebase context BEFORE the main model runs. Returns scout results
   * that get injected as system context.
   *
   * Triggers:
   * - Task mentions exploring/finding/understanding code ("find all", "how does", "what files")
   * - Task is complex (long message, mentions multiple concerns)
   * - Workflow is in create_plan or exploration phase
   * - First message in a session (needs project orientation)
   */
  private async proactiveScoutDispatch(userMessage: string): Promise<SubAgentResult[]> {
    // LOCALCODE_NO_SCOUTS=true disables all proactive scouting (for automated execution)
    if (this.config.noScouts) {
      return []
    }

    const msg = userMessage.toLowerCase()
    const wordCount = msg.split(/\s+/).length

    // Determine if scouts would help
    const isExploration = /\b(find|search|look for|explore|understand|how does|what files|where is|show me|list all|trace|dependency|dependencies|related|architecture)\b/.test(msg)
    const isComplex = wordCount > 30 || /\b(and then|also|multiple|several|all the|every|entire|whole)\b/.test(msg)
    const isFirstMessage = this.messages.filter(m => m.role === 'user').length <= 1
    const isPlanning = this.workflowEngine.currentPhase?.name === 'create_plan'

    if (!isExploration && !isComplex && !isFirstMessage && !isPlanning) {
      return []
    }

    // Skip scouts for llama-cpp provider — each scout call costs 5-7s prompt eval
    // with no caching (SWA invalidates). Scouts add 40-60s overhead per task.
    if (this.config.provider === 'llama-cpp') {
      console.log('[scouts] Skipping proactive dispatch for llama-cpp provider (no prompt cache)')
      return []
    }

    console.log(`[scouts] Proactive dispatch triggered: exploration=${isExploration} complex=${isComplex} first=${isFirstMessage} planning=${isPlanning}`)

    // Build scout tasks based on what the user needs
    const scoutTasks: string[] = []

    if (isFirstMessage || isPlanning) {
      // Orientation scout — understand the project structure
      scoutTasks.push(
        `Survey the project at ${this.executor['cwd']}. FIRST use the CodeIndex tool to search for key concepts like "main", "entry", "app", "config". THEN use Ls and Glob to list main directories. Summarize what this project is and how it's structured in 200 words or less.`
      )
    }

    if (isExploration || isComplex) {
      // Targeted scout — search for what the user is asking about
      scoutTasks.push(
        `Search the codebase at ${this.executor['cwd']} for code related to: "${userMessage.slice(0, 200)}". FIRST use the CodeIndex tool to find semantically relevant code. THEN use Grep for specific symbols. Report file paths and brief descriptions of what each does. Be concise — 300 words max.`
      )
    }

    // Cap at 2 scouts to avoid GPU contention
    const tasks = scoutTasks.slice(0, 2)
    if (tasks.length === 0) return []

    // Spawn scouts via S2 coordinator
    const results: SubAgentResult[] = []

    for (const task of tasks) {
      try {
        const { makeSubAgentConfig } = await import('../agents/types.js')
        const config = makeSubAgentConfig({
          task,
          persona: 'scout',
          maxIterations: 5,  // Keep scouts fast — 5 turns max
        })

        const s2Decision = await this.s2.requestSchedule(config.id)
        this.emit({
          type: 's2.decision',
          decision: s2Decision.decision,
          agentId: config.id,
          reason: s2Decision.reasoning,
          gpuUtil: s2Decision.input.gpuUtil,
          queueDepth: s2Decision.input.queueDepth,
        } as any)

        const agent = new SubAgent({
          config,
          provider: this.provider,
          emit: this.emit,
          cwd: this.executor['cwd'],
          model: this.config.model ?? 'unknown',
          s2: {
            updateAgentTurn: (id: string, turn: number, tokens: number) => {
              try { this.s2.updateAgentTurn(id, turn, tokens) } catch {}
            },
            handleAlgedonic: (id: string, signal: string) => {
              try { this.s2.handleAlgedonic(id, signal) } catch {}
            },
          },
        })

        this.s2.registerAgent(agent.status, agent)
        console.log(`[scouts] Dispatched scout ${config.id}: "${task.slice(0, 80)}..."`)

        const result = await agent.run()
        this.s2.completeAgent(config.id)

        if (result.success && result.output.length > 10) {
          results.push(result)
          console.log(`[scouts] Scout ${config.id} completed: ${result.turns} turns, ${result.output.length} chars`)
        } else {
          console.log(`[scouts] Scout ${config.id} returned empty/failed result`)
        }
      } catch (e) {
        console.log(`[scouts] Scout dispatch error: ${e}`)
      }
    }

    return results
  }

  resetGovernance(): void {
    this.governance.resetKillSwitch()
    this.consecutiveNudges = 0
    this.readLoopGate.reset()
    this.toolDivergence.reset()
    this.lastToolEntropy = null
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

  /**
   * Estimate the token count for the current message history using the
   * provider's real tokenizer when available (llama-server /tokenize),
   * falling back to the chars/4 heuristic for providers that lack countTokens
   * (e.g. Ollama).
   */
  private async estimateContextTokens(): Promise<number> {
    return estimateTokensAsync(this.messages as any, this.provider.countTokens?.bind(this.provider))
  }

  async handleUserMessage(text: string, opts?: { contract?: HarnessContractSpec }): Promise<void> {
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
    // Fresh request = fresh bounded retry: a discard last turn must not rob
    // the first malformed call of this turn of its retry (P1.8).
    this._malformedToolCalls = 0
    this.governance.resetStuck() // Fresh start for each user message
    this.governance.resetKillSwitch() // Clear kill switch from previous task
    this.consecutiveNudges = 0
    this.readLoopGate.reset()
    this.toolDivergence.reset()
    this.lastToolEntropy = null
    this.steering.clear()

    // P4.2: harness-supplied contract (mission mode — the brief's check script
    // IS the contract, STATE doc Phase 4(a)). Applied before auto-create.
    if (opts?.contract && applyHarnessContract(opts.contract)) {
      console.log(`[contract] Harness-supplied: "${opts.contract.title}" (${opts.contract.assertions.length} assertion(s))`)
      this.governance.setContractCreated()
    }
    // Auto-create contract from EVERY user message — the model must finish what
    // the user asked. A COMPLETE stale contract from a prior task is replaced
    // (P4.2 — otherwise taskError measures the wrong task); an INCOMPLETE one is
    // kept (live task / follow-up message). Skip in one-shot mission runs
    // (allowedTools pinned): the contract enforcer is calibrated for interactive
    // coding ("run the test suite NOW with Bash") and blocks a mission from
    // producing its final structured outcome (2026-06-12 weekly-digest incident).
    else if (!this.allowedTools && maybeAutoCreateContract(text)) {
      console.log(`[contract] Auto-created: ${globalContract.pendingCount()} assertions for "${text.slice(0, 50)}..."`)
      this.governance.setContractCreated()
    }

    // Start trajectory recording for this task
    try {
      const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
      const { randomUUID } = require('crypto')
      const recorder = getTrajectoryRecorder()
      if (recorder) {
        recorder.startTask(`task-${randomUUID().slice(0, 8)}`, this.config.model ?? 'unknown')
      }
    } catch {}

    // Compact when context exceeds the configured warning threshold.
    // With flash attention, attention is ~O(n) not O(n²), so we can use
    // much more of the context window before compacting.
    const estimatedTokensPreTurn = this.estimateMessageTokens()
    const ctxLen = this.config.contextLength ?? 32768
    const compactThreshold = ctxLen * (this.config.contextManagement?.warningThreshold ?? 0.4)
    if (estimatedTokensPreTurn > compactThreshold) {
      console.log(`[compact] Pre-turn: ${Math.round(estimatedTokensPreTurn)} tokens > ${Math.round(compactThreshold)} threshold`)
      await this.compactNow('pre-turn')
    }

    // Auto-inject CodeIndex results as system context — don't modify user message
    // (modifying user message leaks into memory recall display as "Prior: [Relevant code...]")
    try {
      const { ProjectIndexer } = await import('../index/indexer.js')
      const indexer = new ProjectIndexer(this.executor['cwd'])
      // Probe embed health so we can surface index degradation on context.status.
      // Non-blocking: a short deadline falls back to keyword-only retrieval.
      try {
        const { EmbedClient } = await import('../index/embedClient.js')
        const emb = await new EmbedClient().embedWithDeadline(text)
        if (emb && emb.length) {
          this.indexDegraded = false
          this.lastQueryMode = process.env.LOCALCODE_HYBRID_SEARCH !== '0' ? 'hybrid' : 'vector'
        } else {
          this.indexDegraded = true
          this.lastQueryMode = 'keyword'
        }
      } catch {
        this.indexDegraded = true
        this.lastQueryMode = 'keyword'
      }
      const results = await indexer.query({ query: text, topK: 5 })
      if (results.length > 0) {
        const context = indexer.formatResults(results)
        this.messages.splice(this.messages.length - 1, 0, {
          role: 'system',
          content: [{ type: 'text', text: `[Project code context]\n${context}` }],
        })
        console.log(`[index] Injected ${results.length} relevant chunks as system context`)
      }
      // Repo map default-on (opt out with LOCALCODE_REPO_MAP=0): top symbols by
      // import-graph PageRank, capped so it can't dominate the context budget.
      // First user turn ONLY — re-injecting every turn wasted ~2k tokens/turn
      // (2026-07-16 audit). The user message is already pushed, so count === 1.
      const isFirstUserTurn = this.messages.filter(m => m.role === 'user').length === 1
      if (isFirstUserTurn && process.env.LOCALCODE_REPO_MAP !== '0') {
        const { capRepoMap } = await import('../index/indexer.js')
        const repoMap = capRepoMap(indexer.buildRepoMap([], 20), 2000)
        if (repoMap) {
          this.messages.splice(this.messages.length - 1, 0, {
            role: 'system',
            content: [{ type: 'text', text: repoMap }],
          })
          console.log('[index] Injected capped repo map as system context')
        }
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
    // Caller-pinned tool set (one-shot mission runs) on top of any workflow restriction
    if (this.allowedTools) {
      const pinned = new Set(this.allowedTools)
      activeTools = activeTools.filter(t => pinned.has(t.name))
    }

    // Build tool definitions in the format callModel expects (inputJSONSchema)
    let toolDefs = activeTools.map(t => ({
      name: t.name,
      description: t.description,
      inputJSONSchema: t.inputSchema,
    }))
    const toolNames = activeTools.map(t => `- ${t.name}: ${t.description}`).join('\n')

    const promptParts = assembleBasePrompt(toolNames, this.executor['cwd'])

    // Inject saved learnings from previous sessions (global LearningStore).
    // TODO(P5 follow-up): repoint /learnings review command at LearningStore.
    try {
      const { LearningStore, defaultLearningsDbPath } = await import('../memory/learningStore.js')
      const fs = await import('fs')
      const dbPath = process.env.LOCALCODE_LEARNINGS_DB ?? defaultLearningsDbPath()
      if (fs.existsSync(dbPath)) {
        const store = new LearningStore(dbPath)
        const recent = store.allIncludingInvalidated().filter(l => l.invalidatedAt === null).slice(-20)
        store.close()
        if (recent.length > 0) {
          const learningLines = recent.map(l =>
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

    // Governance signal injection: tell the model it's stuck
    const stuckCount = this.governance.getStuckCount()
    if (stuckCount >= 3) {
      const signal = stuckCount >= 5
        ? `## Governance Signal — CRITICAL\n\n` +
          `CRITICAL: You have been stuck for ${stuckCount} turns. Your tools have been restricted.\n\n` +
          `You MUST change your approach NOW. Do something completely different from your last 5 actions.\n` +
          `- If you have been reading files, STOP reading and start editing or writing\n` +
          `- If editing has been failing, try a completely different file or strategy\n` +
          `- Summarize what you know and what specific problem is blocking you`
        : `## Governance Signal\n\n` +
          `WARNING: You have been repeating similar actions for ${stuckCount} turns without progress.\n\n` +
          `REQUIRED: Change your approach immediately.\n` +
          `- If reading files: stop reading and start writing or editing\n` +
          `- If editing fails: try a different file or approach\n` +
          `- If searching: stop searching and act on what you already know\n` +
          `- Summarize what you know and what specific problem is blocking you`
      promptParts.push('')
      promptParts.push(signal)
      console.log(`[vsm] Injected ${stuckCount >= 5 ? 'CRITICAL' : 'WARNING'} governance signal (stuck ${stuckCount} turns)`)
    }

    // Active contract context: remind the model of its current obligations
    if (globalContract.isActive()) {
      promptParts.push('')
      promptParts.push('## Active Contract\n' + globalContract.getStatus())
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
        const govReport = this.governance.getReport()
        const pm = this.governance.getPerformanceMetrics?.()

        // Evaluate previous S5 decision outcome (feeds rule weight tuning)
        try {
          const outcomeResult = this.s5.evaluateLastDecision(govReport as any)
          if (outcomeResult) {
            console.log(`[s5] Outcome: ${outcomeResult.outcome} for rules [${outcomeResult.ruleIds.join(',')}]`)
          }
        } catch {}

        const decision = await this.s5.makeDecision({
          userMessage: text.slice(0, 200),
          activeWorkflow: this.workflowEngine.state?.workflow.name ?? null,
          currentPhase: this.workflowEngine.currentPhase?.name ?? null,
          contextUsagePercent: estimatedTokens / ctxLength,
          // activeToolNames: rules that restrict tools (C7) must pick from
          // what THIS run actually has — not a hardcoded coding-tool list.
          governance: { ...(govReport as any), activeToolNames: toolDefs.map(t => t.name) },
          recentToolResults: [],
          availableModels: [this.config.model ?? 'unknown'],
          turnCount: this.messages.filter(m => m.role === 'user').length,
          varietyBalance: (govReport as any).varietyBalance ?? 'balanced',
          varietyRatio: (govReport as any).varietyRatio ?? 1.0,
          homeostatStable: this.governance.isStable?.() ?? true,
          homeostatConsecutiveUnstable: (govReport as any).consecutiveUnstable ?? 0,
          driftDetected: pm?.isDriftDetected?.() ?? false,
          driftDirection: pm?.isDriftDetected?.() ? 'degrading' : null,
          performanceHealth: pm?.getHealthStatus?.() === 'green' ? 'healthy' : pm?.getHealthStatus?.() === 'yellow' ? 'warning' : 'critical',
          productivityRatio: (pm as any)?.getProductivity?.() ?? 0.8,
          recommendedToolMode: this.governance.getRecommendedToolMode?.() ?? null,
          heterarchyAuthority: (() => {
            const cmd = this.governance.getLastCommander?.()
            if (!cmd) return null
            const lower = cmd.toLowerCase()
            if (lower === 's3' || lower === 's4' || lower === 's5') return lower as 's3' | 's4' | 's5'
            return null
          })(),
          agreementRatio: (govReport as any).agreementRatio ?? 1.0,
          observerDivergence: (govReport as any).observerDivergence ?? null,
          demotedTools: this.executor.getToolScorer?.()?.getDemotedTools() ?? [],
          promptDifficulty: this.difficultyClassifier.getLevel(),
          sessionId: this.sessionId,
        })

        // Earned-authority cap: when LOCALCODE_S5_ENFORCE=false, S5 decisions
        // are computed and emitted (the outcome ledger needs them) but never
        // applied. See docs/cynco-failure-log.md F7.
        const s5Enforce = isS5EnforcementEnabled()

        // Emit S5 decision to dashboard (ruleIds/enforced feed the mission
        // outcome ledger — step 2 needs per-rule attribution)
        this.emit({
          type: 's5.decision' as any,
          reasoning: decision.reasoning,
          contextAction: decision.contextAction,
          toolRestriction: decision.toolRestriction,
          modelSwitch: decision.modelSwitch,
          ruleIds: decision.ruleIds ?? [],
          enforced: s5Enforce,
          timestamp: Date.now(),
        })
        console.log(`[s5] Decision: context=${decision.contextAction} tools=${decision.toolRestriction ?? 'none'} (${decision.reasoning})`)

        // L3: APPLY S5 decisions — hard enforcement, not advisory
        if (decision.contextAction === 'compact' && !s5Enforce) {
          console.log(`[s5] WOULD-ENFORCE (capped at recommend): compact context (${decision.reasoning})`)
        } else if (decision.contextAction === 'compact') {
          console.log(`[s5] Decision: compact context (${decision.reasoning})`)
          // Trigger compaction via the S5 decision path
          const ctxLen = this.config.contextLength ?? 32768
          const estTokens = await this.estimateContextTokens()
          if (this.compressor.shouldCompress(this.messages, estTokens, ctxLen)) {
            // Single compaction path: runCompaction via compactNow (write-before-compact).
            if (await this.compactNow('s5-decision')) {
              console.log(`[s5] Context compacted by S5 decision`)
            }
          }
        }

        // Hard tool filtering: S5 decides, engine enforces — but never apply
        // a restriction that would leave the model with zero tools.
        if (decision.tools && !s5Enforce) {
          console.log(`[s5] WOULD-ENFORCE (capped at recommend): tool restriction to [${decision.tools.join(', ')}]`)
        } else if (decision.tools) {
          const allowed = new Set(decision.tools)
          const filtered = toolDefs.filter(t => allowed.has(t.name))
          if (filtered.length > 0) {
            console.log(`[s5] ENFORCE: tool restriction to [${decision.tools.join(', ')}]`)
            toolDefs = filtered
          } else {
            console.log(`[s5] ENFORCE skipped: restriction [${decision.tools.join(', ')}] would remove every available tool`)
          }
        }

        // Model switch enforcement
        if (decision.model && decision.model !== this.config.model && !s5Enforce) {
          console.log(`[s5] WOULD-ENFORCE (capped at recommend): model switch to ${decision.model}`)
        } else if (decision.model && decision.model !== this.config.model) {
          console.log(`[s5] ENFORCE: model switch to ${decision.model}`)
          this.updateModel(decision.model)
        }

        // Emit governance.recommendation for warning-tier rules
        const warningRuleIds = (decision.ruleIds ?? []).filter(id => id.startsWith('W'))
        if (warningRuleIds.length > 0) {
          const requestId = require('crypto').randomUUID()
          this.emit({
            type: 'governance.recommendation',
            requestId,
            severity: 'warning',
            signal: warningRuleIds[0],
            title: decision.reasoning.split('.')[0],
            description: decision.reasoning,
            action: {
              model: decision.model,
              tools: decision.tools,
              contextAction: decision.contextAction,
              revert: decision.revert,
              priority: decision.priority,
            },
            autoApplyAfterMs: decision.revert ? undefined : 60000,
          } as any)
          console.log(`[s5] RECOMMEND: ${warningRuleIds.join(',')} — ${decision.reasoning.slice(0, 80)}`)
        }

        console.log(`[s5] Priority: ${decision.priority} | ${decision.reasoning}`)
      } catch (err) {
        console.log(`[s5] Decision error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ─── Proactive Scout Dispatch ──────────────────────────────────
    // The engine decides when to spawn scouts — don't wait for the model.
    // Local models never call SubAgent on their own. The orchestrator
    // analyzes the task and dispatches scouts to gather context BEFORE
    // the main model runs, then injects their findings as system context.
    try {
      const scoutResults = await this.proactiveScoutDispatch(text)
      if (scoutResults.length > 0) {
        const scoutContext = scoutResults
          .map(r => `[Scout ${r.agentId} — ${r.output.slice(0, 1500)}]`)
          .join('\n\n')
        this.messages.splice(this.messages.length - 1, 0, {
          role: 'system',
          content: [{ type: 'text', text: `[Scout research results]\n${scoutContext}` }],
        })
        console.log(`[scouts] Injected ${scoutResults.length} scout results as context`)
      }
    } catch (e) {
      console.log(`[scouts] Proactive dispatch failed: ${e}`)
    }

    // ─── Best-of-N Orchestration ─────────────────────────────────
    // If enabled and tests detected: run N candidates in git worktrees,
    // pick the one with the highest test pass rate.
    let bestOfNRan = false
    try {
      const bonEnabled = (process.env.LOCALCODE_BEST_OF_N ?? 'false').toLowerCase() === 'true'
      const bonCount = parseInt(process.env.LOCALCODE_BEST_OF_N_COUNT ?? '2', 10)
      const bonTurnCap = parseInt(process.env.LOCALCODE_BEST_OF_N_TURN_CAP ?? '15', 10)
      const bonTemp = parseFloat(process.env.LOCALCODE_BEST_OF_N_TEMP ?? '0.8')

      if (bonEnabled) {
        const { detectTests } = require('../bestOfN/testDetector.js')
        const testInfo = detectTests(this.executor['cwd'])

        if (testInfo.available) {
          const { WorktreeManager } = require('../bestOfN/worktreeManager.js')
          const { extractPatch } = require('../bestOfN/patchExtractor.js')
          const { runTests, selectWinner, applyPatch } = require('../bestOfN/sampler.js')
          const mainCwd = this.executor['cwd']

          this.emit({ type: 'bestOfN.start', payload: { count: bonCount, framework: testInfo.framework, command: testInfo.command } } as any)
          console.log(`[bestOfN] Running ${bonCount} candidates — ${testInfo.framework} (${testInfo.command})`)

          // Save state for reset between candidates
          const savedMessages = JSON.parse(JSON.stringify(this.messages))
          const savedTemp = this.config.temperature
          const originalEmit = this.emit

          // Mute stream.token events during candidate runs — only pass through
          // progress markers, tool events, and governance events
          this.emit = (event: any) => {
            if (event.type === 'stream.token') return // mute model text
            originalEmit(event)
          }

          const candidates: any[] = []
          const wtManager = new WorktreeManager(mainCwd)

          try {
            for (let i = 0; i < bonCount; i++) {
              // Reset conversation to pre-candidate state
              this.messages = JSON.parse(JSON.stringify(savedMessages))
              this.config.temperature = bonTemp

              // Create worktree for this candidate
              const wtPath = await wtManager.create()
              this.executor.setCwd(wtPath)

              // Emit progress
              originalEmit({
                type: 'stream.token',
                text: `\n**Best-of-N: sampling candidate ${i + 1}/${bonCount}...**\n`,
                messageId: '',
              } as any)

              console.log(`[bestOfN] Candidate ${i + 1}/${bonCount} in ${wtPath}`)

              try {
                await this.runModelLoop(systemPrompt, thinkingConfig, toolDefs, deps, bonTurnCap)
              } catch (e) {
                console.log(`[bestOfN] Candidate ${i + 1} loop error: ${e}`)
              }

              // Extract patch and run tests
              const patch = extractPatch(wtPath)
              const testResult = runTests(wtPath, testInfo)
              const passRate = testResult.total > 0 ? testResult.passed / testResult.total : 0

              candidates.push({
                index: i,
                worktreePath: wtPath,
                patch,
                testsPassed: testResult.passed,
                testsTotal: testResult.total,
                passRate,
                stuckTurns: 0,
                totalTurns: bonTurnCap,
              })

              console.log(`[bestOfN] Candidate ${i + 1}: ${testResult.passed}/${testResult.total} tests (${(passRate * 100).toFixed(0)}%)`)

              originalEmit({
                type: 'bestOfN.candidate' as any,
                index: i,
                passed: testResult.passed,
                total: testResult.total,
                passRate,
              } as any)
            }

            // Restore state
            this.emit = originalEmit
            this.config.temperature = savedTemp
            this.executor.setCwd(mainCwd)
            this.messages = JSON.parse(JSON.stringify(savedMessages))

            // Select winner
            const winner = selectWinner(candidates)

            if (winner && winner.patch) {
              const applied = applyPatch(mainCwd, winner.patch)
              const msg = applied
                ? `\n**Best-of-N result:** Candidate ${winner.index + 1} selected — ${winner.testsPassed}/${winner.testsTotal} tests passing (${(winner.passRate * 100).toFixed(0)}%). Patch applied.\n`
                : `\n**Best-of-N result:** Candidate ${winner.index + 1} won (${winner.testsPassed}/${winner.testsTotal} tests) but patch failed to apply cleanly. Running single-pass fallback.\n`

              this.emit({ type: 'stream.token', text: msg, messageId: '' } as any)
              this.emit({ type: 'bestOfN.selected' as any, winner: winner.index, passRate: winner.passRate, applied } as any)
              this.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' } as any)

              console.log(`[bestOfN] Winner: candidate ${winner.index + 1} (${(winner.passRate * 100).toFixed(0)}%), applied=${applied}`)

              if (applied) {
                bestOfNRan = true
              }
              // If patch didn't apply, fall through to normal single-pass below
            } else {
              this.emit({ type: 'stream.token', text: '\n**Best-of-N:** No candidate produced a valid patch. Running single-pass fallback.\n', messageId: '' } as any)
            }
          } finally {
            // Always clean up worktrees
            wtManager.cleanupAll()
            this.emit = originalEmit
            this.config.temperature = savedTemp
            this.executor.setCwd(mainCwd)
          }
        } else {
          console.log('[bestOfN] Enabled but no test framework detected — skipping')
        }
      }
    } catch (e) {
      console.log(`[bestOfN] Orchestration failed, falling back to single-pass: ${e}`)
    }

    // Normal single-pass if best-of-N didn't run (or failed)
    if (!bestOfNRan) {
      try {
        await this.runModelLoop(systemPrompt, thinkingConfig, toolDefs, deps)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[loop] ERROR: ${msg}`)
        this.emit({ type: 'session.error', error: msg })
      }
    }

    // ─── Session End: Autopoietic evaluation + cleanup ──────────
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

    // Persist tool trust scores so demotion signal survives across sessions
    this.toolScorer.save(this.toolScorerPath)

    this.processing = false
    this.abortController = null
  }

  buildHandoff(): Record<string, unknown> {
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

    return {
      goal, now, status, model: this.config.model, what_was_done, files_modified,
      // P4.3/4(e): persisted in the interactive handoff (main.ts session.end).
      // The vibe surface does not persist it here — vibe fidelity coverage comes
      // from the governance.session_fidelity event emitted at conversation end.
      regulator_fidelity: this.governance.getSessionFidelity(),
    }
  }

  /** Rough token estimate (chars/4) of the current message history. */
  private estimateMessageTokens(): number {
    return this.messages.reduce((sum, m) =>
      sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? JSON.stringify(b).length) / 4, 0), 0)
  }

  /**
   * Compress older messages into a structured summary via a side query.
   * Keeps the most recent pairs so a pending tool_use message survives.
   * Returns true only if the message list was actually compacted.
   */
  private async compactNow(label: string): Promise<boolean> {
    if (this.messages.length <= 6) return false
    try {
      const before = this.messages
      const contractText = globalContract.isActive() ? globalContract.snapshot().brief : undefined
      const compacted = await this.compressor.runCompaction(this.messages, this.fileTracker, {
        keepRecentPairs: 2,
        summarize: (prompt) => this.sideQuery(prompt),
        journal: (summary, fileOps) => { try { this.journal.appendCompaction(summary, fileOps) } catch (e) { console.log(`[session] compaction journal failed: ${e instanceof Error ? e.message : String(e)}`) } },
        contractText,
      })
      if (compacted === before) return false
      this.messages = compacted
      console.log(`[compact] ${label}: → ${Math.round(this.estimateMessageTokens())} tokens (${this.messages.length} messages)`)
      return true
    } catch (e) {
      console.log(`[compact] ${label} compaction failed: ${e}`)
      return false
    }
  }

  /**
   * Public provider-aware side query for satellite components
   * (vibe controller, wizard). Routes through the SAME backend as the
   * main model so llama-cpp users don't hit Ollama-only endpoints.
   */
  runSideQuery(prompt: string, opts?: { maxTokens?: number; system?: string }): Promise<string> {
    return this.sideQuery(prompt, opts?.maxTokens ?? 300, opts?.system)
  }

  /** Quick side query — no tools, no thinking, returns plain text. */
  private async sideQuery(prompt: string, maxTokens = 200, system?: string): Promise<string> {
    // Route through the SAME backend as the main model to avoid loading
    // a second model in Ollama when using llama-cpp provider.
    // Uses OpenAI-compatible endpoint which both Ollama and llama-server support.
    const providerUrl = this.config.provider === 'llama-cpp'
      ? `http://127.0.0.1:${this.config.port ?? 8081}`
      : (this.config.baseUrl || 'http://localhost:11434')

    if (this.config.provider === 'llama-cpp') {
      // llama-server: use OpenAI-compatible chat endpoint
      const resp = await fetch(`${providerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: '/no_think\n' + prompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
      })
      if (!resp.ok) throw new Error(`sideQuery HTTP ${resp.status}`)
      const data: any = await resp.json()
      return data.choices?.[0]?.message?.content ?? ''
    }

    // Ollama: use native API with think:false
    const resp = await fetch(`${providerUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        options: { num_predict: maxTokens, temperature: 0.3 },
        think: false,
        stream: false,
      }),
    })
    if (!resp.ok) throw new Error(`sideQuery HTTP ${resp.status}`)
    const data: any = await resp.json()
    // Gemma4 puts everything in message.thinking with empty content — fall back
    return data.message?.content || data.message?.thinking || ''
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
      // ── Stuck loop escape: escalating intervention ──
      const stuckCount = this.governance.getStuckCount()

      // Tier 4: Hard halt at 15+ stuck turns
      if (stuckCount >= 15) {
        console.log(`[vsm] HALT: stuck for ${stuckCount} turns — stopping model loop`)
        this.emit({
          type: 'stream.token',
          text: '\n\n---\n**Session halted** — stuck for ' + stuckCount +
            ' turns without progress. Send a message to redirect.\n',
          messageId: '',
        } as any)
        this.emit({ type: 'message.complete', messageId: '', stopReason: 'end_turn' } as any)
        break
      }

      // Tier 3: Synthetic user message at 10+ stuck turns (every 5 turns)
      if (stuckCount >= 10 && stuckCount % 5 === 0) {
        console.log(`[vsm] REDIRECT: injecting synthetic user message (stuck ${stuckCount} turns)`)
        this.messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: 'STOP. You have been repeating the same actions for ' + stuckCount + ' turns without making progress. ' +
              'Before your next action, answer these questions:\n' +
              '1. What are you trying to accomplish?\n' +
              '2. What specific problem is preventing progress?\n' +
              '3. What completely different approach could you try?\n\n' +
              'Do NOT repeat any tool call you have made in the last 5 turns.',
          }],
        })
      }

      const iterationStartMs = Date.now()

      // S2: Check for steering interrupts
      const steer = this.steering.nextSteer()
      if (steer) {
        console.log(`[s2] Steering from ${steer.source}`)
        if (process.env._TRACE_STEERING === '1') this.traceLastInjected = steer.source
        this.governance.markNudgeInjected()
        this.addMessage({
          role: 'user',
          content: [{ type: 'text', text: steer.text }],
        })
        continue
      }

      // TDD governance nudge (opt-in: LOCALCODE_TDD_GOV=1). When no formal
      // workflow is active and the model has edited repeatedly without running
      // tests, push a single soft nudge to run tests. Push directly, never
      // queue. Reset the streak so we nudge once per build-up, not every turn.
      if (shouldNudgeTests(this.tddGov, {
        flagOn: process.env.LOCALCODE_TDD_GOV === '1',
        workflowActive: this.workflowEngine.state != null,
      })) {
        console.log('[tdd-gov] Nudging: run tests before more edits')
        this.governance.markNudgeInjected()
        this.addMessage({
          role: 'user',
          content: [{ type: 'text', text: this.tddGov.getTestDirective() }],
        })
        this.tddGov.recordToolCall('Bash') // reset edit streak (single nudge)
        continue
      }

      const lastMsg = this.messages[this.messages.length - 1]
      const lastRole = lastMsg?.role ?? 'none'
      const lastType = lastMsg?.content?.[0]?.type ?? 'empty'
      console.log(`[loop] Model call iteration ${i + 1} | messages: ${this.messages.length} | last: ${lastRole}/${lastType}`)

      // _TRACE_STEERING=1: one structured line per model call — context size (to expose
      // bloat), cumulative read/write split + last-6 tools (exploration efficiency), and
      // the intervention (if any) injected just before THIS call (to attribute the model's
      // next action to it). Parsed offline to test "death by soft nagging" hypothesis.
      if (process.env._TRACE_STEERING === '1') {
        const TRACE_READ = new Set(['Read', 'Grep', 'Glob', 'Ls', 'ImageView'])
        const TRACE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'Bash'])
        const approxTok = Math.round(this.messages.reduce((sum: number, m: any) =>
          sum + (Array.isArray(m.content)
            ? m.content.reduce((s: number, b: any) => s + (b.text?.length ?? JSON.stringify(b).length) / 4, 0)
            : (typeof m.content === 'string' ? m.content.length / 4 : 0)), 0))
        const reads = this.toolHistory.filter((t) => TRACE_READ.has(t)).length
        const writes = this.toolHistory.filter((t) => TRACE_WRITE.has(t)).length
        const last6 = this.toolHistory.slice(-6).join(',')
        console.log(`[trace] iter=${i + 1} msgs=${this.messages.length} ctxTok=${approxTok} reads=${reads} writes=${writes} injected=${this.traceLastInjected ?? 'none'} last6=[${last6}]`)
        this.traceLastInjected = null
      }

      // S4 Reflector: periodic model self-report
      // For llama-cpp, throttle to every 10th iteration (each reflection costs 6s prompt eval)
      const reflector = this.governance.getReflector()
      const s4Skip = this.config.provider === 'llama-cpp' && (i + 1) % 10 !== 0
      if (!s4Skip && reflector.shouldReflect(i + 1)) {
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
          this.governance.setS4ReflectionRan()

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

      // VSM advisor routing (opt-in: LOCALCODE_ADVISORS=1). During S4
      // reflection, consult the firing domain advisors and inject their
      // guidance into the executor context. Throttled like the reflector to
      // avoid an inference storm on llama-cpp.
      if (process.env.LOCALCODE_ADVISORS === '1' && !s4Skip) {
        try {
          const govReport = this.governance.getReport()
          const lastUser = [...this.messages].reverse()
            .find(m => m.role === 'user')?.content
            .find((b: any) => b.type === 'text') as any
          const advisorState: AdvisorState = {
            turnCount: i + 1,
            toolsUsedThisTurn: [],
            toolsUsedTotal: this.governance.getRecentToolNames(),
            toolFailureRate: 1.0 - govReport.toolSuccessRate,
            varietyBalance: (govReport as any).varietyBalance ?? 'balanced',
            stuckTurns: govReport.stuckTurns,
            contextUtilization: 0,
            expertise: this.config.expertise ?? 'intermediate',
            lastUserMessage: lastUser?.text ?? '',
            conversationLength: this.messages.length,
          }
          const guidance = await runAdvisors(
            advisorState,
            (sys, prompt) => this.sideQuery(`${sys}\n\n${prompt}`),
          )
          if (guidance) {
            this.addMessage({ role: 'user', content: [{ type: 'text', text: guidance }] })
            console.log('[advisors] Injected VSM advisor guidance')
          }
        } catch (e) {
          console.log(`[advisors] routing failed: ${e}`)
        }
      }

      // Context compression check
      const estimatedTokensBefore = await this.estimateContextTokens()
      const ctxLen = this.config.contextLength ?? 32768

      if (this.compressor.shouldCompress(this.messages, estimatedTokensBefore, ctxLen)) {
        console.log(`[loop] Context at ${Math.round(estimatedTokensBefore / ctxLen * 100)}% — compressing`)
        this.emit({ type: 'stream.token', text: '\n[System] Compressing context to free space...\n' })
        // Single compaction path: runCompaction via compactNow (tier-0 trim,
        // write-before-compact journal, verbatim anchors, tracker reset).
        await this.compactNow('loop-threshold')
        console.log(`[loop] Compressed to ${this.messages.length} messages (files tracked: ${this.fileTracker.getModifiedFiles().length} modified, ${this.fileTracker.getReadFiles().length} read)`)
      }

      // Reset per-turn semantic merge tracking
      resetMergeTracking()

      // Algedonic kill switch — HALT if critical failures accumulated
      try {
        this.governance.checkOrHalt()
      } catch (haltErr: any) {
        console.log(`[loop] HALTED: ${haltErr.message}`)
        this.emit({ type: 'stream.token', text: `\n[System] ${haltErr.message}\nType /reset to continue.\n` })
        this.emit({ type: 'message.complete', messageId: '', stopReason: 'halted' })
        return
      }

      // Filter out demoted tools (trust score decay)
      const scorer = this.executor.getToolScorer?.()
      const demoted = scorer ? new Set(scorer.getDemotedTools()) : new Set<string>()
      let iterationTools = demoted.size > 0
        ? toolDefs.filter(t => !demoted.has(t.name))
        : toolDefs
      if (demoted.size > 0) {
        console.log(`[trust] Demoted tools excluded: ${[...demoted].join(', ')}`)
      }

      // Two-stage tool routing for small context models
      try {
        const { shouldUseRouting, getToolsForCategory, CATEGORY_SELECTOR_TOOL } = await import('../tools/toolRouter.js')
        if (shouldUseRouting(this.config.contextLength ?? 32768) && iterationTools.length > 5) {
          // Stage 1: send only category selector
          const routingGen = localCallModel({
            messages: this.messages,
            systemPrompt,
            thinkingConfig,
            tools: [CATEGORY_SELECTOR_TOOL as any],
            signal: this.abortController?.signal ?? new AbortController().signal,
            options: { model: this.config.model! },
            deps,
          })
          for await (const evt of routingGen) {
            if (evt.type === 'tool_use' && evt.name === 'select_category') {
              const category = (evt as any).input?.category ?? 'all'
              console.log(`[routing] Category selected: ${category}`)
              const { ALL_TOOLS } = await import('../tools/registry.js')
              iterationTools = getToolsForCategory(category, ALL_TOOLS).map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              }))
              break
            }
            if (evt.type === 'message_stop') break // model didn't use the tool — fall through to all tools
          }
        }
      } catch (routeErr) {
        console.log(`[routing] Error: ${routeErr instanceof Error ? routeErr.message : routeErr}`)
      }

      // Apply variety-driven control signals
      let effectiveTemperature = this.config.temperature ?? 0.7
      if (process.env.LOCALCODE_VARIETY_CONTROL !== 'false' && this.governance) {
        try {
          const signals = this.governance.getControlSignals(effectiveTemperature)
          effectiveTemperature = signals.temperature
          if (signals.temperatureAdjust !== 0) {
            console.log(`[control] Variety: temp ${(effectiveTemperature - signals.temperatureAdjust).toFixed(2)} → ${effectiveTemperature.toFixed(2)}`)
            if (signals.temperatureAdjust < 0) {
              this.governance.markTemperatureLowered()
            }
          }
        } catch {}
      }
      // Nudge cooling: after 2+ consecutive no-tool-call nudges, lower the
      // temperature deterministically — wording alone doesn't break the
      // narration attractor. Applies even when variety control is disabled.
      const cooled = applyNudgeTemperature(effectiveTemperature, this.consecutiveNudges)
      if (cooled !== effectiveTemperature) {
        console.log(`[control] Nudge cooling: temp ${effectiveTemperature.toFixed(2)} → ${cooled.toFixed(2)} after ${this.consecutiveNudges} consecutive nudges`)
        effectiveTemperature = cooled
      }
      const _savedTemperature = this.config.temperature
      this.config.temperature = effectiveTemperature

      // ── Dynamic governance intervention (re-evaluated EVERY iteration) ──
      // Delivered as an APPENDED user message, never a system-prompt rewrite:
      // the prompt prefix must stay byte-stable for checkpoint caching.
      const currentStuck = this.governance.getStuckCount()
      const govSignal = buildGovernanceSignal(currentStuck)
      if (govSignal) {
        this.addMessage({ role: 'user', content: [{ type: 'text', text: govSignal }] })
        console.log(`[governance] Stuck signal appended as message (stuck=${currentStuck})`)
      }
      if (currentStuck >= 3) {
        // Re-evaluate S5 to get fresh tool restrictions (C7 fires at stuck >= 5)
        console.log(`[s5] Live re-eval check: stuck=${currentStuck} s5=${!!this.s5}`)
        if (currentStuck >= 5 && this.s5) {
          try {
            const govReport = this.governance.getReport()
            const decision = await this.s5.makeDecision({
              userMessage: 'stuck loop re-evaluation',
              activeWorkflow: this.workflowEngine.state?.workflow.name ?? null,
              currentPhase: this.workflowEngine.currentPhase?.name ?? null,
              contextUsagePercent: 0.5,
              governance: { ...(govReport as any), activeToolNames: iterationTools.map((t: any) => t.name) },
              recentToolResults: [],
              availableModels: [this.config.model ?? 'unknown'],
              turnCount: this.messages.filter(m => m.role === 'user').length,
              varietyBalance: (govReport as any).varietyBalance ?? 'balanced',
              varietyRatio: (govReport as any).varietyRatio ?? 1.0,
              homeostatStable: true,
              homeostatConsecutiveUnstable: (govReport as any).consecutiveUnstable ?? 0,
              driftDetected: false,
              driftDirection: null,
              performanceHealth: 'critical',
              productivityRatio: 0,
              recommendedToolMode: null,
              heterarchyAuthority: null,
              agreementRatio: (govReport as any).agreementRatio ?? 1.0,
              observerDivergence: (govReport as any).observerDivergence ?? null,
              demotedTools: [],
              promptDifficulty: this.difficultyClassifier.getLevel(),
            })
            if (decision.tools) {
              const allowed = new Set(decision.tools)
              const filtered = iterationTools.filter(t => allowed.has(t.name))
              if (filtered.length > 0) {
                iterationTools = filtered
                console.log(`[s5] LIVE RE-EVAL: tool restriction to [${decision.tools.join(', ')}] (stuck ${currentStuck})`)
              } else {
                console.log(`[s5] LIVE RE-EVAL skipped: restriction [${decision.tools.join(', ')}] would remove every available tool (stuck ${currentStuck})`)
              }
            }
          } catch (e) {
            console.log(`[s5] Live re-eval failed: ${e}`)
          }
        }
      }

      // Final deterministic gate: attenuate overused/stuck tools out of the
      // offered set. Pure narrowing — applyToolGate never empties the set.
      if (currentStuck >= 2) {
        const recent = this.governance.getRecentToolNames()
        const lastTool = recent[recent.length - 1]
        if (lastTool) this.toolGating.recordStuckTurn(lastTool)
      }
      const gated = this.toolGating.getRestrictedTools()
      if (gated.length > 0) {
        const narrowed = applyToolGate(iterationTools, gated)
        if (narrowed.length !== iterationTools.length) {
          console.log(`[toolgate] Attenuated overused tools: ${gated.join(', ')}`)
          iterationTools = narrowed
        }
      }

      if (currentStuck >= 3) {
        console.log(`[loop] Sending to model with ${iterationTools.length} tools: ${iterationTools.map((t: any) => t.name).join(', ')}`)
      }
      this.offeredToolNames = new Set(iterationTools.map((t: any) => t.name))
      const gen = localCallModel({
        messages: this.messages,
        systemPrompt,
        thinkingConfig,
        tools: iterationTools,
        signal: this.abortController?.signal ?? new AbortController().signal,
        options: { model: this.config.model!, stuckTurns: this.governance?.getStuckCount() ?? 0 },
        deps,
      })
      this.config.temperature = _savedTemperature
      this.resetBrainTurnState()

      let lastMessageId = ''
      let tokenCount = 0
      let reasoningTokenCount = 0
      let stopReason = 'end_turn'
      const modelCallStartTime = Date.now()
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
                if (delta.logprobs?.length) this.observeUncertainty('output', delta.logprobs)
              }
              // Track reasoning tokens (qwen3, deepseek-r1, etc.)
              // Accumulated silently — not shown in chat (noise for users)
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                reasoningTokenCount++
                this.emit({ type: 'stream.thinking', text: delta.thinking })
                this.thinkingRecorder?.onThinkingDelta(delta.thinking)
                if (delta.logprobs?.length) this.observeUncertainty('thinking', delta.logprobs)
              }
              // Count tool input JSON tokens for accurate tok/s
              if (delta?.type === 'input_json_delta' && delta.partial_json) {
                tokenCount++ // tool call JSON also counts as output
                if ((delta as any).logprobs?.length) this.observeUncertainty('tool', (delta as any).logprobs)
              }
              break
            }
            case 'message_start':
              lastMessageId = event.message?.id ?? ''
              break
            case 'message_delta':
              stopReason = event.delta?.stop_reason ?? stopReason
              // Capture estimated output tokens from the stream translator
              if (event.usage?.output_tokens) {
                const estimatedTokens = event.usage.output_tokens
                // Use the stream translator's estimate if it's higher than our chunk count
                if (estimatedTokens > tokenCount) tokenCount = estimatedTokens
              }
              break
            case 'message_stop': {
              const modelCallElapsedMs = Date.now() - modelCallStartTime
              const tokPerSec = modelCallElapsedMs > 0 ? Math.round((tokenCount + reasoningTokenCount) / (modelCallElapsedMs / 1000) * 10) / 10 : 0
              console.log(`[loop] message_stop, tokens=${tokenCount}+${reasoningTokenCount}r, ${tokPerSec} tok/s, stop=${stopReason}`)
              this.lastTokPerSec = tokPerSec
              this.lastModelCallMs = modelCallElapsedMs
              this.governance.setTokPerSec(tokPerSec, tokenCount + reasoningTokenCount)
              this.governance.setThinkingTokens(reasoningTokenCount)
              this.flushUncertainty()
              this.thinkingRecorder?.finalizeTurn({
                tokenCount: reasoningTokenCount,
                durationMs: modelCallElapsedMs,
                entropy: {
                  thinking: this.uncertainty.digest('thinking'),
                  output: this.uncertainty.digest('output'),
                  tool: this.uncertainty.digest('tool'),
                },
              })
              this.uncertainty.reset()
              this.uncertaintyIndex = 0
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
                // Must be the real streamed text: '' here made responseStuck
                // permanently true (uniform empty prefixes) — 2026-06-12
                // weekly-digest HALT incident #3.
                response: streamedText,
                userMessage: userMsgText,
                contextUtilization: Math.min(1, this.estimateMessageTokens() / (this.config.contextLength ?? 32768)),
              })

              // Emit governance status to TUI
              const turnReport = this.governance.getReport()
              this.emit({
                type: 'governance.status',
                health: turnReport.status,
                s3s4Balance: turnReport.s3s4Balance,
                toolSuccessRate: turnReport.toolSuccessRate,
                stuckTurns: turnReport.stuckTurns,
                varietyRatio: turnReport.varietyRatio,
                varietyWindowed: turnReport.varietyWindowed,
                taskError: turnReport.taskError,
                errorTrend: turnReport.errorTrend,
                fingerprintAlarm: turnReport.fingerprintAlarm,
                infoGain: turnReport.infoGain,
                progressRate: turnReport.progressRate,
                explorationState: turnReport.explorationState,
                varietyBalance: turnReport.varietyBalance,
                algedonicAlerts: turnReport.algedonicAlerts,
                axiomHealth: turnReport.axiomHealth,
                consecutiveUnstable: turnReport.consecutiveUnstable,
                // Suspect signal under falsification (pegged 0.00 in successful
                // missions) — must be visible per-turn for the outcome ledger
                agreementRatio: (turnReport as any).agreementRatio ?? 1.0,
                predictions: turnReport.predictions,
                s4: turnReport.s4,
                heterarchy: turnReport.heterarchy,
                suggestion: turnReport.stuckTurns > 0 ? 'Model may be stuck — consider changing approach' : null,
              })

              // Emit control signals for dashboard
              if (this.governance && process.env.LOCALCODE_VARIETY_CONTROL !== 'false') {
                try {
                  const signals = this.governance.getControlSignals(this.config.temperature ?? 0.7)
                  this.emit({
                    type: 'control.signals',
                    temperatureAdjust: signals.temperatureAdjust,
                    temperature: signals.temperature,
                    bestOfNBudget: signals.bestOfNBudget,
                    widenToolSet: signals.widenToolSet,
                  })
                } catch {}
              }

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
                if ((block as any).logprobs?.length) this.observeUncertainty('tool', (block as any).logprobs)
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
            case 'toolcall_transport': {
              this.emit({
                type: 'toolcall.transport',
                stage: (event as any).stage,
                toolName: (event as any).toolName,
                detail: (event as any).detail,
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
      // Diagnostic: log which tools the model is calling
      if (toolUseBlocks.length > 0) {
        const toolNames = toolUseBlocks.map((b: any) => b.name).join(', ')
        console.log(`[loop] Tool calls: ${toolNames}`)
      }

      // Fallback: if model output <tool_call> XML text instead of native tool_use blocks,
      // extract tool calls from the text. This happens when native models occasionally
      // fall back to XML-style tool calling mid-conversation.
      if (toolUseBlocks.length === 0 && stopReason === 'tool_use') {
        const textContent = (assistantContent as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text ?? '')
          .join('')
        if (textContent.includes('<tool_call>')) {
          const extractResult = extractSimulatedToolCalls(textContent)
          if (extractResult.toolCalls.length > 0) {
            console.log(`[loop] Extracted ${extractResult.toolCalls.length} XML tool call(s) via simulated extractor`)
            toolUseBlocks = extractResult.toolCalls.map((tc: any) => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            }))
            this.emit({
              type: 'toolcall.transport',
              stage: 'regex_fallback',
              detail: `extracted ${extractResult.toolCalls.length} call(s) from XML text`,
            })
          }
          // Handle post-validation errors: inject corrective message and re-prompt
          if (extractResult.validationErrors?.length && this._correctionAttempts < 2) {
            this._correctionAttempts++
            const correction = extractResult.validationErrors.join('\n\n')
            this.messages.push({
              role: 'user',
              content: [{ type: 'text', text: `[System] Your tool call was invalid. ${correction}` }],
            })
            console.log(`[loop] Tool call validation failed — re-prompting (attempt ${this._correctionAttempts}/2)`)
            continue // re-prompt
          }
          this._correctionAttempts = 0
        }
        // If still no tool calls found, treat as end_turn
        if (toolUseBlocks.length === 0) {
          console.log(`[loop] stop_reason was tool_use but no tool blocks found — treating as end_turn`)
          stopReason = 'end_turn'
        }
      }

      // Emit context utilization after each model turn.
      // The estimate MUST include the fixed per-request prompt overhead
      // (system prompt + tool schemas) — llama-server evaluates them on every
      // request. 2026-06-12 incident #3: overhead was 15.1k of a 32.8k n_ctx;
      // the messages-only estimate read 54% while the server was rejecting
      // requests at 100%, so the critical path never fired.
      const promptOverheadTokens =
        JSON.stringify(systemPrompt ?? '').length / 4 +
        JSON.stringify(iterationTools ?? []).length / 4
      const estimatedTokens = promptOverheadTokens + this.estimateMessageTokens()
      const contextLength = this.config.contextLength ?? 32768
      this.emit({
        type: 'context.status',
        utilization: Math.min(1, estimatedTokens / contextLength),
        estimatedTokens: Math.round(estimatedTokens),
        contextLength,
        action: estimatedTokens / contextLength > 0.8 ? 'compact' : 'proceed',
        indexMode: process.env.LOCALCODE_HYBRID_SEARCH !== '0' ? 'hybrid' : 'vector',
        indexDegraded: this.indexDegraded ?? false,
        lastQueryMode: this.lastQueryMode ?? undefined,
      })

      // GSD: Context monitor — compact before overflow. A "finish now"
      // warning alone cannot stop overflow when each tool result adds
      // thousands of tokens, so shrink the conversation first.
      let ctxUtilization = estimatedTokens / contextLength
      if (ctxUtilization > 0.80) {
        if (await this.compactNow(`in-loop at ${Math.round(ctxUtilization * 100)}%`)) {
          ctxUtilization = (promptOverheadTokens + this.estimateMessageTokens()) / contextLength
        }
      }
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
      // This catches the "let me check... actually... wait..." narration pattern.
      // BUT: if the model says it's done (completion signals), let it finish.
      const completionSignals = /\b(task (is )?complete|i'm done|waiting for|ready for your|what would you like|no changes needed)\b/i
      const modelSaysDone = completionSignals.test(streamedText)
      const isMidPlanStop = noToolsEndTurn && toolsUsedInSession.length > 0 && !modelSaysDone
      // One-shot missions finish by emitting a ```json structured outcome —
      // that IS completion; never nudge it back into tool calls
      // (2026-06-12 weekly-digest incident: nudges pushed the model mid-answer
      // back to repeating the same Mfl call until HALT).
      const producedStructuredOutcome = this.allowedTools != null && /```json/.test(streamedText)
      if ((isThinkingWithoutActing || isDescribingInsteadOfDoing || isMidPlanStop) && !producedStructuredOutcome) {
        this.consecutiveNudges++
        if (this.consecutiveNudges <= 5) {
          const nudgeText = this.allowedTools
            ? `Do not narrate. Either call one of your available tools (${this.allowedTools.join(', ')}) to gather missing data, or produce your final structured outcome (the \`\`\`json block) now.`
            : this.consecutiveNudges <= 1
            ? 'Do not describe what you will do. Call a tool now. If you need to read a file, call Read. If you need to write, call Write. If you need to search, call Grep. Act, do not narrate.'
            : this.consecutiveNudges <= 3
              ? `WARNING ${this.consecutiveNudges}: You MUST call a tool. Do not explain, do not plan, do not narrate. Call Read, Write, Edit, Grep, or Bash RIGHT NOW.`
              : 'FINAL WARNING: Call a tool immediately or your turn ends.'
          console.log(`[s2] Nudge ${this.consecutiveNudges}: ${nudgeText.slice(0, 50)}...`)
          if (process.env._TRACE_STEERING === '1') this.traceLastInjected = `nudge${this.consecutiveNudges}`
          this.governance.markNudgeInjected()
          // Push directly and continue — steering queue gets consumed too late (after exit)
          this.addMessage({ role: 'user', content: [{ type: 'text', text: nudgeText }] })
          continue
        } else {
          // Exhausted nudges — inject continuation with original task
          const firstUserMsg = this.messages.find(m => m.role === 'user')
          const originalTask = firstUserMsg?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').slice(0, 200) ?? ''
          console.log(`[s2] Nudge exhausted — injecting continuation with original task`)
          this.governance.markNudgeInjected()
          // Reset to 2, not 0: restarts the nudge escalation cycle but keeps
          // nudge cooling engaged — the model is at peak stuckness here, and
          // returning to full temperature would undo the behavioral fix.
          this.consecutiveNudges = 2
          this.addMessage({ role: 'user', content: [{ type: 'text', text: `CONTINUE WORKING. You stopped without finishing. Your original task was: "${originalTask}". Call a tool now to make progress.` }] })
          continue
        }
      }

      // Contract enforcement: don't let model finish if contract is incomplete
      // Fires when model stops WITHOUT tool calls, OR when model has been iterating
      // for a while without marking assertions (prevents read-loop evasion)
      const contractActive = globalContract.isActive() && !globalContract.isComplete() && globalContract.isEnforcementEnabled()
      const modelStopping = toolUseBlocks.length === 0 && stopReason === 'end_turn'
      const readLoopEvasion = contractActive && i > 0 && i % 8 === 0 // every 8 iterations, check
      if (contractActive && (modelStopping || readLoopEvasion)) {
        globalContract.enforcementRounds++
        if (globalContract.enforcementRounds <= 5) {
          const pending = globalContract.pendingCount()
          const failed = globalContract.failedCount()
          const runTests = 'Run the test suite NOW with Bash to verify your changes work. If tests fail, fix the errors.'
          this.addMessage({
            role: 'user',
            content: [{ type: 'text', text: `[System] You are NOT done. Contract has ${pending} assertions pending, ${failed} failed. ${runTests} Then use ContractAssertPass to mark completed assertions. Do NOT keep reading files — ACT.` }],
          })
          console.log(`[contract] Enforcement round ${globalContract.enforcementRounds}: ${pending} pending, ${failed} failed`)
          continue
        }
        console.log(`[contract] Allowing completion after ${globalContract.enforcementRounds} enforcement rounds`)
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
          this.governance.markNudgeInjected()
          this.addMessage({
            role: 'user',
            content: [{ type: 'text', text: followUpMsg.text }],
          })
          continue
        }

        // Check workflow gate and auto-advance at end of turn
        if (this.workflowEngine.isActive) {
          this.workflowEngine.incrementTurn()
          const phase = this.workflowEngine.currentPhase
          const turnCount = this.workflowEngine.state?.turnCount ?? 0
          const maxTurns = phase?.maxTurns

          // Nudge model when approaching maxTurns in a read-only phase
          if (maxTurns && turnCount === maxTurns - 3) {
            this.addMessage({
              role: 'user',
              content: [{ type: 'text', text: '[System] You are approaching the turn limit for this planning phase. Stop reading and OUTPUT YOUR PLAN NOW as a numbered list of steps. Do not call any more tools — just write out the plan.' }],
            })
          }

          const gateSatisfied = this.workflowEngine.checkGate(stopReason, null)
          if (gateSatisfied) {
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

        // P4.3/4(e): session-level regulator fidelity — the mission driver
        // ingests this into the outcome ledger; the TUI/vibe surfaces consume
        // the event directly. Emitted once per completed user message.
        this.emit({
          type: 'governance.session_fidelity',
          fidelity: this.governance.getSessionFidelity(),
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

      // Workflow: count turns and check maxTurns even during tool execution
      if (this.workflowEngine.isActive) {
        this.workflowEngine.incrementTurn()
        const wfPhase = this.workflowEngine.currentPhase
        const wfTurnCount = this.workflowEngine.state?.turnCount ?? 0
        const wfMaxTurns = wfPhase?.maxTurns

        // Nudge 3 turns before maxTurns
        if (wfMaxTurns && wfTurnCount === wfMaxTurns - 3) {
          console.log(`[workflow] Nudging model at turn ${wfTurnCount}/${wfMaxTurns}`)
          this.addMessage({
            role: 'user',
            content: [{ type: 'text', text: '[System] You are approaching the turn limit for this planning phase. Stop reading and OUTPUT YOUR PLAN NOW as a numbered list of steps. Do not call any more tools — just write out the plan.' }],
          })
        }

        // Force phase advance at maxTurns
        if (wfMaxTurns && wfTurnCount >= wfMaxTurns) {
          console.log(`[workflow] Forcing phase advance at turn ${wfTurnCount}/${wfMaxTurns}`)
          const transitions = wfPhase?.transitions ?? []
          if (transitions.length >= 1 && transitions[0] !== 'done') {
            this.workflowEngine.advance(transitions[0])
            this.governance.setWorkflowReadOnlyPhase(false)
            this.emit({ type: 'stream.token', text: `\n[Workflow] Phase: ${transitions[0]} (auto-advanced after planning)\n` })
            this.addMessage({
              role: 'user',
              content: [{ type: 'text', text: '[System] Planning phase complete. You are now in the EXECUTION phase. You have access to Edit, Write, and Bash tools. Execute the task step by step.' }],
            })
          }
        }
      }

      // Execute tool calls and feed results back
      // S1: Group read-only tools for parallel execution
      this.consecutiveNudges = 0
      const toolResults: Message['content'] = []
      const P_READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'Ls', 'ImageView', 'Git'])
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

      // Snapshot: track workspace state after tool batch.
      // Re-init if the executor cwd changed since the snapshot was created
      // (user.message with a different project dir, worktree switch, ...).
      const snapCwd = this.executor['cwd']
      if (snapCwd && snapCwd !== this.snapshotCwd) {
        this.initSnapshot(snapCwd)
      }
      this.trackSnapshotAfterBatch()

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

  getGovernance() {
    return this.governance
  }

  /** Track workspace state after a tool batch; on user-file changes, push an
   *  undo target and emit snapshot.taken (P1.4). Extracted from run() so the
   *  round-trip is testable without driving the model loop. */
  private trackSnapshotAfterBatch(): void {
    if (!this.snapshot) return
    try {
      const newHash = this.snapshot.track()
      if (this.lastSnapshotHash && newHash !== this.lastSnapshotHash) {
        const diff = this.snapshot.diff(this.lastSnapshotHash, newHash)
        // Filter out index/debug files — only count user code changes
        const userFiles = diff.files.filter((f: any) => !f.path?.includes('.cynco'))
        if (userFiles.length > 0) {
          console.log(`[snapshot] ${userFiles.length} user files changed (${diff.totalAdditions}+ ${diff.totalDeletions}-)`)
          this.governance.onFileProgress(userFiles.length, diff.totalAdditions, diff.totalDeletions)
          this.snapshotUndoStack.push({
            prevHash: this.lastSnapshotHash,
            newHash,
            filesChanged: userFiles.length,
            additions: diff.totalAdditions,
            deletions: diff.totalDeletions,
          })
          this.emit({
            type: 'snapshot.taken',
            hash: newHash,
            prevHash: this.lastSnapshotHash,
            filesChanged: userFiles.length,
            additions: diff.totalAdditions,
            deletions: diff.totalDeletions,
          })
        }
      }
      this.lastSnapshotHash = newHash
    } catch (e) {
      console.log(`[snapshot] Track failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Revert the most recent write batch to its pre-batch snapshot (P1.4 /undo). */
  undoLastBatch(): { ok: boolean; message: string } {
    // Check the snapshot BEFORE popping — otherwise a stale entry would be
    // silently discarded while claiming "nothing to undo" (P1.4 review I1).
    if (!this.snapshot) {
      return { ok: false, message: 'Nothing to undo — no tracked write batches this session.' }
    }
    const entry = this.snapshotUndoStack.pop()
    if (!entry) {
      return { ok: false, message: 'Nothing to undo — no tracked write batches this session.' }
    }
    try {
      this.snapshot.restore(entry.prevHash)
    } catch (e) {
      // Restore failed — put the entry back so the user can retry.
      this.snapshotUndoStack.push(entry)
      return { ok: false, message: `Undo failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    // The workspace IS reverted at this point. A re-track failure must not be
    // reported as an undo failure (P1.4 review M1) — tolerate it and move on.
    try {
      this.lastSnapshotHash = this.snapshot.track()
    } catch (e) {
      console.log(`[snapshot] Re-track after undo failed: ${e instanceof Error ? e.message : String(e)}`)
      // Best available truth: the workspace now matches the restored snapshot.
      this.lastSnapshotHash = entry.prevHash
    }
    this.emit({ type: 'snapshot.restored', hash: entry.prevHash, filesChanged: entry.filesChanged })
    return { ok: true, message: `Reverted last write batch (${entry.filesChanged} files, +${entry.additions}/-${entry.deletions}).` }
  }

  getExecutor() {
    return this.executor
  }

  /**
   * Re-root the entire loop at a new project directory: tool executor,
   * LSP diagnostics, and the governance workspace snapshot. Called when a
   * user.message arrives with a different cwd so everything (not just the
   * executor) points at the directory the user is actually working in.
   */
  setCwd(cwd: string): void {
    this.executor.setCwd(cwd)
    this.lspManager.setCwd(cwd)
    if (cwd !== this.snapshotCwd) this.initSnapshot(cwd)
  }

  getFileTracker() {
    return this.fileTracker
  }

  /** The active session journal (for session-end markers). */
  getJournal(): JSONLStore {
    return this.journal
  }

  /** The active session id (for AWM learning promotion at session end). */
  getSessionId(): string {
    return this.sessionId
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

    // ─── P1.8 repair ladder: malformed arguments ─────────────────────
    // The transport marked this call's arguments unparseable (JSON.parse and
    // jsonrepair both failed). Never execute, never silently drop: feed the
    // parse error back as a synthetic tool result so the model re-issues the
    // call (one bounded retry), then surface to the ledger and move on.
    if (isMalformedInput(toolInput)) {
      this._malformedToolCalls++
      const raw = String((toolInput as any).raw ?? '').slice(0, 500)
      const parseError = String((toolInput as any).error ?? 'unparseable JSON')
      const exhausted = this._malformedToolCalls > 1
      const stage = exhausted ? 'discarded' : 'retried'
      console.log(`[toolcall] Malformed args for ${toolName} (${stage}): ${parseError}`)
      this.emit({ type: 'toolcall.transport', stage, toolId, toolName, detail: parseError })
      // Note: the counter spans tools — a second consecutive malformed call is
      // discarded even if it targets a different tool (model-level health).
      const msg = exhausted
        ? `Tool call "${toolName}" was not executed: its arguments were not valid JSON ` +
          `(${parseError}). Repeated malformed tool calls — this call has been dropped. ` +
          `Proceed with a different approach: state your next step in plain text or ` +
          `call a tool with simple, valid JSON.`
        : `Tool call "${toolName}" was not executed: its arguments were not valid JSON. ` +
          `Parse error: ${parseError}. Offending arguments: ${raw} — ` +
          `Re-issue the tool call with valid JSON arguments.`
      this.emit({ type: 'tool.start', toolId, toolName, input: {} })
      this.emit({ type: 'tool.complete', toolId, toolName, result: msg, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: msg }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('failure')
      toolsUsedInSession.push(toolName)
      return
    }
    // Healthy parse: reset the bounded-retry counter.
    this._malformedToolCalls = 0

    // One-time: hydrate grounding intervention success rates from prior sessions.
    if (!this.groundingRatesLoaded) {
      loadInterventionRates(this.governance.getInterventionTracker())
      this.groundingRatesLoaded = true
    }

    // Hard tool pin (one-shot/unattended runs): enforce allowedTools at
    // execution time too — simulated-mode models can hallucinate tools that
    // were never offered in the prompt, and approveAll would run them.
    if (this.allowedTools && !this.allowedTools.includes(toolName)) {
      console.log(`[loop] BLOCKED (not in allowedTools): ${toolName}`)
      const msg = `Tool "${toolName}" is not available in this run. Available tools: ${this.allowedTools.join(', ')}.`
      this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
      this.emit({ type: 'tool.complete', toolId, toolName, result: msg, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: msg }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('denied')
      toolsUsedInSession.push(toolName)
      return
    }

    // S5 live restriction (one-shot runs only): the model can keep calling a
    // tool it saw earlier in history even after a stuck-loop restriction
    // removed it from the prompt — 2026-06-12 replay looped WebSearch to
    // stuck=15 this way. Enforce the per-iteration offered set, with feedback
    // telling the model what it CAN use.
    if (this.allowedTools && this.offeredToolNames && !this.offeredToolNames.has(toolName)) {
      console.log(`[loop] BLOCKED (not offered this turn): ${toolName}`)
      const msg = `Tool "${toolName}" is not available this turn (governance restricted the tool set). ` +
        `Available tools: ${[...this.offeredToolNames].join(', ')}. ` +
        `Use one of those, or produce your final answer from what you already know.`
      this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
      this.emit({ type: 'tool.complete', toolId, toolName, result: msg, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: msg }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('denied')
      toolsUsedInSession.push(toolName)
      return
    }

    // ─── Read-loop gate ────────────────────────────────────────────
    // Deny redundant / stalled reads at execution time so the model is forced
    // to act or stop, instead of reading itself into the context-bloat timeout.
    const readLoopVerdict = this.readLoopGate.evaluate(toolName, toolInput)
    if (readLoopVerdict.kind === 'deny' || readLoopVerdict.kind === 'escalate') {
      console.log(`[read-loop] ${readLoopVerdict.kind.toUpperCase()} ${toolName}`)
      if (readLoopVerdict.kind === 'escalate') {
        // The model has confidently re-emitted a gate-disabled read past the
        // escalation threshold (reasoning/action divergence). Break the attractor
        // by deflating the poisoned context — remove the certified-redundant
        // Read+DENIED pairs — before the next model call.
        const verdict = this.toolDivergence.check({
          tool: toolName,
          entropy: this.lastToolEntropy ?? 0,
          isDisabled: this.readLoopGate.isDisabled(toolName, toolInput),
        })
        const before = this.messages.length
        this.messages = pruneRedundantReads(this.messages, new Set(readLoopVerdict.signatures), readSignature)
        const prunedMessages = before - this.messages.length
        this.dashboardBroadcast?.({
          type: 'brain.toolDivergence',
          tool: toolName,
          prunedMessages,
          signatures: readLoopVerdict.signatures,
          entropy: verdict.entropy,
          floor: verdict.floor,
          diverged: verdict.diverged,
        })
        this.emit({ type: 'governance.alert', severity: 'warn', message: `[context-hygiene] Broke a ${toolName} attractor: pruned ${prunedMessages} redundant re-read messages.`, source: 'read-loop' } as any)
        console.log(`[context-hygiene] pruned ${prunedMessages} messages to break ${toolName} attractor`)
      }
      if (process.env._TRACE_STEERING === '1') this.traceLastInjected = 'readLoopGate-deny'
      this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
      this.emit({ type: 'tool.complete', toolId, toolName, result: readLoopVerdict.message, isError: true })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: readLoopVerdict.message }],
        is_error: true,
      })
      toolsUsedThisTurn.push(toolName)
      toolResultsThisTurn.push('denied')
      toolsUsedInSession.push(toolName)
      return
    }
    const readLoopWarn = readLoopVerdict.kind === 'warn' ? readLoopVerdict.message : null

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
      this.emit({ type: 'tool.complete', toolId, toolName, result: `BLOCKED: ${riskDesc}`, isError: true })
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

    // ─── Grounding gate ────────────────────────────────────────────
    // Fire the moment an edit resolves a multi-source concept (e.g. "happiness")
    // to a non-authoritative plain field instead of its *_system source of truth.
    // Validated retrospectively at 100% precision / 86% recall on city-yield-consumers.
    // `_ABLATION_GROUNDING_DISABLED=1` turns this gate into a no-op so its causal
    // contribution can be isolated in an A/B run, independent of the broader VSM
    // ablation flag (the rest of governance can be held constant in both arms).
    if (
      (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') &&
      process.env._ABLATION_GROUNDING_DISABLED !== '1'
    ) {
      const groundingTracker = this.governance.getInterventionTracker()
      const table = buildConceptTableForCwd(this.executor['cwd'] ?? process.cwd())
      const addedText = extractAddedText(toolName, toolInput)
      const targetPaths = extractTargetPaths(toolName, toolInput)
      const stillUngrounded = new Set(probeEdit(addedText.split('\n'), table).map((f) => f.concept))

      // (1) Resolve prior fires — NEVER gated, so the success rate keeps updating
      // and the self-tuning gate can recover after backing off. A pending (file,
      // concept) resolves only when a later edit to that SAME file re-addresses
      // the concept: grounded now => intervention worked, still ungrounded => failed.
      let ratesDirty = false
      for (const key of [...this.pendingGroundingConcepts]) {
        const sep = key.indexOf('\u0000')
        const pendPath = key.slice(0, sep)
        const concept = key.slice(sep + 1)
        if (!targetPaths.includes(pendPath)) continue // different file — still pending
        if (!new RegExp(`\\b${concept}\\b`).test(addedText)) continue // concept not re-addressed yet
        const success = !stillUngrounded.has(concept)
        groundingTracker.recordIntervention('grounding', success)
        this.pendingGroundingConcepts.delete(key)
        ratesDirty = true
        const resolveJournal = getJournal()
        if (resolveJournal) {
          resolveJournal.log(makeJournalEntry({
            sessionId: this.journal?.path ?? 'unknown',
            system: 'S5',
            input: { trigger: 'grounding', phase: 'resolution', toolName, concept },
            decision: { recorded: 'grounding' },
            outcome: { grounded: success },
          }))
        }
      }
      if (ratesDirty) saveInterventionRates(groundingTracker)

      // (2) Decide whether to FIRE on the current edit. Only the firing side is
      // gated by the self-tuning success rate (fail-open: unseen 'grounding' -> 1.0 -> fires).
      // _PIN_GROUNDING=1 pins the firing side armed regardless of the tracker's
      // success rate (used by the A/B harness to isolate the gate's effect from the
      // self-disabling back-off). Recording/journalling in step (1) is unchanged.
      if (process.env._PIN_GROUNDING === '1' || groundingTracker.shouldIntervene('grounding')) {
        const intensity = this.difficultyClassifier.getGovernanceIntensity()
        const decision = evaluateGrounding(toolName, toolInput, table, intensity)
        if (decision.action !== 'skip') {
          // Log the fire as an S5 training triple. Outcome is unknown at fire time
          // (resolved: 'pending'); the true outcome is back-filled in step (1) above.
          const fireJournal = getJournal()
          if (fireJournal) {
            fireJournal.log(makeJournalEntry({
              sessionId: this.journal?.path ?? 'unknown',
              system: 'S5',
              input: { trigger: 'grounding', phase: 'fire', toolName, concepts: decision.concepts, intensity },
              decision: { action: decision.action },
              outcome: { resolved: 'pending' },
            }))
          }
          // Remember each (file, concept) so resolution judges the RIGHT later edit.
          for (const c of decision.concepts) {
            for (const p of targetPaths) this.pendingGroundingConcepts.add(`${p}\u0000${c}`)
          }

          if (decision.action === 'block') {
            console.log(`[grounding] BLOCKED ${toolName}: ${decision.concepts.join(', ')}`)
            this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })
            this.emit({ type: 'tool.complete', toolId, toolName, result: decision.message, isError: true })
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolId,
              content: [{ type: 'text', text: decision.message }],
              is_error: true,
            })
            toolsUsedThisTurn.push(toolName)
            toolResultsThisTurn.push('denied')
            toolsUsedInSession.push(toolName)
            return
          }
          // action === 'warn': let the edit proceed but surface the note.
          console.log(`[grounding] WARN ${toolName}: ${decision.concepts.join(', ')}`)
          this.emit({ type: 'stream.token', text: `\n[Grounding] ${decision.message}\n` })
        }
      }
    }

    this.emit({ type: 'tool.start', toolId, toolName, input: toolInput })

    const toolStartMs = Date.now()
    const result = await this.executor.execute(toolName, toolInput)

    // ─── SubAgent interception ─────────────────────────────────────
    // spawnAgent.ts returns { _subagent: true, config, blocking } as JSON.
    // We intercept here to actually spawn and run the agent via S2.
    if (toolName === 'SubAgent' && !result.isError) {
      try {
        const parsed = JSON.parse(result.output)
        if (parsed._subagent) {
          const config: SubAgentConfig = parsed.config
          const blocking: boolean = parsed.blocking ?? true

          // 1. Ask S2 to schedule
          const s2Decision = await this.s2.requestSchedule(config.id)
          console.log(`[s2] Schedule decision for ${config.id}: ${s2Decision.decision} — ${s2Decision.reasoning}`)
          this.emit({
            type: 's2.decision',
            decision: s2Decision.decision,
            agentId: config.id,
            reason: s2Decision.reasoning,
            gpuUtil: s2Decision.input.gpuUtil,
            queueDepth: s2Decision.input.queueDepth,
          })

          // 2. Create SubAgent instance
          const agent = new SubAgent({
            config,
            provider: this.provider,
            emit: this.emit,
            cwd: this.executor['cwd'],
            model: this.config.model!,
            s2: {
              updateAgentTurn: (id: string, turn: number, tokens: number) => {
                try { this.s2.updateAgentTurn(id, turn, tokens) } catch {}
              },
              handleAlgedonic: (id: string, signal: string) => {
                try { this.s2.handleAlgedonic(id, signal) } catch {}
              },
            },
          })

          // 3. Register with S2
          this.s2.registerAgent(agent.status, agent)
          this.runningAgents.set(config.id, agent)

          if (blocking) {
            // 4a. Blocking: await completion, store result
            const agentResult = await agent.run()
            this.s2.completeAgent(config.id)
            this.runningAgents.delete(config.id)
            this.agentResults.set(config.id, agentResult)

            result.output = [
              `[SubAgent ${config.id}] (${config.persona}) completed`,
              `Task: ${config.task}`,
              `Turns: ${agentResult.turns} | Tokens: ${agentResult.tokensUsed}`,
              `Success: ${agentResult.success}`,
              '',
              agentResult.output,
            ].join('\n')
          } else {
            // 4b. Non-blocking: start in background, return ID
            agent.run().then((agentResult) => {
              this.s2.completeAgent(config.id)
              this.runningAgents.delete(config.id)
              this.agentResults.set(config.id, agentResult)
              console.log(`[subagent] ${config.id} completed in background: success=${agentResult.success}`)
            }).catch((err) => {
              this.s2.completeAgent(config.id)
              this.runningAgents.delete(config.id)
              this.agentResults.set(config.id, {
                agentId: config.id,
                success: false,
                output: `SubAgent error: ${err instanceof Error ? err.message : String(err)}`,
                turns: 0,
                tokensUsed: 0,
                governanceMetrics: { toolCalls: 0, toolErrors: 0, stuckTurns: 0, compactions: 0 },
              })
              console.log(`[subagent] ${config.id} failed in background: ${err}`)
            })

            result.output = [
              `[SubAgent ${config.id}] (${config.persona}) spawned (non-blocking)`,
              `Task: ${config.task}`,
              `Use CollectAgent with agentId "${config.id}" to retrieve results when ready.`,
            ].join('\n')
          }
        }
      } catch (e) {
        // JSON parse failed — pass through the original result (probably an error)
        console.log(`[subagent] Failed to parse SubAgent output: ${e}`)
      }
    }

    // ─── CollectAgent interception ─────────────────────────────────
    // collectAgent.ts returns { _collectAgent: true, agentId } as JSON.
    // We intercept here to look up actual results.
    if (toolName === 'CollectAgent' && !result.isError) {
      try {
        const parsed = JSON.parse(result.output)
        if (parsed._collectAgent) {
          const agentId: string = parsed.agentId

          const completedResult = this.agentResults.get(agentId)
          if (completedResult) {
            // Agent finished — return full result
            result.output = [
              `[SubAgent ${agentId}] Result:`,
              `Success: ${completedResult.success}`,
              `Turns: ${completedResult.turns} | Tokens: ${completedResult.tokensUsed}`,
              '',
              completedResult.output,
            ].join('\n')
          } else if (this.runningAgents.has(agentId)) {
            // Agent still running — return status
            const agent = this.runningAgents.get(agentId)!
            const status = agent.status
            result.output = [
              `[SubAgent ${agentId}] Still running`,
              `Persona: ${status.persona}`,
              `Turn: ${status.currentTurn}/${status.maxTurns}`,
              `Tokens used: ${status.tokensUsed}`,
              `Try collecting again later.`,
            ].join('\n')
          } else {
            // Agent not found
            result.output = `Error: No agent found with ID "${agentId}". It may have never been spawned or its results were already collected.`
            result.isError = true
          }
        }
      } catch (e) {
        console.log(`[subagent] Failed to parse CollectAgent output: ${e}`)
      }
    }

    console.log(`[loop] Tool result: ${toolName} isError=${result.isError}`)

    // Circuit breaker: track consecutive failures per tool
    if (result.isError) {
      const count = (this.toolFailureCounts.get(toolName) ?? 0) + 1
      this.toolFailureCounts.set(toolName, count)
      if (count >= 3) {
        console.log(`[loop] Circuit breaker: ${toolName} failed ${count} times — overriding result`)
        const writeHint = toolName === 'Write'
          ? '\n- STOP trying to Write the entire file. Use Edit to make SMALL targeted changes instead.\n- Read the file first, find the specific line, use Edit to change just that line.'
          : ''
        result.output = `CIRCUIT BREAKER: ${toolName} has failed ${count} consecutive times. STOP using ${toolName} this way.${writeHint}\n- Try a COMPLETELY DIFFERENT approach\n- If editing: use Edit with small targeted changes, not Write with full file content\n- If running scripts: fix imports/syntax first\n\nOriginal error: ${result.output.slice(0, 300)}`
      }
    } else {
      this.toolFailureCounts.delete(toolName)
    }

    this.emit({
      type: 'tool.complete',
      toolId,
      toolName,
      result: result.output.slice(0, 500),
      isError: result.isError,
    })

    // Phase 6: additionally emit a structured file.diff for the diff_view widget.
    if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      const filePath = (toolInput as any).file_path ?? (toolInput as any).path ?? ''
      const hunks = buildDiffHunks(toolName, toolInput as any)
      if (filePath && hunks.length > 0) {
        this.emit({
          type: 'file.diff',
          path: filePath,
          changeType: toolName === 'Write' ? 'create' : 'modify',
          hunks,
        })
      }
    }

    // Governance: record tool result
    this.governance.onToolResult(toolName, !result.isError, Date.now() - toolStartMs, result.output, toolInput)

    // Deterministic tool gating: track usage so consecutive-overuse can be
    // attenuated out of the offered set on the next iteration (see runModelLoop).
    this.toolGating.recordTool(toolName)

    // TDD governance: track edit-vs-test cadence (opt-in nudge in runModelLoop).
    this.tddGov.recordToolCall(toolName)

    // Governance: track read patterns for prediction system
    const toolFilePath = (toolInput as any).file_path ?? (toolInput as any).path ?? ''
    if (toolFilePath) {
      this.governance.trackReadPattern(toolName, toolFilePath)
    }

    // S1 decision journal: log every tool call as a training triple
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: this.journal?.path ?? 'unknown',
        system: 'S1',
        input: { toolName, turnCount: this.messages.length },
        decision: { tool: toolName, args: toolInput },
        outcome: { success: !result.isError, elapsed: Date.now() - toolStartMs, outputPreview: result.output.slice(0, 200) },
      }))
    }

    // Feed tool telemetry to the difficulty classifier (escalates S5 governance intensity)
    this.difficultyClassifier.recordTurn({ toolCalls: 1, errors: result.isError ? 1 : 0, tokens: 0 })

    // Record trajectory turn for future training
    try {
      const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
      const recorder = getTrajectoryRecorder()
      if (recorder) {
        const { createHash } = require('crypto')
        const elapsed = Date.now() - toolStartMs
        const inputHash = createHash('sha256').update(JSON.stringify(toolInput)).digest('hex').slice(0, 12)
        recorder.recordTurn({
          toolCalls: [{ name: toolName, inputHash, success: !result.isError, latencyMs: elapsed }],
          stateFeatures: {
            filesTouched: 0,
            diffSize: 0,
            testsTotal: 0,
            testsFailing: 0,
            toolsUsed: [toolName],
            contextPct: 0,
          },
          rewardComponents: {
            toolSuccessRate: 1.0,
            stuckTurns: 0,
            varietyEntropy: 0,
          },
        })
        this.emit({
          type: 'trajectory.turn',
          taskId: recorder.taskId ?? null,
          turnIdx: recorder.turnIdx ?? 0,
        })
      }
    } catch {}

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

    // Re-arm the read-loop gate whenever the model actually changes something.
    if (!result.isError && ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'].includes(toolName)) {
      this.readLoopGate.onWrite()
    }

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
    // S3* Reflexion: on a failed tool, append a specific self-correction note
    // to the result the model reads next turn (gated by LOCALCODE_REFLEXION).
    const baseResultText = withReflexion(toolName, result.isError, result.output, truncatedOutput)
    const resultText = readLoopWarn ? `${readLoopWarn}\n\n${baseResultText}` : baseResultText
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolId,
      content: [{ type: 'text', text: resultText }],
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
