// engine/daemon/missionRunner.ts
// Per-mission tick logic. All side effects are injected (runTask, publish,
// fetchMflSnapshot, now) so this is fully testable without ntfy/engine/MFL.
import type { MissionLedger } from './missionLedger.js'
import { evaluateTrigger, computeNextFire } from './scheduler.js'
import { GpuBusyError } from './taskRunner.js'
import { serializeHandoff } from '../memory/handoff.js'
import type { ApprovalCommand, Recommendation, TaskFileInput, TaskOutcome, TriggerSpec } from './types.js'

// GPU-busy defer backoff (spec §2/§7): 5 → 10 → 20 → 40 → 60 min, capped.
// In-memory by design — a daemon restart starting fresh at 5 min is fine.
const GPU_DEFER_BASE_MS = 5 * 60 * 1000
const GPU_DEFER_MAX_MS = 60 * 60 * 1000
const FAILURE_ALERT_THRESHOLD = 3
const DEFAULT_TOOLS = ['Mfl', 'WebSearch', 'WebFetch', 'Read']
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const TRADE_SCAN_TIMEOUT_MS = 60 * 60 * 1000

type FireResult = { status: 'ran' } | { status: 'gpu-deferred'; retryAtMs: number }

export interface MissionRunnerDeps {
  runTask: (input: TaskFileInput) => Promise<TaskOutcome>
  publish: (p: { title: string; message: string; priority?: number }) => Promise<boolean>
  publishRecommendation: (rec: Recommendation) => Promise<boolean>
  /** Returns a stable hash of the league's current MFL transactions. */
  fetchMflSnapshot: (leagueId: string, year: number) => Promise<string>
  /** Returns a compact text snapshot of the franchise's current roster. */
  fetchRosterSnapshot: (leagueId: string, year: number, franchiseId: string) => Promise<string>
  now: () => Date
}

export class MissionRunner {
  /** Consecutive GPU-busy defers per trigger id (drives the backoff). */
  private gpuDefers = new Map<string, number>()

  /** Queued on-demand phone requests, drained by tick(). In-memory by design —
   *  a daemon restart drops them; the user just resends the command. */
  private onDemand: { week?: number; notBefore?: number }[] = []

  constructor(
    private ledger: MissionLedger,
    private deps: MissionRunnerDeps,
  ) {}

  /** One scheduler tick: evaluate every trigger, fire due ones sequentially. */
  async tick(): Promise<void> {
    const now = this.deps.now()
    await this.drainOnDemand(now)
    for (const trigger of this.ledger.config.triggers) {
      const evaln = evaluateTrigger(trigger, this.ledger.state.nextFire[trigger.id], now)
      if (evaln.action === 'wait') continue
      this.ledger.setNextFire(trigger.id, evaln.next.toISOString())
      // Persist BEFORE firing: a crash mid-run must not re-fire the trigger
      // on restart with the old nextFire still on disk.
      this.ledger.saveState()
      if (evaln.action === 'init' || evaln.action === 'skip') continue
      await this.fire(trigger, now)
    }
    this.ledger.saveState()
  }

  private async drainOnDemand(now: Date): Promise<void> {
    while (this.onDemand.length > 0) {
      const req = this.onDemand[0]
      if (req.notBefore !== undefined && now.getTime() < req.notBefore) return
      const template = this.ledger.config.commands?.['lineup']
      if (!template) { this.onDemand.shift(); continue } // template vanished since queuing — drop
      const prompt = template.replace(/\{week\}/g, req.week !== undefined ? `week ${req.week}` : 'the upcoming week')
      const trigger: TriggerSpec = {
        id: 'on-demand-lineup', kind: 'daily', at: '00:00', precheck: 'none', missedPolicy: 'skip', prompt,
      }
      const result = await this.fire(trigger, now)
      if (result.status === 'gpu-deferred') {
        req.notBefore = result.retryAtMs
        return
      }
      this.onDemand.shift()
    }
  }

  private async fire(trigger: TriggerSpec, now: Date): Promise<FireResult> {
    // Cheap pre-check: skip the model entirely when MFL hasn't changed
    if (trigger.precheck === 'mfl-delta') {
      let anyDelta = false
      for (const league of this.ledger.config.leagues) {
        try {
          const hash = await this.deps.fetchMflSnapshot(league.leagueId, league.year)
          if (this.ledger.state.lastSeen[league.leagueId] !== hash) {
            anyDelta = true
            this.ledger.setLastSeen(league.leagueId, hash)
          }
        } catch {
          anyDelta = true // can't check — let the engine look
        }
      }
      if (!anyDelta) return { status: 'ran' }
    }

    // Mission context (spec §3): goal + last 3 run summaries in the existing
    // handoff format (engine/memory/handoff.ts YAML), plus a roster snapshot
    // per league fetched by the daemon directly — no inference, one HTTP call.
    const handoffYaml = serializeHandoff({
      goal: this.ledger.config.goal,
      now: `Scheduled trigger "${trigger.id}" fired at ${now.toISOString()}`,
      status: 'in_progress',
      what_was_done: this.ledger.recentRuns(3).map(
        (r) => `[${r.ts}] ${r.triggerId} ${r.ok ? 'ok' : 'FAILED'}: ${r.summary.slice(0, 200)}`,
      ),
    })
    const rosterSections: string[] = []
    for (const league of this.ledger.config.leagues) {
      let snapshot: string
      try {
        snapshot = await this.deps.fetchRosterSnapshot(league.leagueId, league.year, league.franchiseId)
      } catch (err) {
        // Don't block the run — the model has the Mfl tool to fetch it itself
        snapshot = `(roster unavailable: ${err instanceof Error ? err.message : String(err)})`
      }
      rosterSections.push(
        `League ${league.leagueId} (year ${league.year}, your franchise ${league.franchiseId}) roster snapshot:\n${snapshot}`,
      )
    }
    const context = [handoffYaml.trimEnd(), ...rosterSections].join('\n\n')

    const input: TaskFileInput = {
      missionId: this.ledger.config.id,
      triggerId: trigger.id,
      prompt: trigger.prompt,
      context,
      allowedTools: DEFAULT_TOOLS,
      timeoutMs: trigger.taskType === 'trade-scan' ? TRADE_SCAN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      outcomePath: '', // TaskRunner fills this in
      ...(trigger.taskType ? { taskType: trigger.taskType } : {}),
      leagues: this.ledger.config.leagues,
    }

    let outcome: TaskOutcome
    try {
      outcome = await this.deps.runTask(input)
      this.gpuDefers.delete(trigger.id) // GPU was free — reset the backoff
    } catch (err) {
      if (err instanceof GpuBusyError) {
        // Defer with escalating backoff, don't count as failure
        const defers = this.gpuDefers.get(trigger.id) ?? 0
        const deferMs = Math.min(GPU_DEFER_BASE_MS * 2 ** defers, GPU_DEFER_MAX_MS)
        this.gpuDefers.set(trigger.id, defers + 1)
        console.log(`[mission:${this.ledger.config.id}] GPU busy — deferring trigger "${trigger.id}" by ${deferMs / 60000} min (defer #${defers + 1})`)
        // Synthetic (on-demand) triggers are not in config.triggers — keep
        // their bookkeeping out of state.json nextFire.
        if (this.ledger.config.triggers.some((t) => t.id === trigger.id)) {
          this.ledger.setNextFire(trigger.id, new Date(now.getTime() + deferMs).toISOString())
        }
        return { status: 'gpu-deferred', retryAtMs: now.getTime() + deferMs }
      }
      outcome = { ok: false, summary: '', recommendations: [], error: err instanceof Error ? err.message : String(err) }
    }

    this.ledger.recordRun({
      ts: now.toISOString(),
      triggerId: trigger.id,
      ok: outcome.ok,
      summary: outcome.ok ? outcome.summary : (outcome.error ?? 'failed'),
      recommendationIds: outcome.recommendations.map((r) => r.id),
    })

    if (!outcome.ok) {
      this.ledger.state.failureStreak += 1
      // Persist before notifying: crash between saveState and publish is safe —
      // the streak survives and no notification is pending.
      this.ledger.saveState()
      const isHalt = outcome.error?.startsWith('HALTED:') ?? false
      if (isHalt) {
        // Algedonic Critical: page immediately, do not wait for a streak (P1.1)
        await this.deps.publish({
          title: `CynCo HALTED on mission ${this.ledger.config.id}`,
          message: outcome.error ?? 'halted',
          priority: 5,
        })
      } else if (this.ledger.state.failureStreak >= FAILURE_ALERT_THRESHOLD) {
        await this.deps.publish({
          title: `CynCo stuck on mission ${this.ledger.config.id}`,
          message: `${this.ledger.state.failureStreak} consecutive failures. Last error: ${outcome.error ?? 'unknown'}`,
          priority: 5,
        })
      }
      return { status: 'ran' }
    }

    this.ledger.state.failureStreak = 0
    for (const rec of outcome.recommendations) {
      this.ledger.addPending(rec)
    }
    // Persist all ledger mutations BEFORE any phone notifications.
    // If the daemon crashes after saveState but before a publish, the
    // pending is on disk and the user can re-check; the reverse would
    // produce an approve/reject button with no matching pending.
    this.ledger.saveState()
    for (const rec of outcome.recommendations) {
      await this.deps.publishRecommendation(rec)
    }
    if (outcome.recommendations.length === 0 && trigger.precheck === 'none') {
      // Digest-style runs report even when nothing is actionable
      await this.deps.publish({ title: `Mission ${this.ledger.config.id}: ${trigger.id}`, message: outcome.summary })
    }
    return { status: 'ran' }
  }

  /** Handle an approve/reject command from the phone. Returns false if the recId is unknown to this mission. */
  async handleCommand(cmd: ApprovalCommand): Promise<boolean> {
    const res = this.ledger.resolveApproval(cmd.recId, cmd.verdict)
    if (!res) return false
    console.log(`[mission:${this.ledger.config.id}] ${cmd.verdict}: "${res.rec.summary}" (${res.rec.actionType} streak now ${this.ledger.state.trust[res.rec.actionType]?.approvedStreak ?? 'n/a'})`)
    await this.deps.publish({
      title: `${cmd.verdict === 'approve' ? 'Approved' : 'Rejected'}: ${res.rec.summary}`,
      message: cmd.verdict === 'approve' ? 'Noted — execute it in MFL when ready.' : 'Noted — streak reset.',
    })
    if (res.promotionEligible) {
      await this.deps.publish({
        title: `Trust promotion available: ${res.rec.actionType}`,
        message: `You have approved the last ${this.ledger.state.trust[res.rec.actionType]?.approvedStreak} ${res.rec.actionType} recommendations without edits. Phase C (autonomous ${res.rec.actionType}) is now justifiable — this remains informational until Phase C ships.`,
        priority: 3,
      })
    }
    return true
  }

  /** Handle a free-text phone command. Recognized commands are queued for the
   *  next tick — a model run NEVER starts from the SSE callback. */
  async handleTextCommand(text: string): Promise<void> {
    const trimmed = text.trim()
    const m = /^lineup(?:\s+(\d{1,2}))?$/i.exec(trimmed)
    if (!m) {
      await this.deps.publish({
        title: 'Unknown command',
        message: `"${trimmed.slice(0, 80)}" — valid commands: "lineup" (upcoming week) or "lineup <week>"`,
      })
      return
    }
    if (!this.ledger.config.commands?.['lineup']) {
      await this.deps.publish({
        title: 'Lineup command unavailable',
        message: 'mission.json has no commands.lineup prompt template.',
      })
      return
    }
    const week = m[1] !== undefined ? parseInt(m[1], 10) : undefined
    this.onDemand.push({ week })
    await this.deps.publish({
      title: 'Lineup queued',
      message: `Suggested lineup for ${week !== undefined ? `week ${week}` : 'the upcoming week'} — report arrives in a few minutes.`,
    })
  }
}
