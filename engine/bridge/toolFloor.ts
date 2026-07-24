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
 * The tools the enforcement message (conversationLoop.ts:2319-2322) demands.
 * Keep in sync with that text: if the message changes what it asks for, this
 * list must change too.
 */
export const ENFORCEMENT_REQUIRED_TOOLS = [
  'Bash',
  'ContractAssertPass',
  'ContractAssertFail',
  'ContractStatus',
] as const

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
}): FloorVerdict<T> {
  const { offered, allTools, operatorPin, enforcementActive } = opts
  if (!enforcementActive) return { kind: 'ok', tools: offered }

  // Only require tools that actually exist in this build.
  const registered = new Set(allTools.map(t => t.name))
  const required = (ENFORCEMENT_REQUIRED_TOOLS as readonly string[]).filter(n => registered.has(n))

  // The operator's explicit allowlist wins over the floor. If it omits a
  // required tool the contract can never be satisfied — report that instead of
  // overriding a human's decision or nagging for an impossible action.
  if (operatorPin) {
    const pin = new Set(operatorPin)
    const missing = required.filter(n => !pin.has(n))
    if (missing.length > 0) return { kind: 'unsatisfiable', tools: offered, missing }
  }

  const have = new Set(offered.map(t => t.name))
  const restored = required.filter(n => !have.has(n))
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
