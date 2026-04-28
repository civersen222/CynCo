export interface EssentialVariable {
  name: string
  bounds: [number, number]
  metaBounds: [number, number]
  neverBreachedCount: number
}

export type ViabilityCheck = {
  viable: boolean
  breached: string[]
}

const DEFAULT_VARIABLES: EssentialVariable[] = [
  { name: 'tool_error_rate',      bounds: [0.0, 0.4],   metaBounds: [0.0, 1.0],   neverBreachedCount: 0 },
  { name: 'context_utilization',   bounds: [0.0, 0.8],   metaBounds: [0.0, 1.0],   neverBreachedCount: 0 },
  { name: 'stuck_turns',          bounds: [0, 3],        metaBounds: [0, 20],       neverBreachedCount: 0 },
  { name: 'token_efficiency',     bounds: [0.2, 3.0],    metaBounds: [0.0, 10.0],   neverBreachedCount: 0 },
  { name: 'reflection_frequency', bounds: [3, 15],       metaBounds: [1, 50],       neverBreachedCount: 0 },
  { name: 's4_composite',         bounds: [4.0, 10.0],   metaBounds: [0.0, 10.0],   neverBreachedCount: 0 },
]

export class EssentialVariableRegistry {
  private variables: Map<string, EssentialVariable>

  constructor(vars?: EssentialVariable[]) {
    this.variables = new Map()
    for (const v of vars ?? DEFAULT_VARIABLES) {
      this.variables.set(v.name, { ...v, bounds: [...v.bounds] as [number, number], metaBounds: [...v.metaBounds] as [number, number] })
    }
  }

  getAll(): EssentialVariable[] {
    return Array.from(this.variables.values())
  }

  get(name: string): EssentialVariable | undefined {
    return this.variables.get(name)
  }

  checkViability(measurements: Record<string, number>): ViabilityCheck {
    const breached: string[] = []
    for (const [name, v] of this.variables) {
      const val = measurements[name]
      if (val === undefined) continue
      if (val < v.bounds[0] || val > v.bounds[1]) {
        breached.push(name)
      }
    }
    return { viable: breached.length === 0, breached }
  }

  evolveBounds(observations: Record<string, number>[]): void {
    for (const [name, v] of this.variables) {
      const values = observations
        .map(o => o[name])
        .filter((x): x is number => x !== undefined)
        .sort((a, b) => a - b)
      if (values.length < 3) continue
      const p10Idx = Math.floor(values.length * 0.1)
      const p90Idx = Math.min(Math.floor(values.length * 0.9), values.length - 1)
      const p10 = values[p10Idx]
      const p90 = values[p90Idx]
      v.bounds[0] = v.bounds[0] + 0.05 * (p10 - v.bounds[0])
      v.bounds[1] = v.bounds[1] + 0.05 * (p90 - v.bounds[1])
      v.bounds[0] = Math.max(v.metaBounds[0], Math.min(v.metaBounds[1], v.bounds[0]))
      v.bounds[1] = Math.max(v.metaBounds[0], Math.min(v.metaBounds[1], v.bounds[1]))
      if (v.bounds[0] > v.bounds[1]) v.bounds[0] = v.bounds[1]
    }
  }

  addVariable(v: EssentialVariable): void {
    this.variables.set(v.name, { ...v, bounds: [...v.bounds] as [number, number], metaBounds: [...v.metaBounds] as [number, number] })
  }

  removeVariable(name: string): boolean {
    return this.variables.delete(name)
  }

  retireCandidates(): string[] {
    const candidates: string[] = []
    for (const [name, v] of this.variables) {
      if (
        v.neverBreachedCount >= 10 &&
        v.bounds[0] === v.metaBounds[0] &&
        v.bounds[1] === v.metaBounds[1]
      ) {
        candidates.push(name)
      }
    }
    return candidates
  }

  toJSON(): EssentialVariable[] {
    return this.getAll()
  }

  static fromJSON(data: EssentialVariable[]): EssentialVariableRegistry {
    return new EssentialVariableRegistry(data)
  }
}
