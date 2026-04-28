export type HandoffStatus = 'in_progress' | 'complete' | 'blocked' | 'abandoned'

export type Handoff = {
  goal: string
  now: string
  status: HandoffStatus
  model?: string
  context_at_exit?: number
  what_was_done?: string[]
  what_failed?: string[]
  next_steps?: string[]
  files_modified?: string[]
  learnings?: string[]
}

export type LedgerEntry = {
  date: string
  focus: string
  handoff?: string
}

export type Ledger = {
  project: string
  current_focus: string
  active_streams: string[]
  architecture_decisions: { decision: string; date: string; rationale: string }[]
  open_threads: { priority: 'high' | 'medium' | 'low'; description: string }[]
  session_history: LedgerEntry[]
}

export type LearningType =
  | 'WORKING_SOLUTION'
  | 'FAILED_APPROACH'
  | 'ARCHITECTURAL_DECISION'
  | 'CODEBASE_PATTERN'
  | 'ERROR_FIX'
  | 'USER_PREFERENCE'
  | 'OPEN_THREAD'

export type Learning = {
  session_id: string
  type: LearningType
  content: string
  context?: string
  tags?: string[]
  confidence?: 'high' | 'medium' | 'low'
}
