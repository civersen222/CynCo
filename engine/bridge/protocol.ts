/**
 * WebSocket protocol types shared between TS engine and Python TUI.
 * All messages are JSON-serialized with a `type` discriminator.
 */

// ─── Engine → TUI Events ──────────────────────────────────────

export type LSPServerInfo = {
  language: string
  available: boolean
}

export type MCPServerInfo = {
  name: string
  status: 'connected' | 'failed' | 'disabled' | 'pending'
}

export type SessionReadyEvent = {
  type: 'session.ready'
  model: string
  contextLength: number
  projectPath?: string
  version?: string
  sessionStartTime?: string
  lspServers?: LSPServerInfo[]
  mcpServers?: MCPServerInfo[]
  expertise?: 'beginner' | 'intermediate' | 'advanced'
}

export type SessionErrorEvent = {
  type: 'session.error'
  error: string
}

export type StreamTokenEvent = {
  type: 'stream.token'
  text: string
  messageId?: string
}

export type MessageCompleteEvent = {
  type: 'message.complete'
  messageId: string
  stopReason: string | null
  usage?: { inputTokens: number; outputTokens: number }
}

export type ToolStartEvent = {
  type: 'tool.start'
  toolId: string
  toolName: string
  input: Record<string, unknown>
}

export type ToolProgressEvent = {
  type: 'tool.progress'
  toolId: string
  output: string
}

export type ToolCompleteEvent = {
  type: 'tool.complete'
  toolId: string
  toolName: string
  result: unknown
  isError?: boolean
}

export type FileChangeEvent = {
  type: 'file.change'
  path: string
  changeType: 'create' | 'modify' | 'delete'
  diff?: string
}

export type ApprovalRequestEvent = {
  type: 'approval.request'
  requestId: string
  toolName: string
  description: string
  risk: 'low' | 'medium' | 'high'
}

export type ContextStatusEvent = {
  type: 'context.status'
  utilization: number
  estimatedTokens: number
  contextLength: number
  action: 'proceed' | 'externalize' | 'compact'
}

export type ContextWarningEvent = {
  type: 'context.warning'
  utilization: number
  message: string
}

export type PriorSessionContext = {
  priorGoal: string
  priorStatus: string
  priorDate: string
  openThreads: { priority: string; description: string }[]
}

export type MemoryRecalledEvent = {
  type: 'memory.recalled'
  memories: { type: string; content: string; confidence?: string }[]
  sessionContext?: PriorSessionContext
}

export type MemoryWrittenEvent = {
  type: 'memory.written'
  kind: 'handoff' | 'ledger_update'
  summary: string
}

export type WorkflowStatusEvent = {
  type: 'workflow.status'
  active: boolean
  workflow: string | null
  phase: string | null
  displayName: string | null
}

export type GovernanceStatusEvent = {
  type: 'governance.status'
  health: string
  s3s4Balance: string
  toolSuccessRate: number
  stuckTurns: number
  suggestion: string | null
}

export type SummaryInjectedEvent = {
  type: 'summary.injected'
  toolsUsed: string[]
}

// ─── Vibe Loop Events ─────────────────────────────────────────

export type VibeStateChangedEvent = {
  type: 'vibe.state_changed'
  fromState: string
  to: string
}

export type VibeConfidenceUpdateEvent = {
  type: 'vibe.confidence_update'
  confidence: Record<string, number>
  overall: number
  reason: string
}

export type VibeTaskCompleteEvent = {
  type: 'vibe.task_complete'
  title: string
  analogy: string
  filesChanged: string[]
  suggestion: string
  previewPath?: string
}

export type VibeEscalationEvent = {
  type: 'vibe.escalation'
  problem: string
  tried: string[]
  proposal: string
  requestId: string
}

export type VibeProjectScannedEvent = {
  type: 'vibe.project_scanned'
  summary: string
  fileCount: number
  languages: string[]
}

export type VibeQuestionEvent = {
  type: 'vibe.question'
  questionId: string
  text: string
  options?: string[]
}

// ─── Sub-Agent Events ────────────────────────────────────────────

export type SubAgentSpawnedEvent = {
  type: 'subagent.spawned'
  agentId: string
  persona: string
  task: string
}

export type SubAgentToolEvent = {
  type: 'subagent.tool'
  agentId: string
  toolName: string
  status: 'success' | 'error'
  preview: string
}

export type SubAgentCompleteEvent = {
  type: 'subagent.complete'
  agentId: string
  success: boolean
  output: string
  turns: number
  tokensUsed: number
}

export type SubAgentKilledEvent = {
  type: 'subagent.killed'
  agentId: string
  persona: string
  task: string
  reason: string
}

export type S2CoordinationEvent = {
  type: 's2.decision'
  decision: 'run' | 'queue' | 'wait' | 'absorb' | 'escalate' | 'kill'
  agentId: string
  reason: string
  gpuUtil: number
  queueDepth: number
}

// ─── Config/Profile Response Events ───────────────────────────────

export type ConfigCurrentEvent = {
  type: 'config.current'
  config: {
    model: string | undefined
    temperature: number
    maxOutputTokens: number
    timeout: number
    baseUrl: string
    contextLength: number | undefined
    tier: string
    tools?: { allowed?: string[]; denied?: string[] }
  }
}

export type ConfigUpdatedEvent = {
  type: 'config.updated'
  applied: Record<string, unknown>
  errors?: { field: string; message: string }[]
}

export type ProfileListEvent = {
  type: 'profile.list'
  profiles: { name: string; scope: 'user' | 'project'; active: boolean }[]
  parseErrors: { file: string; error: string }[]
}

export type ProfileValidationEvent = {
  type: 'profile.validation'
  ok: boolean
  errors: string[]
}

export type ProfileWrittenEvent = {
  type: 'profile.written'
  name: string
  path: string
}

export type EngineEvent =
  | SessionReadyEvent
  | SessionErrorEvent
  | StreamTokenEvent
  | MessageCompleteEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolCompleteEvent
  | FileChangeEvent
  | ApprovalRequestEvent
  | ContextStatusEvent
  | ContextWarningEvent
  | MemoryRecalledEvent
  | MemoryWrittenEvent
  | WorkflowStatusEvent
  | GovernanceStatusEvent
  | SummaryInjectedEvent
  | SubAgentSpawnedEvent
  | SubAgentToolEvent
  | SubAgentCompleteEvent
  | SubAgentKilledEvent
  | S2CoordinationEvent
  | VibeStateChangedEvent
  | VibeConfidenceUpdateEvent
  | VibeTaskCompleteEvent
  | VibeEscalationEvent
  | VibeProjectScannedEvent
  | VibeQuestionEvent
  | ConfigCurrentEvent
  | ConfigUpdatedEvent
  | ProfileListEvent
  | ProfileValidationEvent
  | ProfileWrittenEvent
  | ToolsListEvent
  | WizardResponseEvent
  | WebSearchResultEvent

// ─── TUI → Engine Commands ─────────────────────────────────────

export type UserMessageCommand = {
  type: 'user.message'
  text: string
}

export type ApprovalResponseCommand = {
  type: 'approval.response'
  requestId: string
  approved: boolean
}

export type SlashCommand = {
  type: 'command'
  command: string
  args?: string
}

export type AbortCommand = {
  type: 'abort'
}

export type FileOpenCommand = {
  type: 'file.open'
  path: string
}

export type ConfigUpdateCommand = {
  type: 'config.update'
  patches: Record<string, unknown>
}

export type ConfigGetCommand = {
  type: 'config.get'
}

export type ProfileListCommand = {
  type: 'profile.list'
}

export type ProfileActivateCommand = {
  type: 'profile.activate'
  name: string
}

export type ProfileWriteCommand = {
  type: 'profile.write'
  name: string
  yaml: string
}

export type ProfileValidateCommand = {
  type: 'profile.validate'
  yaml: string
}

export type ToolsListCommand = {
  type: 'tools.list'
}

export type WizardQueryCommand = {
  type: 'wizard.query'
  requestId: string
  prompt: string
  systemPrompt?: string
}

export type WebSearchCommand = {
  type: 'web.search'
  requestId: string
  queries: string[]
}

// ─── Vibe Loop Commands ───────────────────────────────────────

export type VibeStartCommand = {
  type: 'vibe.start'
  mode: 'new' | 'continue' | 'fix' | 'explain'
  description?: string
}

export type VibeAnswerCommand = {
  type: 'vibe.answer'
  questionId: string
  answer: string
}

export type VibeActionCommand = {
  type: 'vibe.action'
  action: 'accept_suggestion' | 'something_else' | 'fix' | 'done' | 'skip' | 'just_build'
  text?: string
}

export type VibeEscalationResponseCommand = {
  type: 'vibe.escalation_response'
  requestId: string
  action: 'fix' | 'skip' | 'explain'
}

export type WebSearchResultEvent = {
  type: 'web.search.result'
  requestId: string
  results: string
}

export type WizardResponseEvent = {
  type: 'wizard.response'
  requestId: string
  text: string
  error?: string
}

export type ToolsListEvent = {
  type: 'tools.list'
  tools: { name: string; description: string; tier: string; enabled: boolean }[]
}

export type TUICommand =
  | UserMessageCommand
  | ApprovalResponseCommand
  | SlashCommand
  | AbortCommand
  | FileOpenCommand
  | ConfigUpdateCommand
  | ConfigGetCommand
  | ProfileListCommand
  | ProfileActivateCommand
  | ProfileWriteCommand
  | ProfileValidateCommand
  | ToolsListCommand
  | WizardQueryCommand
  | WebSearchCommand
  | VibeStartCommand
  | VibeAnswerCommand
  | VibeActionCommand
  | VibeEscalationResponseCommand

// ─── Helpers ────────────────────────────────────────────────────

export function serializeEvent(event: EngineEvent): string {
  return JSON.stringify(event)
}

export function parseCommand(json: string): TUICommand | null {
  try {
    const obj = JSON.parse(json)
    if (obj && typeof obj === 'object' && 'type' in obj) {
      return obj as TUICommand
    }
    return null
  } catch {
    return null
  }
}
