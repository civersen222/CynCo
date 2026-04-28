/**
 * Strategy Memory — structured relational memory of what worked and why.
 *
 * Uses Pask's EntailmentMesh and Ashby's StructuralCoupling to track
 * strategy→outcome relationships across sessions. This gives the S4
 * reflector's self-rewrite historical context instead of just one session's data.
 *
 * Concept inspired by knowledge graph approaches (Graphify et al) but
 * implemented with zero LLM overhead using existing cybernetics primitives.
 *
 * Persists to disk in the population directory.
 */

import { conversation, autopoiesis } from '../cybernetics-core/src/index.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface StrategyOutcome {
  strategy: string      // the strategy text (or first 80 chars as key)
  configIndex: number
  outcome: 'viable' | 'marginal' | 'non-viable'
  viabilityRatio: number
  perturbations: number
  toolsUsed: string[]
  timestamp: number
}

export class StrategyMemory {
  /** Entailment mesh: strategy topics → outcome topics */
  readonly mesh: InstanceType<typeof conversation.EntailmentMesh>
  /** Structural coupling: correlations between strategy types and outcomes */
  readonly coupling: InstanceType<typeof autopoiesis.StructuralCoupling>
  /** Raw history for persistence */
  private history: StrategyOutcome[] = []

  constructor() {
    this.mesh = new conversation.EntailmentMesh()
    this.coupling = new autopoiesis.StructuralCoupling()

    // Seed strategy topics
    for (const s of ['persistence', 'diversity', 'recovery', 'conciseness', 'balanced']) {
      this.mesh.addTopic(s, `Strategy emphasizing ${s}`)
    }
    for (const o of ['viable', 'marginal', 'non-viable']) {
      this.mesh.addTopic(o, `Session outcome: ${o}`)
    }
  }

  /**
   * Record a session outcome. Builds entailment graph and coupling data.
   */
  recordOutcome(outcome: StrategyOutcome): void {
    this.history.push(outcome)

    // Classify strategy into archetype(s) for graph edges
    const types = this.classifyStrategy(outcome.strategy)
    const outcomeTopic = outcome.outcome

    // Add entailments: each strategy type → outcome
    for (const t of types) {
      this.mesh.addEntailment(t, outcomeTopic)
    }

    // Track structural coupling: strategy viability score ↔ outcome numeric
    const outcomeScore = outcome.outcome === 'viable' ? 1.0 : outcome.outcome === 'marginal' ? 0.5 : 0.0
    for (const t of types) {
      this.coupling.recordInteraction(t, 'outcome', outcomeScore, outcome.viabilityRatio)
    }
  }

  /**
   * Classify a strategy text into archetype labels based on keyword matching.
   */
  private classifyStrategy(strategy: string): string[] {
    const s = strategy.toLowerCase()
    const types: string[] = []
    if (/persist|keep.*iterating|don't stop|do not stop|until.*pass/i.test(s)) types.push('persistence')
    if (/divers|varied|different tool|glob.*read.*grep/i.test(s)) types.push('diversity')
    if (/recover|different approach|step back|fail.*twice|stuck.*try/i.test(s)) types.push('recovery')
    if (/concis|direct|efficient|three steps|do not explore/i.test(s)) types.push('conciseness')
    if (types.length === 0) types.push('balanced')
    return types
  }

  /**
   * Get a summary of strategy→outcome history for the S4 reflector.
   * Returns human-readable text that can be injected into the self-rewrite prompt.
   */
  getSummaryForReflection(): string {
    if (this.history.length === 0) return ''

    // Count outcomes per strategy type
    const stats: Record<string, { viable: number; marginal: number; nonViable: number; total: number }> = {}
    for (const h of this.history) {
      for (const t of this.classifyStrategy(h.strategy)) {
        if (!stats[t]) stats[t] = { viable: 0, marginal: 0, nonViable: 0, total: 0 }
        stats[t].total++
        if (h.outcome === 'viable') stats[t].viable++
        else if (h.outcome === 'marginal') stats[t].marginal++
        else stats[t].nonViable++
      }
    }

    const lines: string[] = ['Strategy history across sessions:']
    for (const [type, s] of Object.entries(stats)) {
      const viableRate = ((s.viable + s.marginal * 0.5) / s.total * 100).toFixed(0)
      lines.push(`- ${type}: ${viableRate}% viable (${s.viable}v/${s.marginal}m/${s.nonViable}nv out of ${s.total})`)
    }

    // Add coupling correlations
    const couplings = this.coupling.stronglyCoupled(0.3)
    if (couplings.length > 0) {
      lines.push('Strong correlations:')
      for (const c of couplings.slice(0, 5)) {
        lines.push(`- ${c.systemA} ↔ outcome: r=${c.coDriftCorrelation.toFixed(2)} (${c.interactionCount} sessions)`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Save to disk.
   */
  save(dir: string): void {
    const path = join(dir, 'strategy_memory.json')
    writeFileSync(path, JSON.stringify(this.history, null, 2))
  }

  /**
   * Load from disk.
   */
  static load(dir: string): StrategyMemory {
    const mem = new StrategyMemory()
    const path = join(dir, 'strategy_memory.json')
    if (existsSync(path)) {
      try {
        const data: StrategyOutcome[] = JSON.parse(readFileSync(path, 'utf-8'))
        for (const d of data) {
          mem.recordOutcome(d)
        }
      } catch {}
    }
    return mem
  }
}
