import type { WorkflowDefinition, WorkflowState, Phase, GateType } from './types.js'

export type WorkflowEvent =
  | { type: 'workflow.started'; workflow: string; phase: string }
  | { type: 'workflow.phase_changed'; workflow: string; fromPhase: string; toPhase: string }
  | { type: 'workflow.completed'; workflow: string }
  | { type: 'workflow.cancelled'; workflow: string }

export class WorkflowEngine {
  private _state: WorkflowState | null = null
  private _onEvent?: (event: WorkflowEvent) => void

  constructor(onEvent?: (event: WorkflowEvent) => void) {
    this._onEvent = onEvent
  }

  get isActive(): boolean { return this._state !== null }
  get state(): WorkflowState | null { return this._state }

  get currentPhase(): Phase | null {
    if (!this._state) return null
    return this._state.workflow.phases[this._state.currentPhase] ?? null
  }

  start(workflow: WorkflowDefinition, metadata: Record<string, unknown> = {}): void {
    if (this._state) this.cancel()
    this._state = {
      workflow, currentPhase: workflow.initialPhase,
      phaseHistory: [workflow.initialPhase], startedAt: Date.now(), turnCount: 0, metadata,
    }
    this._onEvent?.({ type: 'workflow.started', workflow: workflow.name, phase: workflow.initialPhase })
  }

  getSystemPromptOverride(): string | null {
    const phase = this.currentPhase
    if (!phase) return null
    const wf = this._state!.workflow
    return `[Workflow: ${wf.displayName}]\n[Phase: ${phase.name}]\n\n${phase.instruction}`
  }

  getAllowedTools(): string[] | null {
    return this.currentPhase?.allowedTools ?? null
  }

  advance(targetPhase: string): void {
    if (!this._state) throw new Error('No active workflow')
    const phase = this.currentPhase!
    const fromPhase = this._state.currentPhase

    if (targetPhase === 'done') {
      this._onEvent?.({ type: 'workflow.completed', workflow: this._state.workflow.name })
      this._state = null
      return
    }

    if (!phase.transitions.includes(targetPhase)) {
      throw new Error(`Invalid transition: ${fromPhase} → ${targetPhase}. Valid: ${phase.transitions.join(', ')}`)
    }
    if (!this._state.workflow.phases[targetPhase]) {
      throw new Error(`Unknown phase: ${targetPhase}`)
    }

    this._state.currentPhase = targetPhase
    this._state.phaseHistory.push(targetPhase)
    this._onEvent?.({ type: 'workflow.phase_changed', workflow: this._state.workflow.name, fromPhase, toPhase: targetPhase })
  }

  checkGate(stopReason: string, toolResult: { tool: string; output: string } | null): boolean {
    const gate = this.currentPhase?.gate
    if (!gate) return false
    switch (gate.type) {
      case 'model_done': return stopReason === 'end_turn'
      case 'auto': return true
      case 'user_confirm': return false
      case 'tool_output':
        if (!toolResult) return false
        if (toolResult.tool !== gate.tool) return false
        return new RegExp(gate.pattern).test(toolResult.output)
    }
  }

  incrementTurn(): void { if (this._state) this._state.turnCount++ }

  cancel(): void {
    if (this._state) {
      this._onEvent?.({ type: 'workflow.cancelled', workflow: this._state.workflow.name })
      this._state = null
    }
  }

  getSummary(): string | null {
    if (!this._state) return null
    return `${this._state.workflow.displayName} — ${this.currentPhase?.name ?? 'unknown'} (turn ${this._state.turnCount})`
  }
}
