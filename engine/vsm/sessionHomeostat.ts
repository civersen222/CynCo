import { EssentialVariableRegistry } from './essentialVariables.js'
import { importParams, exportParams, GOVERNANCE_PARAMS } from './governanceParams.js'

export type UpdateResult = {
  viable: boolean
  breached: string[]
  perturbed: boolean
  magnitude: number
  maxReached: boolean
}

export type SessionOutcome = 'viable' | 'marginal' | 'non-viable'

export class SessionHomeostat {
  private registry: EssentialVariableRegistry
  private maxPerturbations: number
  private perturbationCount = 0
  private viableCount = 0
  private totalCount = 0
  private allMeasurements: Record<string, number>[] = []

  constructor(registry: EssentialVariableRegistry, maxPerturbations: number = 3) {
    this.registry = registry
    this.maxPerturbations = maxPerturbations
  }

  update(measurements: Record<string, number>): UpdateResult {
    this.totalCount++
    this.allMeasurements.push({ ...measurements })
    const { viable, breached } = this.registry.checkViability(measurements)
    if (viable) {
      this.viableCount++
      return { viable: true, breached: [], perturbed: false, magnitude: 0, maxReached: false }
    }
    if (this.perturbationCount >= this.maxPerturbations) {
      return { viable: false, breached, perturbed: false, magnitude: 0, maxReached: true }
    }
    let magnitude: number
    if (breached.length >= 3) magnitude = 1.0
    else if (breached.length === 2) magnitude = 0.3
    else magnitude = 0.1
    this.perturbParameters(magnitude)
    this.perturbationCount++
    return { viable: false, breached, perturbed: true, magnitude, maxReached: false }
  }

  private perturbParameters(magnitude: number): void {
    const current = exportParams()
    const perturbed: Record<string, number> = {}
    for (const [key, val] of Object.entries(current)) {
      const param = GOVERNANCE_PARAMS.get(key)
      if (!param) continue
      const range = param.max - param.min
      const delta = (Math.random() * 2 - 1) * range * magnitude
      perturbed[key] = Math.max(param.min, Math.min(param.max, val + delta))
    }
    importParams(perturbed, `session-perturbation-${this.perturbationCount + 1}-mag${magnitude.toFixed(1)}`)
  }

  getPerturbationCount(): number { return this.perturbationCount }
  getViabilityRatio(): number { return this.totalCount > 0 ? this.viableCount / this.totalCount : 1.0 }
  getMeasurements(): Record<string, number>[] { return this.allMeasurements }

  getSessionOutcome(): SessionOutcome {
    const ratio = this.getViabilityRatio()
    if (ratio >= 0.8) return 'viable'
    if (this.perturbationCount > 0 && ratio >= 0.5) return 'marginal'
    return 'non-viable'
  }
}
