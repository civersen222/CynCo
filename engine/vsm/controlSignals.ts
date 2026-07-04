/**
 * Variety-driven control signals for temperature and tool-set.
 *
 * Reads governance params to compute:
 *   - temperatureAdjust: delta applied to base temperature
 *   - temperature: final clamped temperature
 *   - bestOfNBudget: N for best-of-N sampling
 *   - widenToolSet: whether to unlock all tools
 *
 * Logic:
 *   Low entropy  → model is hammering one tool → raise temperature, widen tools
 *   High entropy → model is thrashing randomly → lower temperature, restrict tools
 *   Balanced     → no adjustment
 */

import { getParam } from './governanceParams.js'

export type ControlSignals = {
  temperatureAdjust: number  // delta applied to base temperature
  temperature: number        // final temperature after adjustment
  bestOfNBudget: number      // N for best-of-N
  widenToolSet: boolean      // true = use all tools
}

export type ControlInput = {
  toolEntropy: number        // Shannon entropy (base 2)
  activeToolCount: number
  stuckTurns: number
  baseTemperature: number
}

export function computeControlSignals(input: ControlInput): ControlSignals {
  const lowThreshold  = getParam('variety.low_entropy_threshold')
  const highMargin    = getParam('variety.high_entropy_margin')
  const floor         = getParam('variety.temperature_floor')
  const ceiling       = getParam('variety.temperature_ceiling')
  const defaultBudget = getParam('bestofn.budget')

  const { toolEntropy, activeToolCount, stuckTurns, baseTemperature } = input

  // Maximum possible entropy for the observed tool set
  const maxEntropy   = Math.log2(Math.max(2, activeToolCount))
  const highThreshold = maxEntropy - highMargin

  let temperatureAdjust = 0
  let widenToolSet = false

  if (toolEntropy < lowThreshold) {
    // Model is hammering one tool — raise temperature to encourage variety
    temperatureAdjust = +0.1
    widenToolSet = true
  } else if (toolEntropy > highThreshold && highThreshold > lowThreshold) {
    // Model is thrashing — lower temperature to tighten focus
    temperatureAdjust = -0.1
    widenToolSet = false
  }

  const temperature = Math.max(floor, Math.min(ceiling, baseTemperature + temperatureAdjust))

  // Raise best-of-N budget when stuck or when entropy is critically low
  const isLowEntropy = toolEntropy < lowThreshold
  const bestOfNBudget = (stuckTurns >= 3 || isLowEntropy) ? 4 : defaultBudget

  return { temperatureAdjust, temperature, bestOfNBudget, widenToolSet }
}

/**
 * Nudge cooling. After repeated no-tool-call nudges the model is stuck in a
 * narration attractor; stronger wording alone does not break it (2026-07-01
 * session: 5 escalating nudges, zero behavior change). Deterministically
 * lower sampling temperature instead so the tool-call token paths dominate.
 */
export function applyNudgeTemperature(temperature: number, consecutiveNudges: number): number {
  if (consecutiveNudges < 2) return temperature
  const floor = getParam('variety.temperature_floor')
  return Math.max(floor, temperature - 0.2)
}
