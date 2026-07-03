import type { Interval } from './types.js'

/** Wilson score interval for a binomial proportion. z=1.96 -> 95%. */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { point: 0, lower: 0, upper: 1 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  }
}

/**
 * Bootstrap CI on the mean of per-task lifts (governed - ungoverned), resampling
 * tasks with replacement. `confidence` is e.g. 0.95. `rng` is injectable for
 * deterministic tests.
 */
export function pairedBootstrapLift(
  perTaskLifts: number[],
  iterations = 10000,
  confidence = 0.95,
  rng: () => number = Math.random,
): { meanLift: number; lower: number; upper: number } {
  const k = perTaskLifts.length
  if (k === 0) return { meanLift: 0, lower: 0, upper: 0 }
  const meanLift = perTaskLifts.reduce((a, b) => a + b, 0) / k
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < k; j++) sum += perTaskLifts[Math.floor(rng() * k)]
    means.push(sum / k)
  }
  means.sort((a, b) => a - b)
  const alpha = (1 - confidence) / 2
  const lowerIdx = Math.floor(alpha * iterations)
  const upperIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1)
  return { meanLift, lower: means[lowerIdx], upper: means[upperIdx] }
}

/**
 * Bootstrap CI on the mean of a continuous sample, resampling values with
 * replacement (percentile CI). `point` is the exact sample mean; `rng` is
 * injectable for deterministic tests. Empty input -> all-zero interval.
 */
export function meanBootstrap(
  values: number[],
  iterations = 10000,
  confidence = 0.95,
  rng: () => number = Math.random,
): Interval {
  const k = values.length
  if (k === 0) return { point: 0, lower: 0, upper: 0 }
  const point = values.reduce((a, b) => a + b, 0) / k
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < k; j++) sum += values[Math.floor(rng() * k)]
    means.push(sum / k)
  }
  means.sort((a, b) => a - b)
  const alpha = (1 - confidence) / 2
  const lowerIdx = Math.floor(alpha * iterations)
  const upperIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1)
  return { point, lower: means[lowerIdx], upper: means[upperIdx] }
}
