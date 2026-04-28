/**
 * Governance Parameters — named, logged, tunable values.
 *
 * Every governance threshold is defined here as a named parameter
 * with bounds, default, current value, and change history.
 * This is Level 4 infrastructure from day one: parameters that
 * can be auto-tuned by Bayesian optimization (Level 1),
 * steered by control vectors (Level 2), or learned by LoRA (Level 3).
 *
 * NO MAGIC NUMBERS IN GOVERNANCE CODE. Everything comes from here.
 */

export interface GovernanceParam {
  name: string
  description: string
  value: number
  default: number
  min: number
  max: number
  /** Which VSM system this parameter belongs to */
  system: 'variety' | 'homeostat' | 'feedback' | 'algedonic' | 'metrics' | 'global'
  /** History of value changes for Level 4 learning */
  history: { value: number; timestamp: number; reason: string }[]
}

function param(
  name: string,
  description: string,
  defaultValue: number,
  min: number,
  max: number,
  system: GovernanceParam['system'],
): GovernanceParam {
  return {
    name, description, value: defaultValue, default: defaultValue,
    min, max, system, history: [],
  }
}

/**
 * All governance parameters in one place.
 * Keyed by name for fast lookup.
 */
export const GOVERNANCE_PARAMS: Map<string, GovernanceParam> = new Map([
  // ── Variety Engine ──
  ['variety.env_multiplier', param(
    'variety.env_multiplier',
    'Multiplier for task complexity → environmental variety',
    3.0, 1.0, 10.0, 'variety',
  )],
  ['variety.overload_ratio', param(
    'variety.overload_ratio',
    'Variety ratio below which system is in overload',
    0.5, 0.1, 1.0, 'variety',
  )],

  // ── Homeostat ──
  ['homeostat.damping', param(
    'homeostat.damping',
    'Ashby homeostat damping coefficient (higher = more stable, slower)',
    0.8, 0.1, 2.0, 'homeostat',
  )],
  ['homeostat.time_constant', param(
    'homeostat.time_constant',
    'Homeostat time constant (lower = faster response)',
    5.0, 0.5, 30.0, 'homeostat',
  )],
  ['homeostat.stability_tolerance', param(
    'homeostat.stability_tolerance',
    'Derivative magnitude below which homeostat is considered stable',
    0.05, 0.001, 0.5, 'homeostat',
  )],
  ['homeostat.perturbation_magnitude', param(
    'homeostat.perturbation_magnitude',
    'Magnitude of random weight perturbation when unstable (Ashby ultrastability)',
    0.5, 0.01, 2.0, 'homeostat',
  )],

  // ── Feedback Control ──
  ['feedback.context_setpoint', param(
    'feedback.context_setpoint',
    'Target context utilization (negative feedback loop setpoint)',
    0.7, 0.3, 0.95, 'feedback',
  )],
  ['feedback.context_gain', param(
    'feedback.context_gain',
    'Feedback loop gain for context budget',
    0.5, 0.1, 2.0, 'feedback',
  )],
  ['feedback.pid_kp', param(
    'feedback.pid_kp',
    'PID proportional gain for tool approval rate',
    0.3, 0.01, 2.0, 'feedback',
  )],
  ['feedback.pid_ki', param(
    'feedback.pid_ki',
    'PID integral gain for tool approval rate',
    0.05, 0.001, 0.5, 'feedback',
  )],
  ['feedback.pid_kd', param(
    'feedback.pid_kd',
    'PID derivative gain for tool approval rate',
    0.1, 0.001, 1.0, 'feedback',
  )],
  ['feedback.compression_threshold', param(
    'feedback.compression_threshold',
    'Context error below which compression fires (negative = over setpoint)',
    -0.1, -0.5, 0.0, 'feedback',
  )],

  // ── Algedonic ──
  ['algedonic.kill_threshold', param(
    'algedonic.kill_threshold',
    'Consecutive pain signals before kill switch activates',
    5, 2, 20, 'algedonic',
  )],
  ['algedonic.pain_score', param(
    'algedonic.pain_score',
    'Pain signal score for tool failures (0-1)',
    0.7, 0.3, 1.0, 'algedonic',
  )],
  ['algedonic.pleasure_score', param(
    'algedonic.pleasure_score',
    'Pleasure signal score for tool successes (0-1)',
    0.2, 0.0, 0.5, 'algedonic',
  )],

  // ── Performance Metrics ──
  ['metrics.cusum_threshold', param(
    'metrics.cusum_threshold',
    'CUSUM cumulative deviation threshold for drift detection',
    3.0, 1.0, 10.0, 'metrics',
  )],
  ['metrics.cusum_slack', param(
    'metrics.cusum_slack',
    'CUSUM allowance for natural variation',
    0.5, 0.1, 2.0, 'metrics',
  )],
  ['metrics.red_health', param(
    'metrics.red_health',
    'Health score below which status is RED',
    0.3, 0.1, 0.5, 'metrics',
  )],
  ['metrics.amber_health', param(
    'metrics.amber_health',
    'Health score below which status is AMBER',
    0.6, 0.3, 0.8, 'metrics',
  )],

  // ── Global ──
  ['global.stuck_threshold', param(
    'global.stuck_threshold',
    'Turns with identical responses before declaring stuck',
    3, 2, 10, 'global',
  )],
  ['global.signal_injection', param(
    'global.signal_injection',
    'Whether governance signals are injected into system prompt (1=on, 0=off)',
    1.0, 0.0, 1.0, 'global',
  )],
])

/**
 * Get a parameter value by name.
 */
export function getParam(name: string): number {
  const p = GOVERNANCE_PARAMS.get(name)
  if (!p) throw new Error(`Unknown governance parameter: ${name}`)
  return p.value
}

/**
 * Set a parameter value with logging.
 * Returns the previous value.
 */
export function setParam(name: string, value: number, reason: string): number {
  const p = GOVERNANCE_PARAMS.get(name)
  if (!p) throw new Error(`Unknown governance parameter: ${name}`)
  const prev = p.value
  p.value = Math.max(p.min, Math.min(p.max, value)) // clamp to bounds
  p.history.push({ value: p.value, timestamp: Date.now(), reason })

  // Audit: log parameter mutations
  try {
    const { AuditLogger } = require('../audit/auditLogger.js')
    AuditLogger.log('parameters', {
      type: 'param.mutate',
      param_name: name,
      before: prev,
      after: p.value,
      source: reason.includes('population') ? 'auto' : reason.includes('reset') ? 'reset' : 'manual',
      reason,
    })
  } catch {}

  return prev
}

/**
 * Export all current parameter values as a flat object.
 * Used for decision logging (Level 3/4 training data).
 */
export function exportParams(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [name, p] of GOVERNANCE_PARAMS) {
    result[name] = p.value
  }
  return result
}

/**
 * Import parameter values from a flat object.
 * Used to load optimized parameters from Bayesian search.
 */
export function importParams(values: Record<string, number>, reason: string): void {
  for (const [name, value] of Object.entries(values)) {
    if (GOVERNANCE_PARAMS.has(name)) {
      setParam(name, value, reason)
    }
  }
}

/**
 * Reset all parameters to their default values and clear history.
 * Used in tests to ensure isolation between test files.
 */
export function resetParams(): void {
  for (const p of GOVERNANCE_PARAMS.values()) {
    p.value = p.default
    p.history = []
  }
}

/**
 * Get all parameters for a specific VSM system.
 */
export function getSystemParams(system: GovernanceParam['system']): GovernanceParam[] {
  return Array.from(GOVERNANCE_PARAMS.values()).filter(p => p.system === system)
}

/**
 * Get the full change history across all parameters.
 * Sorted by timestamp. This is Level 4 training data.
 */
export function getParamHistory(): { name: string; value: number; timestamp: number; reason: string }[] {
  const all: { name: string; value: number; timestamp: number; reason: string }[] = []
  for (const [name, p] of GOVERNANCE_PARAMS) {
    for (const h of p.history) {
      all.push({ name, ...h })
    }
  }
  return all.sort((a, b) => a.timestamp - b.timestamp)
}
