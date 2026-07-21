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
  /** 'mfl-delta': skip the engine run if MFL transactions haven't changed. 'none': always run. */
  precheck: 'mfl-delta' | 'none'
  /** What to do when the daemon was down at fire time. */
  missedPolicy: 'skip' | 'run-once-on-startup'
  /** Task prompt for the engine run. */
  prompt: string
  /** 'prompt' (default): single governed run of `prompt`. 'trade-scan': multi-pass orchestrator (engine/daemon/tradeScan.ts). */
  taskType?: 'prompt' | 'trade-scan'
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
  leagues: MflLeagueRef[]
  triggers: TriggerSpec[]
  /** Per action-type trust ladder. mode stays 'ask' in Phase B; 'auto' is Phase C. */
  trustLadder: Record<string, { mode: 'ask' | 'auto'; promoteAt: number }>
  /** On-demand phone command prompt templates, e.g. { lineup: "...for {week}..." }. */
  commands?: Record<string, string>
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
  timeoutMs: number
  /** Where the engine writes the TaskOutcome JSON. */
  outcomePath: string
  /** Mirrors TriggerSpec.taskType. Absent = 'prompt'. */
  taskType?: 'prompt' | 'trade-scan'
  /** League refs for orchestrated tasks (trade-scan needs structured ids, not just the context string). */
  leagues?: MflLeagueRef[]
}

export interface TaskOutcome {
  ok: boolean
  summary: string
  recommendations: Recommendation[]
  error?: string
  /** Session id produced by the ConversationLoop that ran this task.
   *  Set by runGovernedLoop; absent when the task short-circuits (timeout, GPU busy). */
  sessionId?: string
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
