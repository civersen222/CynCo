/**
 * CynCo Audit Logger — append-only, fsync'd JSONL streams for the
 * Beer viability audit. Never truncates, never rotates, never loses entries.
 */

import { appendFileSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

const STREAMS = [
  'events',
  'parameters',
  'strategies',
  'algedonic',
  's5-decisions',
  'session-outcomes',
] as const

type StreamName = typeof STREAMS[number]

export type AuditEntry = {
  ts: string
  session_id: string
  project_id: string
  type: string
  [key: string]: unknown
}

class AuditLoggerImpl {
  private dir: string | null = null
  private sessionId: string = ''
  private projectId: string = ''
  private initialized = false

  // Per-session counters for session-outcomes
  private sessionStartTs: string = ''
  private toolCallsByTool: Record<string, number> = {}
  private governanceEventCount = 0
  private algedonicSignalCount = 0
  private s5DecisionCount = 0
  private strategyChangeCount = 0
  private contextMaxUtilization = 0
  private model = ''
  private taskSummary: string | null = null
  private taskSuccess: boolean | null = null

  init(sessionId: string, projectCwd: string, model?: string): void {
    this.dir = join(homedir(), '.cynco', 'audit-log')
    mkdirSync(this.dir, { recursive: true })
    this.sessionId = sessionId
    this.projectId = createHash('sha256').update(projectCwd).digest('hex').slice(0, 12)
    this.sessionStartTs = new Date().toISOString()
    this.model = model ?? 'unknown'
    this.toolCallsByTool = {}
    this.governanceEventCount = 0
    this.algedonicSignalCount = 0
    this.s5DecisionCount = 0
    this.strategyChangeCount = 0
    this.contextMaxUtilization = 0
    this.taskSummary = null
    this.taskSuccess = null
    this.initialized = true

    // Create variety-overflow.jsonl with header if missing
    const voPath = join(this.dir, 'variety-overflow.jsonl')
    if (!existsSync(voPath)) {
      writeFileSync(voPath,
        '// CynCo audit-log: variety overflow.\n' +
        '// Append a JSONL entry by hand whenever you reach for a different\n' +
        '// tool because CynCo couldn\'t handle a task. Schema:\n' +
        '// {"ts":"...","project_id":"...","task":"<what you tried>",\n' +
        '//  "why_cynco_failed":"<your judgment>","tool_used_instead":"...",\n' +
        '//  "notes":"..."}\n'
      )
    }

    console.log(`[audit] Initialized: ${this.dir} (session=${sessionId.slice(0, 8)}, project=${this.projectId})`)
  }

  /** Append an entry to a named stream. fsync after every write. */
  log(stream: StreamName, entry: Omit<AuditEntry, 'ts' | 'session_id' | 'project_id'>): void {
    if (!this.initialized || !this.dir) return

    const full: AuditEntry = {
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      project_id: this.projectId,
      ...entry,
    }

    const line = JSON.stringify(full) + '\n'
    const filePath = join(this.dir, `${stream}.jsonl`)

    try {
      const fd = openSync(filePath, 'a')
      appendFileSync(fd, line)
      fsyncSync(fd)
      closeSync(fd)
    } catch (e) {
      console.error(`[audit] Write failed (${stream}): ${e}`)
    }

    // Update per-session counters
    if (stream === 'events') this.governanceEventCount++
    if (stream === 'algedonic') this.algedonicSignalCount++
    if (stream === 's5-decisions') this.s5DecisionCount++
    if (stream === 'strategies' && (entry.type === 'strategy.adopt' || entry.type === 'strategy.deprecate')) {
      this.strategyChangeCount++
    }
  }

  /** Track a tool call for session-outcomes. */
  trackToolCall(toolName: string): void {
    this.toolCallsByTool[toolName] = (this.toolCallsByTool[toolName] ?? 0) + 1
  }

  /** Track context utilization high-water mark. */
  trackContextUtilization(utilization: number): void {
    if (utilization > this.contextMaxUtilization) {
      this.contextMaxUtilization = utilization
    }
  }

  /** Buffer task summary from /audit-summary command. */
  setTaskSummary(summary: string): void {
    this.taskSummary = summary
  }

  /** Buffer task result from /audit-result command. */
  setTaskSuccess(success: boolean): void {
    this.taskSuccess = success
  }

  /** Write session-outcomes row. Called on session end or crash. */
  writeSessionOutcome(crashReason?: string): void {
    if (!this.initialized) return

    const totalToolCalls = Object.values(this.toolCallsByTool).reduce((a, b) => a + b, 0)

    this.log('session-outcomes', {
      type: 'session.outcome',
      start_ts: this.sessionStartTs,
      end_ts: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - new Date(this.sessionStartTs).getTime()) / 1000),
      task_summary: this.taskSummary,
      success: this.taskSuccess,
      tool_calls: totalToolCalls,
      tool_calls_by_tool: this.toolCallsByTool,
      governance_event_count: this.governanceEventCount,
      algedonic_signal_count: this.algedonicSignalCount,
      s5_decision_count: this.s5DecisionCount,
      strategy_changes: this.strategyChangeCount,
      context_max_utilization: Math.round(this.contextMaxUtilization * 100) / 100,
      model: this.model,
      ...(crashReason ? { crash_reason: crashReason } : {}),
    })

    console.log(`[audit] Session outcome written (tools=${totalToolCalls}, gov=${this.governanceEventCount}, alg=${this.algedonicSignalCount})`)
  }

  /** Write metadata.json for audit start. Returns false if already exists. */
  writeMetadata(model: string, hardwareNotes: string): boolean {
    if (!this.dir) return false
    const metaPath = join(this.dir, 'metadata.json')
    if (existsSync(metaPath)) return false

    const { execSync } = require('child_process')
    let gitCommit = 'unknown'
    try { gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim() } catch {}

    const meta = {
      audit_start_ts: new Date().toISOString(),
      audit_planned_end_ts: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
      model,
      hardware_notes: hardwareNotes,
      git_commit: gitCommit,
      cynco_version: '0.1.0',
      wired_levels: ['L1_rule_based_S5', 'L3_model_S5_optional', 'L4_param_infra'],
      projects: [],
    }

    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    console.log(`[audit] Audit started — metadata written to ${metaPath}`)
    return true
  }

  /** Read metadata.json for /audit-status. */
  getMetadata(): Record<string, unknown> | null {
    if (!this.dir) return null
    const metaPath = join(this.dir, 'metadata.json')
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch { return null }
  }

  get isInitialized(): boolean { return this.initialized }
  get auditDir(): string | null { return this.dir }
}

/** Singleton audit logger instance. */
export const AuditLogger = new AuditLoggerImpl()
