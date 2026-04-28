/**
 * Types for the continuous vibe loop.
 */

export type VibeState = 'idle' | 'understand' | 'build' | 'report' | 'next' | 'escalation'
export type VibeMode = 'new' | 'continue' | 'fix' | 'explain'
export type DifficultyLevel = 'trivial' | 'simple' | 'medium' | 'complex' | 'massive'
export type ConfidenceDimension = 'purpose' | 'mechanics' | 'integration' | 'ambiguity'

export type ConfidenceState = {
  [K in ConfidenceDimension]: number
}

export const CONFIDENCE_THRESHOLDS: Record<DifficultyLevel, number> = {
  trivial: 90,
  simple: 75,
  medium: 65,
  complex: 55,
  massive: 50,
}

export type VibeEvent =
  | { type: 'vibe.state_changed'; fromState: VibeState; to: VibeState }
  | { type: 'vibe.confidence_update'; confidence: ConfidenceState; overall: number; reason: string }
  | { type: 'vibe.task_complete'; title: string; analogy: string; filesChanged: string[]; suggestion: string; previewPath?: string }
  | { type: 'vibe.escalation'; problem: string; tried: string[]; proposal: string; requestId: string }
  | { type: 'vibe.project_scanned'; summary: string; fileCount: number; languages: string[] }
  | { type: 'vibe.question'; questionId: string; text: string; options?: string[] }

export type VibeCommand =
  | { type: 'vibe.start'; mode: VibeMode; description?: string }
  | { type: 'vibe.answer'; questionId: string; answer: string }
  | { type: 'vibe.action'; action: 'accept_suggestion' | 'something_else' | 'fix' | 'done' | 'skip' | 'just_build'; text?: string }
  | { type: 'vibe.escalation_response'; requestId: string; action: 'fix' | 'skip' | 'explain' }
