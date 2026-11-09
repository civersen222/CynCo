// engine/daemon/types.ts
// Shared types for the liveness layer. The daemon (engine/daemon/main.ts) and the
// one-shot engine mode (oneShot.ts) communicate ONLY via these contracts.

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface TriggerSpec {
  id: string
  /** interval: fire every `everyMinutes`. daily: fire at `at` (HH:MM local). weekly: fire on `day` at `at`. cron: 5-field `cron` expression (local time). */
  kind: 'interval' | 'daily' | 'weekly' | 'cron'
  everyMinutes?: number
  at?: string
  day?: Weekday
  /** 5-field cron "min hour day-of-month month day-of-week" — numeric values with * , - / supported. */
  cron?: string
  /** 'mfl-delta': skip the engine run if MFL transactions haven't changed. 'none': always run.
   *  'command': run `precheckCommand` first (no model loaded); stdout starting with `skip` records a
   *  skipped run and spawns nothing, anything else lets the run proceed. */
  precheck: 'mfl-delta' | 'none' | 'command'
  /** Shell command for precheck 'command', run in the trigger's cwd (then the mission's). 2026-11-06: the
   *  trade passes loaded the 30 GB model 47 times a day to hear their own gate say "skip: no incoming offers". */
  precheckCommand?: string
  /** What to do when the daemon was down at fire time. */
  missedPolicy: 'skip' | 'run-once-on-startup'
  /** Task prompt for the engine run. */
  prompt: string
  /** 'prompt' (default): single governed run of `prompt`. 'trade-scan': multi-pass orchestrator (engine/daemon/tradeScan.ts). */
  taskType?: 'prompt' | 'trade-scan'
  /** Tool pin for this trigger's runs; overrides MissionConfig.allowedTools; default DEFAULT_TOOLS (read-only). */
  allowedTools?: string[]
  /** Loop workspace for this trigger's runs (Bash cwd); overrides MissionConfig.cwd; default: where the daemon runs. */
  cwd?: string
  /** Wall-clock kill for this trigger's runs, in ms; overrides MissionConfig.timeoutMs; default 15 min (60 for trade-scan). */
  timeoutMs?: number
}

export interface MflLeagueRef {
  leagueId: string
  year: number
  /** Your franchise id within the league, e.g. '0005'. */
  franchiseId: string
}

export interface MissionConfig {
  id: string
  goal: string
  leagues?: MflLeagueRef[] // absent for a mission that is not MFL-bound (fantasy-digest); every reader treats it as []
  triggers: TriggerSpec[]
  /** Per action-type trust ladder. mode stays 'ask' in Phase B; 'auto' is Phase C. */
  trustLadder: Record<string, { mode: 'ask' | 'auto'; promoteAt: number }>
  /** On-demand phone command prompt templates, e.g. { lineup: "...for {week}..." }. */
  commands?: Record<string, string>
  /** Tool pin for every trigger's runs unless the trigger sets its own. Adding Bash/Write makes runs non-read-only. */
  allowedTools?: string[]
  /** Loop workspace for every trigger's runs unless the trigger sets its own. */
  cwd?: string
  /** Wall-clock kill for every prompt trigger's runs unless the trigger sets its own (trade-scan keeps 60 min). */
  timeoutMs?: number
}

export interface Recommendation {
  id: string
  /** e.g. 'waiver' | 'trade' | 'lineup' | 'info' — must match a trustLadder key (or 'info'). */
  actionType: string
  summary: string
  detail: string
  deepLink?: string
}

export interface TaskFileInput {
  missionId: string
  triggerId: string
  prompt: string
  /** Mission goal + league refs + recent run summaries, prepended to the prompt. */
  context: string
  /** Tool names the one-shot run may use, e.g. ['Mfl', 'WebSearch', 'WebFetch', 'Read']. */
  allowedTools: string[]
  /** Loop workspace root for the run (runGovernedLoop.cwd). Absent = the engine process's cwd. */
  cwd?: string
  timeoutMs: number
  /** Where the engine writes the TaskOutcome JSON. */
  outcomePath: string
  /** Mirrors TriggerSpec.taskType. Absent = 'prompt'. */
  taskType?: 'prompt' | 'trade-scan'
  /** League refs for orchestrated tasks (trade-scan needs structured ids, not just the context string). */
  leagues?: MflLeagueRef[]
  /** Set by the daemon when it relaunches a paused run: the one-shot reloads this session's journal
   *  and continues from the last tool result instead of starting the prompt over. */
  resumeSessionId?: string
}

export interface TaskOutcome {
  ok: boolean
  summary: string
  recommendations: Recommendation[]
  error?: string
  /** Session id produced by the ConversationLoop that ran this task.
   *  Set by runGovernedLoop; absent when the task short-circuits (timeout, GPU busy). */
  sessionId?: string
  /** Engine self-corrections applied during the run (tool-floor rescues,
   *  enforcement disabled). Empty on a clean run. */
  rescues?: string[]
  /** The daemon killed the run because the control file asked for a pause. Not a failure:
   *  the mission remembers it (MissionState.paused) and relaunches it when the pause lifts. */
  paused?: { sessionId?: string; elapsedMs: number }
}

/** A run the daemon interrupted on request; relaunched by the next tick that is not paused. */
export interface PausedRun {
  triggerId: string
  /** The task file input of the interrupted run (outcomePath is reassigned on relaunch). */
  input: TaskFileInput
  /** Wall clock the run still had when it was paused; the relaunch gets this (with a floor). */
  remainingMs: number
  /** Journal to resume from; absent when the run was killed before it announced one (then it restarts). */
  sessionId?: string
  pausedAt: string
}

export interface RunRecord {
  ts: string
  triggerId: string
  ok: boolean
  summary: string
  recommendationIds: string[]
  /** Entropy digest aggregated from thinking records for this session.
   *  null when no thinking file exists (model has no thinking tokens, or
   *  this is an older record written before Brain T5). */
  entropy?: import('../memory/thinkingRecorder.js').TurnEntropy | null
}

export interface PendingApproval {
  rec: Recommendation
  createdAt: string
}

export interface TrustState {
  mode: 'ask' | 'auto'
  approvedStreak: number
}

export interface MissionState {
  /** Per-league hash of last-seen MFL transactions (delta pre-check). Key = leagueId. */
  lastSeen: Record<string, string>
  /** triggerId → ISO timestamp of next fire. */
  nextFire: Record<string, string>
  /** recId → pending approval. */
  pending: Record<string, PendingApproval>
  /** actionType → trust state. */
  trust: Record<string, TrustState>
  failureStreak: number
  /** A run interrupted by a pause request, waiting to be resumed. */
  paused?: PausedRun
  /** triggerId -> cadence fingerprint last scheduled from schedule.json; a change re-anchors that trigger's nextFire. */
  scheduleSeen?: Record<string, string>
}

export interface ApprovalCommand {
  kind: 'approval'
  recId: string
  verdict: 'approve' | 'reject'
}

/** Free-text phone command (e.g. "lineup 5") published to the command topic. */
export interface TextCommand {
  kind: 'text'
  text: string
}

export type CommandMessage = ApprovalCommand | TextCommand
