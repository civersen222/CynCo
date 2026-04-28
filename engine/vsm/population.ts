import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { GOVERNANCE_PARAMS } from './governanceParams.js'

export interface PopulationConfig {
  index: number
  params: Record<string, number>
  strategy: string  // behavioral instruction injected into system prompt
  viable: boolean
  viabilityCount: number
  generation: number
  lastUsed: number
}

// Strategies derived from control vector training pairs (Level 2).
// Each encodes a behavioral direction the model should follow.
// The population evolves which combination of strategies works.
const SEED_STRATEGIES = [
  // config_00: balanced baseline
  'Work methodically: read relevant files, make targeted edits, run tests to verify. Be concise and efficient.',
  // config_01: persistence-heavy (from persistence control vector positive examples)
  'Do NOT stop until all tests pass. If 7 of 8 tests pass, find and fix the remaining failure before declaring done. Partial completion is not completion.',
  // config_02: diversity-heavy (from diversity control vector positive examples)
  'Use varied tools appropriately: Glob to find files, Read to understand code, Grep for patterns, Edit to change code, Bash to run tests. Never use the same tool 4 times in a row without trying a different approach.',
  // config_03: recovery-heavy (from recovery control vector positive examples)
  'If an approach fails twice, stop and try something completely different. Do not retry the same edit with small variations. Step back, reread the code, and reconsider your strategy from scratch.',
  // config_04: conciseness-heavy (from conciseness control vector positive examples)
  'Be direct. Read the file, make the change, verify with tests. Do not explore the entire codebase before starting. Do not write lengthy plans. Three steps maximum.',
  // config_05: persistence + diversity
  'Keep iterating until all tests pass. Use diverse tools — Glob, Read, Grep, Edit, Bash — in varied sequences. Never give up and never get stuck in a tool rut.',
  // config_06: recovery + conciseness
  'If stuck, immediately try a different approach — do not debug the same line repeatedly. Be fast and direct when you do find the right path.',
  // config_07: persistence + conciseness
  'Be efficient but thorough. Make targeted changes and verify. If tests fail, fix them immediately — do not move on. But do not over-explore.',
  // config_08: diversity + recovery
  'Explore the codebase structure before editing. If your first approach fails, use different tools to gather more context before trying again.',
  // config_09: all four balanced
  'Work efficiently but persistently. Use varied tools, change approach when stuck, and do not stop until the task is complete. Read, edit, test, iterate.',
]

export class ConfigPopulation {
  private configs: PopulationConfig[]
  private dir: string

  private constructor(dir: string, configs: PopulationConfig[]) {
    this.dir = dir
    this.configs = configs
  }

  static initialize(dir: string, baseline: Record<string, number>, n: number = 10): ConfigPopulation {
    mkdirSync(dir, { recursive: true })
    const configs: PopulationConfig[] = []
    configs.push({
      index: 0, params: { ...baseline }, strategy: SEED_STRATEGIES[0],
      viable: false, viabilityCount: 0, generation: 0, lastUsed: 0,
    })
    for (let i = 1; i < n; i++) {
      const magnitude = i / n
      const perturbed: Record<string, number> = {}
      for (const [key, val] of Object.entries(baseline)) {
        const param = GOVERNANCE_PARAMS.get(key)
        if (!param) { perturbed[key] = val; continue }
        const range = param.max - param.min
        const delta = (Math.random() * 2 - 1) * range * magnitude
        perturbed[key] = Math.max(param.min, Math.min(param.max, val + delta))
      }
      configs.push({
        index: i, params: perturbed, strategy: SEED_STRATEGIES[i] ?? SEED_STRATEGIES[0],
        viable: false, viabilityCount: 0, generation: 0, lastUsed: 0,
      })
    }
    const pop = new ConfigPopulation(dir, configs)
    pop.save()
    return pop
  }

  static load(dir: string): ConfigPopulation {
    const files = readdirSync(dir).filter(f => f.startsWith('config_') && f.endsWith('.json')).sort()
    const configs: PopulationConfig[] = files.map(f =>
      JSON.parse(readFileSync(join(dir, f), 'utf-8')) as PopulationConfig
    )
    return new ConfigPopulation(dir, configs)
  }

  size(): number { return this.configs.length }
  getConfig(index: number): PopulationConfig { return this.configs[index] }

  selectViable(): PopulationConfig {
    // Exploration: 20% of the time, pick ANY config — gives non-viable configs
    // a chance to prove themselves. Without this, the population never diversifies.
    if (Math.random() < 0.2) {
      const selected = this.configs[Math.floor(Math.random() * this.configs.length)]
      selected.lastUsed = Date.now()
      console.log(`[population] Exploration: testing config_${String(selected.index).padStart(2, '0')} (viable=${selected.viable})`)
      return selected
    }
    const viable = this.configs.filter(c => c.viable)
    const pool = viable.length > 0 ? viable : this.configs
    const selected = pool[Math.floor(Math.random() * pool.length)]
    selected.lastUsed = Date.now()
    return selected
  }

  markViable(index: number): void {
    this.configs[index].viable = true
    this.configs[index].viabilityCount++
  }

  markMarginal(index: number): void {
    this.configs[index].viable = true
    this.perturbConfig(index, 0.1)
  }

  markNonViable(index: number): void {
    const oldStrategy = this.configs[index].strategy
    this.configs[index].viable = false
    this.configs[index].viabilityCount = 0
    this.perturbConfig(index, 1.0)
    // Only crossover-mutate if the strategy wasn't already self-rewritten by the S4 reflector
    if (this.configs[index].strategy === oldStrategy) {
      this.mutateStrategy(index)
    }
    this.configs[index].generation++
  }

  /**
   * Mutate a strategy by combining sentences from two random viable configs.
   * If no viable configs exist, pick from seed strategies.
   */
  private mutateStrategy(index: number): void {
    const viable = this.configs.filter(c => c.viable && c.index !== index)
    if (viable.length >= 2) {
      const a = viable[Math.floor(Math.random() * viable.length)]
      const b = viable[Math.floor(Math.random() * viable.length)]
      const aSentences = a.strategy.split('. ').filter(s => s.length > 10)
      const bSentences = b.strategy.split('. ').filter(s => s.length > 10)
      // Take first half from A, second half from B
      const midA = Math.ceil(aSentences.length / 2)
      const midB = Math.floor(bSentences.length / 2)
      const combined = [...aSentences.slice(0, midA), ...bSentences.slice(midB)]
      this.configs[index].strategy = combined.join('. ').replace(/\.\./g, '.').trim()
      if (!this.configs[index].strategy.endsWith('.')) this.configs[index].strategy += '.'
    } else {
      // Fall back to a random seed strategy
      this.configs[index].strategy = SEED_STRATEGIES[Math.floor(Math.random() * SEED_STRATEGIES.length)]
    }
  }

  perturbConfig(index: number, magnitude: number): void {
    const config = this.configs[index]
    for (const [key, val] of Object.entries(config.params)) {
      const param = GOVERNANCE_PARAMS.get(key)
      if (!param) continue
      const range = param.max - param.min
      const delta = (Math.random() * 2 - 1) * range * magnitude
      config.params[key] = Math.max(param.min, Math.min(param.max, val + delta))
    }
  }

  maintainVariety(selectedIndex: number): void {
    const selected = this.configs[selectedIndex]
    let similarCount = 0
    for (const c of this.configs) {
      if (c.index === selectedIndex) continue
      const allClose = Object.keys(selected.params).every(k => {
        const param = GOVERNANCE_PARAMS.get(k)
        if (!param) return true
        const range = param.max - param.min
        if (range === 0) return true
        return Math.abs((selected.params[k] - c.params[k]) / range) < 0.05
      })
      if (allClose) similarCount++
    }
    if (similarCount > this.configs.length / 2) {
      const candidates = this.configs.filter(c => c.index !== selectedIndex)
      const target = candidates[Math.floor(Math.random() * candidates.length)]
      this.perturbConfig(target.index, 0.8)
    }
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true })
    for (const c of this.configs) {
      const path = join(this.dir, `config_${String(c.index).padStart(2, '0')}.json`)
      writeFileSync(path, JSON.stringify(c, null, 2))
    }
  }
}
