// engine/daemon/missionRunner.ts
// Per-mission tick logic. All side effects are injected (runTask, publish,
// fetchMflSnapshot, now) so this is fully testable without ntfy/engine/MFL.
import type { MissionLedger } from './missionLedger.js'
import { evaluateTrigger, computeNextFire } from './scheduler.js'
import { GpuBusyError } from './taskRunner.js'
import { serializeHandoff } from '../memory/handoff.js'
import { ThinkingRecorder } from '../memory/thinkingRecorder.js'
import { applySchedule, cadenceFingerprint, readSchedule, type EffectiveTrigger, type Schedule } from './schedule.js'
import type { ApprovalCommand, PausedRun, Recommendation, TaskFileInput, TaskOutcome, TriggerSpec } from './types.js'

// GPU-busy defer backoff (spec §2/§7): 5 → 10 → 20 → 40 → 60 min, capped.
// In-memory by design — a daemon restart starting fresh at 5 min is fine.
const GPU_DEFER_BASE_MS = 5 * 60 * 1000
const GPU_DEFER_MAX_MS = 60 * 60 * 1000
const FAILURE_ALERT_THRESHOLD = 3
const DEFAULT_TOOLS = ['Mfl', 'WebSearch', 'WebFetch', 'Read']
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const TRADE_SCAN_TIMEOUT_MS = 60 * 60 * 1000
/** A resumed run gets at least this much clock, however little was left when it was paused. */
const MIN_RESUME_MS = 5 * 60 * 1000

/** A configured timeout counts only when it is a positive finite number; anything else falls back. */
function validTimeout(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

type FireResult = { status: 'ran' } | { status: 'gpu-deferred'; retryAtMs: number }

const PRECHECK_LINE_MAX = 120

/**
 * A precheck's stdout is untrusted (it comes from a command that talks to the network) and its
 * summary is shown to the model in the next run's context, so it is stored as bounded plain text:
 * control characters, fences, tags, braces and role/tool markers removed, whitespace collapsed.
 */
export function sanitizePrecheckLine(line: string): string {
  return line
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>{}\[\]|\\]/g, '')
    .replace(/\b(system|assistant|user|tool_call|tool_result|tool)\s*:/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PRECHECK_LINE_MAX)
}

export interface MissionRunnerDeps {
  runTask: (input: TaskFileInput) => Promise<TaskOutcome>
  publish: (p: { title: string; message: string; priority?: number }) => Promise<boolean>
  publishRecommendation: (rec: Recommendation) => Promise<boolean>
  /** Returns a stable hash of the league's current MFL transactions. */
  fetchMflSnapshot: (leagueId: string, year: number) => Promise<string>
  /** Returns a compact text snapshot of the franchise's current roster. */
  fetchRosterSnapshot: (leagueId: string, year: number, franchiseId: string) => Promise<string>
  now: () => Date
  /** Runs a trigger's precheckCommand (precheck 'command'); stdout decides, a throw lets the run proceed. */
  runPrecheck?: (command: string, cwd?: string) => Promise<{ code: number | null; stdout: string }>
  /** The control file says pause: fire nothing, resume nothing (control.ts). */
  isPaused?: () => boolean
}

export class MissionRunner {
  /** Consecutive GPU-busy defers per trigger id (drives the backoff). */
  private gpuDefers = new Map<string, number>()

  /** Queued on-demand phone requests, drained by tick(). In-memory by design —
   *  a daemon restart drops them; the user just resends the command. */
  private onDemand: { week?: number; notBefore?: number }[] = []
  private pauseLogged = false
  /** Last good schedule.json (keyed by mtime); a torn or invalid file keeps it, a missing file clears it. */
  private scheduleCache: { mtimeMs: number | null; schedule: Schedule } | null = null
  private badScheduleLogged: number | null = null
  /** `${mtimeMs}|${triggerId}` already reported as an uncomputable override — log once, not every tick. */
  private brokenOverrideLogged = new Set<string>()
  private lastEffective: EffectiveTrigger[] | null = null

  constructor(
    /** Public (read) so the daemon can collect every mission's nextFire for the doorman wake schedule. */
    readonly ledger: MissionLedger,
    private deps: MissionRunnerDeps,
    /** Override the sessions dir used by ThinkingRecorder.aggregateSession.
     *  Undefined → real ~/.cynco/sessions. Tests pass a temp dir. */
    private sessionsDir?: string,
  ) {}

  /** One scheduler tick: evaluate every trigger, fire due ones sequentially. */
  /** Wall-clock kill: trigger > mission > default (trade-scan keeps its own 60-min default unless the trigger sets one). */
  private timeoutFor(trigger: TriggerSpec): number {
    if (trigger.taskType === 'trade-scan') return validTimeout(trigger.timeoutMs) ?? TRADE_SCAN_TIMEOUT_MS
    return validTimeout(trigger.timeoutMs) ?? validTimeout(this.ledger.config.timeoutMs) ?? DEFAULT_TIMEOUT_MS
  }

  /** The triggers as the last tick saw them: mission.json with schedule.json laid over it. */
  effectiveTriggers(): EffectiveTrigger[] {
    return this.lastEffective ?? this.resolveTriggers(this.deps.now())
  }

  /** Re-reads schedule.json: 'ok' replaces the cache, 'absent' clears it (the owner's reset), 'bad' keeps it. */
  private loadSchedule(): { schedule: Schedule; mtimeMs: number | null } {
    const read = readSchedule(this.ledger.dir)
    if (read.status === 'ok') this.scheduleCache = { mtimeMs: read.mtimeMs, schedule: read.schedule }
    else if (read.status === 'absent') this.scheduleCache = null
    else if (this.badScheduleLogged !== read.mtimeMs) {
      this.badScheduleLogged = read.mtimeMs
      console.log(`[mission:${this.ledger.config.id}] schedule.json is unreadable or invalid — keeping the last good overrides`)
    }
    return this.scheduleCache ?? { schedule: { triggers: {} }, mtimeMs: null }
  }

  /**
   * Effective triggers for this tick. validateOverride checks fields one at a time, so an override
   * can still describe a cadence computeNextFire cannot compute (kind 'cron' with no cron); that
   * trigger keeps its mission.json cadence (its on/off switch still applies) and the tick goes on.
   */
  private resolveTriggers(now: Date): EffectiveTrigger[] {
    const { schedule, mtimeMs } = this.loadSchedule()
    const declared = new Map(this.ledger.config.triggers.map((t) => [t.id, t]))
    this.lastEffective = applySchedule(this.ledger.config.triggers, schedule).triggers.map((t) => {
      try {
        computeNextFire(t, now)
        return t
      } catch (err) {
        const key = `${mtimeMs}|${t.id}`
        if (!this.brokenOverrideLogged.has(key)) {
          this.brokenOverrideLogged.add(key)
          console.log(`[mission:${this.ledger.config.id}] schedule.json override for "${t.id}" ignored (${err instanceof Error ? err.message : err}) — keeping its mission.json cadence`)
        }
        return { ...declared.get(t.id)!, enabled: t.enabled, overridden: t.overridden.filter((k) => k === 'enabled') }
      }
    })
    return this.lastEffective
  }

  /** A slot already due moves to its next slot from now, without firing. Returns whether it moved. */
  private moveFromNowIfDue(trigger: TriggerSpec, now: Date): boolean {
    const due = this.ledger.state.nextFire[trigger.id]
    if (due === undefined || new Date(due).getTime() > now.getTime()) return false
    this.ledger.setNextFire(trigger.id, computeNextFire(trigger, now).toISOString())
    return true
  }

  /** A switched-off trigger is never evaluated, but its grid keeps moving so switching it on fires no catch-up. */
  private advanceDisabled(trigger: EffectiveTrigger, now: Date): void {
    if (this.ledger.state.nextFire[trigger.id] === undefined) {
      this.ledger.setNextFire(trigger.id, computeNextFire(trigger, now).toISOString())
      return
    }
    this.moveFromNowIfDue(trigger, now)
  }

  /** A cadence the owner changed since the last tick restarts the grid from now; the first sighting only records it. */
  private applyFingerprint(trigger: EffectiveTrigger, now: Date): void {
    const fp = cadenceFingerprint(trigger)
    const seen = this.ledger.state.scheduleSeen?.[trigger.id]
    if (seen !== undefined && seen !== fp) {
      this.ledger.setNextFire(trigger.id, computeNextFire(trigger, now).toISOString())
      console.log(`[mission:${this.ledger.config.id}] cadence of "${trigger.id}" changed — next slot from now`)
    }
    this.ledger.state.scheduleSeen = { ...this.ledger.state.scheduleSeen, [trigger.id]: fp }
  }

  async tick(): Promise<void> {
    const now = this.deps.now()
    if (this.deps.isPaused?.()) {
      if (!this.pauseLogged) console.log(`[mission:${this.ledger.config.id}] paused by the control file — firing nothing until it clears`)
      this.pauseLogged = true
      return
    }
    const effective = this.resolveTriggers(now)
    if (this.pauseLogged) {
      // Resume picks the schedule up from now: a slot that came due while paused moves to its
      // next slot instead of firing as a catch-up (owner decision 2026-11-08). Only on this edge,
      // never at startup, so run-once-on-startup still catches up after a restart.
      let moved = 0
      for (const trigger of effective) if (this.moveFromNowIfDue(trigger, now)) moved++
      if (moved > 0) this.ledger.saveState()
      console.log(`[mission:${this.ledger.config.id}] pause lifted — ${moved} trigger(s) moved to their next slot`)
    }
    this.pauseLogged = false
    if (this.ledger.state.paused) await this.resumePaused(this.ledger.state.paused, effective, now)
    if (this.deps.isPaused?.()) return
    await this.drainOnDemand(now)
    for (const trigger of effective) {
      if (!trigger.enabled) {
        this.advanceDisabled(trigger, now)
        continue
      }
      this.applyFingerprint(trigger, now)
      const due = this.ledger.state.nextFire[trigger.id]
      const evaln = evaluateTrigger(trigger, due, now)
      if (evaln.action === 'wait') continue
      // A pause that landed during an earlier fire in this tick: stop here, leave this trigger's
      // nextFire alone (the from-now move handles it when the pause lifts), and never spawn a run
      // whose kill would overwrite the PausedRun just parked.
      if (this.deps.isPaused?.()) break
      if (evaln.action === 'skip') {
        // Usually another run held the daemon past this trigger's grace window. Say so: a silent skip of a
        // game-day pass is indistinguishable from the trigger never having been scheduled.
        console.log(`[mission:${this.ledger.config.id}] skipped trigger "${trigger.id}": due ${due}, missed by more than the grace window (missedPolicy skip); next ${evaln.next.toISOString()}`)
      }
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
      if (this.deps.isPaused?.()) return // stays queued until the pause lifts
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

  /** Relaunch a run the control file interrupted: same task, the journal to continue from, the clock it had left. */
  private async resumePaused(paused: PausedRun, effective: EffectiveTrigger[], now: Date): Promise<void> {
    const declared = effective.find((t) => t.id === paused.triggerId)
    if (declared && !declared.enabled) {
      // Switched off while parked: the owner no longer wants this pass. A cadence change does not drop it.
      delete this.ledger.state.paused
      this.ledger.recordRun({ ts: now.toISOString(), triggerId: paused.triggerId, ok: true, summary: `dropped on disable: ${paused.triggerId}`, recommendationIds: [], entropy: null })
      this.ledger.saveState()
      console.log(`[mission:${this.ledger.config.id}] parked run "${paused.triggerId}" dropped — the trigger is switched off in schedule.json`)
      return
    }
    const trigger: TriggerSpec = declared
      ?? { id: paused.triggerId, kind: 'daily' as const, at: '00:00', precheck: 'none' as const, missedPolicy: 'skip' as const, prompt: paused.input.prompt }
    const input: TaskFileInput = {
      ...paused.input,
      outcomePath: '',
      timeoutMs: Math.max(paused.remainingMs, MIN_RESUME_MS),
      ...(paused.sessionId ? { resumeSessionId: paused.sessionId } : {}),
    }
    console.log(`[mission:${this.ledger.config.id}] resuming "${paused.triggerId}" ${paused.sessionId ? `from ${paused.sessionId}` : 'from scratch (no journal was captured)'} with ${Math.round(input.timeoutMs / 60000)} min left`)
    let outcome: TaskOutcome
    try {
      outcome = await this.deps.runTask(input)
    } catch (err) {
      if (err instanceof GpuBusyError) {
        console.log(`[mission:${this.ledger.config.id}] GPU busy — the paused run "${paused.triggerId}" waits for the next tick`)
        return
      }
      outcome = { ok: false, summary: '', recommendations: [], error: err instanceof Error ? err.message : String(err) }
    }
    if (outcome.paused) {
      // Paused again mid-resume: park it again with the clock it has left, never a failure.
      const { resumeSessionId: _prev, ...rest } = input
      this.park(trigger.id, rest, outcome.paused, now, paused.sessionId)
      return
    }
    delete this.ledger.state.paused
    this.ledger.saveState()
    await this.complete(trigger, input, outcome, now)
  }

  /** Remember a run the control file interrupted (state.paused) and record it as an ok run. */
  private park(triggerId: string, input: TaskFileInput, paused: NonNullable<TaskOutcome['paused']>, now: Date, fallbackSessionId?: string): void {
    const remainingMs = Math.max(input.timeoutMs - paused.elapsedMs, 0)
    const { outcomePath: _dropped, ...rest } = input
    const sessionId = paused.sessionId ?? fallbackSessionId
    this.ledger.state.paused = {
      triggerId, input: { ...rest, outcomePath: '' }, remainingMs,
      ...(sessionId ? { sessionId } : {}),
      pausedAt: now.toISOString(),
    }
    this.ledger.recordRun({
      ts: now.toISOString(), triggerId, ok: true,
      summary: `paused on request after ${Math.round(paused.elapsedMs / 60000)} min (${Math.round(remainingMs / 60000)} min left); resumes when the pause lifts`,
      recommendationIds: [], entropy: null,
    })
    this.ledger.saveState()
  }

  private async fire(trigger: TriggerSpec, now: Date): Promise<FireResult> {
    // Cheap pre-check (precheck 'command'): the trigger's own gate decides whether the model is worth
    // loading. stdout starting with "skip" records a skipped run and spawns nothing; a failing or
    // throwing precheck lets the run proceed, so a broken gate cannot silence a mission.
    if (trigger.precheck === 'command' && trigger.precheckCommand) {
      let verdict: { code: number | null; stdout: string } | null = null
      try {
        verdict = this.deps.runPrecheck
          ? await this.deps.runPrecheck(trigger.precheckCommand, trigger.cwd ?? this.ledger.config.cwd)
          : null
      } catch (err) {
        console.log(`[mission:${this.ledger.config.id}] precheck for "${trigger.id}" threw (${err instanceof Error ? err.message : err}) — running the pass anyway`)
      }
      const firstLine = sanitizePrecheckLine((verdict?.stdout ?? '').trim().split(/\r?\n/)[0] ?? '')
      if (/^skip\b/i.test(firstLine)) {
        console.log(`[mission:${this.ledger.config.id}] precheck skipped "${trigger.id}": ${firstLine}`)
        // Quoted: in the next run's context this is a report of what a command printed, not an instruction.
        this.ledger.recordRun({ ts: now.toISOString(), triggerId: trigger.id, ok: true, summary: `precheck skipped the pass: "${firstLine}"`, recommendationIds: [], entropy: null })
        return { status: 'ran' }
      }
      if (verdict) console.log(`[mission:${this.ledger.config.id}] precheck for "${trigger.id}": ${firstLine || `(exit ${verdict.code}, no output)`} — running the pass`)
    }

    // Cheap pre-check: skip the model entirely when MFL hasn't changed
    if (trigger.precheck === 'mfl-delta') {
      let anyDelta = false
      for (const league of this.ledger.config.leagues ?? []) {
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
    for (const league of this.ledger.config.leagues ?? []) {
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

    // Tool pin and workspace: trigger > mission > read-only default (engine/daemon/CLAUDE.md
    // "Per-mission tools and workspace"). Copied so a run cannot mutate the config's array.
    const allowedTools = [...(trigger.allowedTools ?? this.ledger.config.allowedTools ?? DEFAULT_TOOLS)]
    const cwd = trigger.cwd ?? this.ledger.config.cwd
    const input: TaskFileInput = {
      missionId: this.ledger.config.id,
      triggerId: trigger.id,
      prompt: trigger.prompt,
      context,
      allowedTools,
      ...(cwd ? { cwd } : {}),
      timeoutMs: this.timeoutFor(trigger),
      outcomePath: '', // TaskRunner fills this in
      ...(trigger.taskType ? { taskType: trigger.taskType } : {}),
      leagues: this.ledger.config.leagues ?? [],
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

    if (outcome.paused) {
      // Not a failure: remember the run and relaunch it when the control file clears.
      this.park(trigger.id, input, outcome.paused, now)
      return { status: 'ran' }
    }

    await this.complete(trigger, input, outcome, now)
    return { status: 'ran' }
  }

  /** Record a finished run, keep the failure streak, hand recommendations to the phone. */
  private async complete(trigger: TriggerSpec, _input: TaskFileInput, outcome: TaskOutcome, now: Date): Promise<void> {
    this.ledger.recordRun({
      ts: now.toISOString(),
      triggerId: trigger.id,
      ok: outcome.ok,
      summary: outcome.ok ? outcome.summary : (outcome.error ?? 'failed'),
      recommendationIds: outcome.recommendations.map((r) => r.id),
      entropy: outcome.sessionId
        ? ThinkingRecorder.aggregateSession(outcome.sessionId, this.sessionsDir)
        : null,
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
      return
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
    if (outcome.recommendations.length === 0 && trigger.precheck !== 'mfl-delta') {
      // Digest-style runs report even when nothing is actionable
      await this.deps.publish({ title: `Mission ${this.ledger.config.id}: ${trigger.id}`, message: outcome.summary })
    }
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
