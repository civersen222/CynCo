export type TaskComplexity = 'simple' | 'moderate' | 'complex'

export type ModelProfile = {
  name: string
  tier: 'fast' | 'balanced' | 'powerful'
  contextLength: number
  estimatedTps: number
}
