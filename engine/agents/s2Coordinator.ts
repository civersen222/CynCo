import { makeS2Decision } from './types.js'
import type { SubAgentStatus, S2Decision, S2State } from './types.js'
import { getJournal } from '../training/decisionJournal.js'
import { makeJournalEntry } from '../training/types.js'

// ─── Options ──────────────────────────────────────────────────────────────────

export type S2Options = {
  /** Injectable GPU utilisation poller (0.0 – 1.0). */
  pollGpuUtil: () => Promise<number>
  /** Below this threshold, concurrent agents are allowed (default 0.60). */
  gpuLowThreshold?: number
  /** Above this threshold, only one agent may run at a time (default 0.85). */
  gpuHighThreshold?: number
}

// ─── S2Coordinator ────────────────────────────────────────────────────────────

/**
 * S2 Coordinator — Viable System Model S2 layer.
 *
 * Responsibilities:
 *   1. Resource scheduling — GPU-based run/queue decisions.
 *   2. Algedonic routing   — stuck/failure signal handling (absorb/escalate/kill).
 *   3. Agent lifecycle     — register, update, complete, kill, drainQueue.
 *
 * All decisions are appended to `state.decisions` so they can be used as
 * training data for the S5 fine-tuning pipeline.
 */
export class S2Coordinator {
  private readonly pollGpuUtil: () => Promise<number>
  private readonly gpuLow: number
  private readonly gpuHigh: number

  /** Live agent instances keyed by agentId — used to enforce kill decisions. */
  private agentInstances = new Map<string, { kill: () => void }>()

  private readonly state: S2State = {
    activeAgents: new Map(),
    fileLocks: new Map(),
    gpuUtilization: 0,
    queueDepth: 0,
    decisions: [],
  }

  constructor(opts: S2Options) {
    this.pollGpuUtil = opts.pollGpuUtil
    this.gpuLow = opts.gpuLowThreshold ?? 0.60
    this.gpuHigh = opts.gpuHighThreshold ?? 0.85
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Poll GPU and decide whether to run or queue the given agent. */
  async requestSchedule(agentId: string): Promise<S2Decision> {
    const gpuUtil = await this.pollGpuUtil()
    this.state.gpuUtilization = gpuUtil

    const runningCount = this.getRunningCount()
    const queueDepth = this.getQueuedCount()
    this.state.queueDepth = queueDepth
    const fileLocks = Array.from(this.state.fileLocks.keys())

    let decision: S2Decision

    if (gpuUtil < this.gpuLow) {
      // Green zone — always run concurrent.
      decision = makeS2Decision({
        type: 'schedule',
        agentId,
        input: { gpuUtil, queueDepth, fileLocks },
        decision: 'run',
        reasoning: `GPU at ${pct(gpuUtil)}, below low threshold ${pct(this.gpuLow)} — concurrent run allowed`,
      })
    } else if (gpuUtil <= this.gpuHigh) {
      // Medium zone — queue unless this would be the first agent.
      if (runningCount === 0) {
        decision = makeS2Decision({
          type: 'schedule',
          agentId,
          input: { gpuUtil, queueDepth, fileLocks },
          decision: 'run',
          reasoning: `GPU at ${pct(gpuUtil)} (medium zone) but no agents running — first agent allowed`,
        })
      } else {
        decision = makeS2Decision({
          type: 'schedule',
          agentId,
          input: { gpuUtil, queueDepth, fileLocks },
          decision: 'queue',
          reasoning: `GPU at ${pct(gpuUtil)}, between ${pct(this.gpuLow)}–${pct(this.gpuHigh)} with ${runningCount} running — queued`,
        })
      }
    } else {
      // Red zone — sequential only (unless queue is empty and nothing running).
      if (runningCount === 0) {
        decision = makeS2Decision({
          type: 'schedule',
          agentId,
          input: { gpuUtil, queueDepth, fileLocks },
          decision: 'run',
          reasoning: `GPU at ${pct(gpuUtil)} (high zone) but no agents running — first agent allowed sequentially`,
        })
      } else {
        decision = makeS2Decision({
          type: 'schedule',
          agentId,
          input: { gpuUtil, queueDepth, fileLocks },
          decision: 'queue',
          reasoning: `GPU at ${pct(gpuUtil)}, above high threshold ${pct(this.gpuHigh)} with ${runningCount} running — sequential only, queued`,
        })
      }
    }

    this.state.decisions.push(decision)

    // S2 decision journal
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: 'coordinator',
        system: 'S2',
        input: { gpuUtil, queueDepth, runningCount },
        decision: { action: decision.decision, reasoning: decision.reasoning },
      }))
    }

    return decision
  }

  /**
   * Handle an algedonic (pain/alarm) signal from a sub-agent.
   *
   * Decision logic:
   *   - Near budget limit (turns ≥ 90% of maxTurns) → kill
   *   - Severely stuck (turns ≥ 80% of maxTurns)    → escalate
   *   - Otherwise                                    → absorb
   */
  handleAlgedonic(agentId: string, signal: string): S2Decision {
    const gpuUtil = this.state.gpuUtilization
    const queueDepth = this.getQueuedCount()
    const fileLocks = Array.from(this.state.fileLocks.keys())
    const agent = this.state.activeAgents.get(agentId)

    let decision: S2Decision

    if (!agent) {
      // Unknown agent — absorb and log.
      decision = makeS2Decision({
        type: 'algedonic',
        agentId,
        input: { gpuUtil, queueDepth, fileLocks, signal },
        decision: 'absorb',
        reasoning: `Agent ${agentId} not found in active registry — signal absorbed`,
      })
      this.state.decisions.push(decision)
      return decision
    }

    const turnRatio = agent.currentTurn / agent.maxTurns

    if (turnRatio >= 0.9) {
      // Near or at budget limit — kill to free resources.
      decision = makeS2Decision({
        type: 'algedonic',
        agentId,
        input: { gpuUtil, queueDepth, fileLocks, signal },
        decision: 'kill',
        reasoning: `Agent at ${pct(turnRatio)} of turn budget (${agent.currentTurn}/${agent.maxTurns}) — killed to reclaim resources`,
      })
    } else if (turnRatio >= 0.8) {
      // Severely stuck — escalate to S3/S5 for intervention.
      decision = makeS2Decision({
        type: 'algedonic',
        agentId,
        input: { gpuUtil, queueDepth, fileLocks, signal },
        decision: 'escalate',
        reasoning: `Agent at ${pct(turnRatio)} of turn budget (${agent.currentTurn}/${agent.maxTurns}) with signal "${signal}" — escalated`,
      })
    } else {
      // Budget remaining — absorb and let the agent continue.
      decision = makeS2Decision({
        type: 'algedonic',
        agentId,
        input: { gpuUtil, queueDepth, fileLocks, signal },
        decision: 'absorb',
        reasoning: `Agent at ${pct(turnRatio)} of turn budget with signal "${signal}" — absorbed, agent continues`,
      })
    }

    this.state.decisions.push(decision)

    // ── Enforce the decision ─────────────────────────────────────────────────
    if (decision.decision === 'kill') {
      const instance = this.agentInstances.get(agentId)
      if (instance?.kill) {
        instance.kill()
        console.log(`[s2] ENFORCE: killed agent ${agentId}`)
      }
      this.agentInstances.delete(agentId)
      // Promote any queued agents now that a slot has freed up.
      this.drainQueue().catch(() => {/* best-effort */})
    } else if (decision.decision === 'escalate') {
      console.warn(`[s2] ESCALATE: agent ${agentId} requires S3/S5 intervention — ${decision.reasoning}`)
    }

    // S2 algedonic journal
    const journal = getJournal()
    if (journal) {
      journal.log(makeJournalEntry({
        sessionId: 'coordinator',
        system: 'S2',
        agentId: agentId,
        input: { signal, turnRatio: agent ? agent.currentTurn / agent.maxTurns : 0 },
        decision: { action: decision.decision, reasoning: decision.reasoning },
      }))
    }

    return decision
  }

  /** Register a new agent in the active registry.
   *
   * Pass an `instance` with a `kill()` method to enable S2 kill enforcement.
   * When S2 decides to kill an agent, it will call `instance.kill()`.
   */
  registerAgent(status: SubAgentStatus, instance?: { kill: () => void }): void {
    this.state.activeAgents.set(status.id, { ...status })
    if (instance) {
      this.agentInstances.set(status.id, instance)
    }
    this.state.queueDepth = this.getQueuedCount()
  }

  /** Update turn count and token usage for a running agent. */
  updateAgentTurn(agentId: string, turn: number, tokensUsed: number): void {
    const agent = this.state.activeAgents.get(agentId)
    if (agent) {
      agent.currentTurn = turn
      agent.tokensUsed = tokensUsed
    }
  }

  /** Mark agent as completed and remove from active registry. */
  completeAgent(agentId: string): void {
    const agent = this.state.activeAgents.get(agentId)
    if (agent) {
      agent.state = 'completed'
      agent.endTime = Date.now()
      this.state.activeAgents.delete(agentId)
    }
    this.agentInstances.delete(agentId)
    this.state.queueDepth = this.getQueuedCount()

    // Backfill S2 scheduling decision with agent outcome
    const journal = getJournal()
    if (journal && agent) {
      journal.backfill('S2', agent.startTime, {
        agentCompleted: true,
        finalState: agent.state,
        totalTurns: agent.currentTurn,
        tokensUsed: agent.tokensUsed,
      })
    }
  }

  /** Kill an agent and remove from active registry. */
  killAgent(agentId: string): void {
    const agent = this.state.activeAgents.get(agentId)
    if (agent) {
      agent.state = 'killed'
      agent.endTime = Date.now()
      this.state.activeAgents.delete(agentId)
    }
    this.agentInstances.delete(agentId)
    this.state.queueDepth = this.getQueuedCount()
  }

  /**
   * Inspect queued agents and start any that can run given the current GPU.
   * Returns the list of agent IDs that were promoted to 'running'.
   */
  async drainQueue(): Promise<string[]> {
    const promoted: string[] = []

    for (const [id, agent] of this.state.activeAgents) {
      if (agent.state !== 'queued') continue

      const decision = await this.requestSchedule(id)
      if (decision.decision === 'run') {
        agent.state = 'running'
        promoted.push(id)
      } else {
        // GPU still saturated — no point checking further agents.
        break
      }
    }

    this.state.queueDepth = this.getQueuedCount()
    return promoted
  }

  /** Snapshot of current S2 state (activeAgents, fileLocks, decisions, …). */
  getState(): S2State {
    return this.state
  }

  /** Number of agents currently in the 'running' state. */
  getRunningCount(): number {
    let count = 0
    for (const agent of this.state.activeAgents.values()) {
      if (agent.state === 'running') count++
    }
    return count
  }

  /** Number of agents currently in the 'queued' state. */
  getQueuedCount(): number {
    let count = 0
    for (const agent of this.state.activeAgents.values()) {
      if (agent.state === 'queued') count++
    }
    return count
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}
