/**
 * A floor under the offered tool set, for tools that active contract
 * enforcement will demand.
 *
 * Contract enforcement injects a message telling the model to run tests with
 * Bash and mark assertions with ContractAssertPass. Eight separate layers can
 * narrow the offered tool set (core/extended split, workflow phase allowedTools,
 * caller pin, S5 restriction, trust demotion, tool router, S5 live re-eval,
 * toolgate attenuation) and none of them knows enforcement is active.
 *
 * Real incident: the TDD workflow phase restricted the set to seven tools
 * including neither Bash nor ContractAssertPass. The model was told five times
 * to perform an action it had no tool for, the contract never advanced past
 * "2 pending", and enforcement then expired into an unverified pass.
 *
 * Applied downstream of every narrowing layer, this makes that contradiction
 * structurally impossible rather than fixed in one workflow definition.
 */

export interface ToolLike {
  name: string
}

/**
 * The full set of tools the model needs to satisfy or honestly resolve an
 * active contract. The enforcement message names Bash and ContractAssertPass
 * (the happy path), but ContractAssertFail lets the model record a genuine
 * failure and ContractStatus lets it check what remains — all four must be
 * available for the contract to be resolvable in any outcome.
 */
export const ENFORCEMENT_REQUIRED_TOOLS = [
  'Bash',
  'ContractAssertPass',
  'ContractAssertFail',
  'ContractStatus',
] as const

/**
 * A requirement satisfied by ANY ONE member rather than by all of them: a
 * contract that asserts a file will be modified needs *a* way to modify a file,
 * and which one is the model's business.
 *
 * Bash is deliberately not a member. A shell can obviously write a file — that
 * is what finding (f) exists to measure — but counting it here would let the
 * floor pronounce a read-only cage acceptable, and would push the model back
 * toward the `python -c "open(...,'w')"` string surgery that cost L3-3.3 run 1
 * the entire task.
 */
export const FILE_MUTATION_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'ApplyPatch',
  'ReplaceFunction',
  'NotebookEdit',
] as const

/**
 * Does any assertion claim the filesystem will be different afterwards?
 *
 * These are the three machine-checkable file templates contractVerify
 * understands. Matching the contract's own wording keeps this honest: the floor
 * requires a writing tool because the contract says a file will change, not
 * because a heuristic guessed the task looked like an edit.
 */
export function assertionsRequireFileMutation(assertions: readonly string[]): boolean {
  return assertions.some(a =>
    /^\s*File\s+.+\s+(was modified|exists after changes|no longer exists after changes)\b/i.test(a),
  )
}

export type FloorVerdict<T extends ToolLike> =
  /** Nothing to do. */
  | { kind: 'ok'; tools: T[] }
  /** Required tools were removed by an automatic layer and have been restored. */
  | { kind: 'restored'; tools: T[]; restored: string[] }
  /** The operator's explicit pin omits required tools — enforcement cannot be satisfied. */
  | { kind: 'unsatisfiable'; tools: T[]; missing: string[] }

export function applyToolFloor<T extends ToolLike>(opts: {
  /** The final offered set, after every narrowing layer. */
  offered: T[]
  /** Every registered tool, in the same shape as `offered`. */
  allTools: T[]
  /** Caller-supplied allowedTools pin, or null when unpinned. */
  operatorPin: string[] | null
  enforcementActive: boolean
  /**
   * The active contract's assertions, used to floor what the TASK needs rather
   * than only what the enforcement message says. Omitted means "no information
   * available" and adds no requirement — never "no files will change".
   */
  assertions?: readonly string[]
}): FloorVerdict<T> {
  const { offered, allTools, operatorPin, enforcementActive, assertions } = opts
  if (!enforcementActive) return { kind: 'ok', tools: offered }

  // Only require tools that actually exist in this build.
  const registered = new Set(allTools.map(t => t.name))
  const required = (ENFORCEMENT_REQUIRED_TOOLS as readonly string[]).filter(n => registered.has(n))
  // Satisfied by any one member: empty unless the contract itself claims the
  // filesystem will change.
  const anyOf = assertions && assertionsRequireFileMutation(assertions)
    ? (FILE_MUTATION_TOOLS as readonly string[]).filter(n => registered.has(n))
    : []

  // The operator's explicit allowlist wins over the floor. If it omits a
  // required tool the contract can never be satisfied — report that instead of
  // overriding a human's decision or nagging for an impossible action.
  if (operatorPin) {
    const pin = new Set(operatorPin)
    const missing = required.filter(n => !pin.has(n))
    if (anyOf.length > 0 && !anyOf.some(n => pin.has(n))) missing.push(...anyOf)
    if (missing.length > 0) return { kind: 'unsatisfiable', tools: offered, missing }
  }

  const have = new Set(offered.map(t => t.name))
  const restored = required.filter(n => !have.has(n))
  if (anyOf.length > 0 && !anyOf.some(n => have.has(n))) restored.push(...anyOf)
  if (restored.length === 0) return { kind: 'ok', tools: offered }

  const byName = new Map(allTools.map(t => [t.name, t]))
  const additions = restored.map(n => byName.get(n)!).filter(Boolean)
  return { kind: 'restored', tools: [...offered, ...additions], restored }
}

/**
 * Best-effort label for WHY a tool went missing, used only in the log line.
 * Attribution never affects the decision.
 */
export function attributeRemoval(
  name: string,
  ctx: { phaseName?: string | null; phaseAllowed?: string[] | null; demoted?: string[] },
): string {
  if (ctx.phaseAllowed && !ctx.phaseAllowed.includes(name)) {
    return `workflow phase '${ctx.phaseName ?? 'unknown'}'`
  }
  if (ctx.demoted?.includes(name)) return 'trust demotion'
  return 'governance gating'
}
