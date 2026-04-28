/**
 * VibeLoopEngine — state machine driving the continuous vibe loop.
 */

import type { ConfidenceDimension, DifficultyLevel, VibeEvent, VibeMode, VibeState } from './types.js'
import { classifyDifficulty, ConfidenceScorer } from './confidence.js'

export class VibeLoopEngine {
  state: VibeState = 'idle'
  difficulty: DifficultyLevel | null = null
  confidence: ConfidenceScorer | null = null

  private emit: (event: VibeEvent) => void

  constructor(emit: (event: VibeEvent) => void) {
    this.emit = emit
  }

  start(mode: VibeMode, description?: string): void {
    const desc = description ?? mode
    this.difficulty = classifyDifficulty(desc)
    this.confidence = new ConfidenceScorer(this.difficulty)
    this.transition('understand')
  }

  updateConfidence(dimension: ConfidenceDimension, value: number, reason: string): void {
    if (!this.confidence) return
    this.confidence.update(dimension, value, reason)
    this.emit({
      type: 'vibe.confidence_update',
      confidence: this.confidence.getState(),
      overall: this.confidence.overall(),
      reason,
    })
  }

  /** Accumulate confidence from an answer — fixed increment, no LLM number dependency. */
  incrementConfidence(dimension: ConfidenceDimension, reason: string): void {
    if (!this.confidence) return
    this.confidence.increment(dimension, reason)
    this.emit({
      type: 'vibe.confidence_update',
      confidence: this.confidence.getState(),
      overall: this.confidence.overall(),
      reason,
    })
  }

  transitionToBuild(): void {
    this.transition('build')
  }

  completeTask(
    title: string,
    analogy: string,
    filesChanged: string[],
    suggestion: string,
    previewPath?: string,
  ): void {
    this.transition('report')
    this.emit({
      type: 'vibe.task_complete',
      title,
      analogy,
      filesChanged,
      suggestion,
      previewPath,
    })
  }

  escalate(problem: string, tried: string[], proposal: string): void {
    this.transition('escalation')
    const requestId = `esc-${Date.now()}`
    this.emit({
      type: 'vibe.escalation',
      problem,
      tried,
      proposal,
      requestId,
    })
  }

  handleAction(action: 'accept_suggestion' | 'something_else' | 'fix' | 'done' | 'skip' | 'just_build'): void {
    switch (action) {
      case 'accept_suggestion':
      case 'something_else':
      case 'fix':
      case 'skip':
        this.transition('understand')
        break
      case 'done':
        this.transition('idle')
        break
      case 'just_build':
        this.transition('build')
        break
    }
  }

  handleEscalationResponse(action: 'fix' | 'skip' | 'explain'): void {
    switch (action) {
      case 'skip':
        this.transition('understand')
        break
      case 'fix':
      case 'explain':
        this.transition('build')
        break
    }
  }

  private transition(to: VibeState): void {
    const fromState = this.state
    this.state = to
    this.emit({ type: 'vibe.state_changed', fromState, to })
  }
}
