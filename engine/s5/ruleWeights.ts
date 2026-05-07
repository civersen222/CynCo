import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const WEIGHTS_FILE = 's5-weights.json'
const DEFAULT_WEIGHT = 1.0
const MIN_WEIGHT = 0.1
const MAX_WEIGHT = 2.0

const ADJUSTMENTS = {
  positive: 0.1,
  dismissed: -0.1,
  negative: -0.2,
} as const

export type OutcomeType = keyof typeof ADJUSTMENTS

export class RuleWeightManager {
  private weights: Record<string, number> = {}
  private filePath: string

  constructor(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, WEIGHTS_FILE)
    this.load()
  }

  getWeight(ruleId: string): number {
    return this.weights[ruleId] ?? DEFAULT_WEIGHT
  }

  recordOutcome(ruleId: string, outcome: OutcomeType): void {
    const current = this.getWeight(ruleId)
    const adjusted = current + ADJUSTMENTS[outcome]
    this.weights[ruleId] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(adjusted * 100) / 100))
  }

  save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.weights, null, 2))
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.weights = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      }
    } catch {
      this.weights = {}
    }
  }
}
