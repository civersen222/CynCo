/**
 * Workflow system types for LocalCode.
 */

export type GateType =
  | { type: 'tool_output'; tool: string; pattern: string }
  | { type: 'user_confirm' }
  | { type: 'model_done' }
  | { type: 'auto' }

export type Phase = {
  name: string
  instruction: string
  allowedTools?: string[]
  gate: GateType
  transitions: string[]
}

export type WorkflowDefinition = {
  name: string
  displayName: string
  description: string
  initialPhase: string
  phases: Record<string, Phase>
}

export type WorkflowState = {
  workflow: WorkflowDefinition
  currentPhase: string
  phaseHistory: string[]
  startedAt: number
  turnCount: number
  metadata: Record<string, unknown>
}
