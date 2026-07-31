import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { applyCategoryRouting, getToolsForCategory } from '../../tools/toolRouter.js'
import { applyPreLoopRestriction } from '../../bridge/s5Restriction.js'

/**
 * BLOCKING wire-check: two-stage tool routing must NARROW the offered set, never
 * re-derive it from the registry.
 *
 * Every narrowing in one iteration of the model loop, in order: the core-by-
 * default tool gate, the workflow phase restriction, the caller pin, the
 * trust-demotion filter, and last S5's pre-loop restriction — the one that logs
 * `[s5] ENFORCE: tool restriction to [...]`. Then the router ran, and its
 * stage-2 assignment read
 *
 *     iterationTools = toToolDefs(getToolsForCategory(category, ALL_TOOLS))
 *
 * `ALL_TOOLS` is the whole registry. That assignment discarded all five, so the
 * log said ENFORCE and the model was handed the full tool set on the very next
 * line. It was the DEFAULT path, not an edge case: the shipped profile is
 * `context_length: 65536` and `shouldUseRouting` returns true at `<= 65536`.
 *
 * Nor was there a backstop. The two execution-time gates in `executeToolCall`
 * both open with `if (this.allowedTools && ...)`, and `allowedTools` is the
 * caller pin — set for harness and mission runs, null in an interactive session.
 * The defence-in-depth existed only where it was least needed.
 *
 * This is the finding that matters most of the twelve, because governance IS the
 * claim: "S5 is the single policy enforcer" is false if a token-saving heuristic
 * downstream can silently overrule it. So the guard is written against the
 * SHAPE of the defect — an assignment sourced from the registry — and not
 * against the one line that had it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const src = readFileSync(join(repoRoot, 'engine/bridge/conversationLoop.ts'), 'utf-8')

/** Tool-shaped stubs. Only `.name` participates in any of this. */
const defs = (...names: string[]) => names.map(name => ({ name }))

describe('applyCategoryRouting', () => {
  it('keeps only the offered tools that are in the routed category', () => {
    const { tools, conflict } = applyCategoryRouting(
      defs('Read', 'Grep', 'Bash', 'Write'),
      defs('Read', 'Grep', 'Glob', 'Ls'),
    )
    expect(tools.map(t => t.name)).toEqual(['Read', 'Grep'])
    expect(conflict).toBe(false)
  })

  it('never widens: a routed tool that was not offered stays unoffered', () => {
    // The whole finding in one assertion. `Bash` is in the routed category and
    // absent from the offered set because something upstream took it away.
    const { tools } = applyCategoryRouting(defs('Read'), defs('Bash', 'Git', 'Read'))
    expect(tools.map(t => t.name)).toEqual(['Read'])
  })

  it('preserves the order and identity of the offered set, not the routed one', () => {
    // Filtering `offered` rather than `routed` is what makes this an
    // intersection. A version that filtered `routed` by `offered` would produce
    // the same NAMES here but objects from the wrong array — and the routed
    // array holds registry entries, which are not the narrowed definitions the
    // model is supposed to be sent.
    const a = { name: 'Read', schema: 'offered' }
    const b = { name: 'Grep', schema: 'offered' }
    const { tools } = applyCategoryRouting([a, b], defs('Grep', 'Read'))
    expect(tools).toEqual([a, b])
    expect(tools[0]).toBe(a)
  })

  it('reports a conflict and keeps the offered set when the two do not intersect', () => {
    // The router picked a category the upstream restriction forbids. Handing the
    // model an empty tool list leaves it unable to act at all, including unable
    // to recover; handing it the routed set would be the discard this guard
    // exists to prevent. So the restriction wins and routing buys nothing.
    const { tools, conflict } = applyCategoryRouting(defs('Read', 'Grep'), defs('Bash', 'Git'))
    expect(tools.map(t => t.name)).toEqual(['Read', 'Grep'])
    expect(conflict).toBe(true)
  })

  it('an empty offered set is not a conflict', () => {
    // Nothing was taken away by the router, so there is nothing to report. A
    // conflict is two non-empty sets that fail to meet.
    const { tools, conflict } = applyCategoryRouting([], defs('Bash'))
    expect(tools).toEqual([])
    expect(conflict).toBe(false)
  })

  it('an empty routed category leaves the offered set alone', () => {
    // `getToolsForCategory` returns everything for an unknown category, so this
    // is defensive rather than reachable — but returning nothing to the model
    // because the router named a category with no tools in it would be the same
    // failure as above with a different cause.
    const { tools, conflict } = applyCategoryRouting(defs('Read'), [])
    expect(tools.map(t => t.name)).toEqual(['Read'])
    expect(conflict).toBe(true)
  })
})

describe("S5's restriction survives the router", () => {
  // The audit's requested verification, composed from the two shipping
  // functions rather than restated: restrict pre-loop, then route, then assert
  // the result is a subset of the restriction.
  const OFFERED = defs('Read', 'Grep', 'Glob', 'Bash', 'Git', 'Write', 'Edit')
  const RESTRICTION = { tools: ['Read', 'Grep'], reasoning: 'repeated failures — read before writing' }
  const REGISTRY = defs('Read', 'Glob', 'Grep', 'Ls', 'CodeIndex', 'Bash', 'Git', 'Write', 'Edit', 'MultiEdit')

  it('a compatible category narrows further and never past the restriction', () => {
    const { tools: afterS5, applied } = applyPreLoopRestriction(OFFERED, RESTRICTION, 0)
    expect(applied).toBe(true)
    const { tools: final } = applyCategoryRouting(afterS5, getToolsForCategory('read', REGISTRY))
    expect(final.map(t => t.name)).toEqual(['Read', 'Grep'])
    for (const t of final) expect(RESTRICTION.tools).toContain(t.name)
  })

  it('the category S5 forbade does not reinstate it', () => {
    // Pre-fix this returned Bash and Git — the exact log line reading
    // `[s5] ENFORCE: tool restriction to [Read, Grep]` followed by an offer of
    // the execute category.
    const { tools: afterS5 } = applyPreLoopRestriction(OFFERED, RESTRICTION, 0)
    const { tools: final, conflict } = applyCategoryRouting(afterS5, getToolsForCategory('execute', REGISTRY))
    expect(final.map(t => t.name)).toEqual(['Read', 'Grep'])
    expect(conflict).toBe(true)
    expect(final.map(t => t.name)).not.toContain('Bash')
  })

  it("category 'all' is a no-op, not a reset to the registry", () => {
    // `getToolsForCategory('all', ...)` returns the whole registry by design.
    // Assigning that back was the defect; intersecting with it is identity.
    const { tools: afterS5 } = applyPreLoopRestriction(OFFERED, RESTRICTION, 0)
    const { tools: final } = applyCategoryRouting(afterS5, getToolsForCategory('all', REGISTRY))
    expect(final.map(t => t.name)).toEqual(['Read', 'Grep'])
  })
})

describe('routing call-site wiring guard', () => {
  it('no assignment to iterationTools is sourced from the tool registry', () => {
    const assignments = [...src.matchAll(/iterationTools = ([^\n]+)/g)].map(m => m[1])
    // Guards the guard: if the variable is ever renamed this scan finds nothing
    // and every assertion below passes vacuously.
    expect(assignments.length, 'iterationTools is never assigned — the loop was restructured').toBeGreaterThan(0)
    const fromRegistry = assignments.filter(rhs => rhs.includes('ALL_TOOLS'))
    expect(
      fromRegistry,
      'An assignment to iterationTools reads from ALL_TOOLS. Every narrowing above it —\n' +
        'the tool gate, the workflow phase, the caller pin, trust demotion, and S5 —\n' +
        'is discarded by that line. Intersect with the current set instead:\n' +
        fromRegistry.join('\n'),
    ).toEqual([])
  })

  it('the routed category is applied through applyCategoryRouting', () => {
    // First argument, specifically: `applyCategoryRouting` filters its FIRST
    // argument by its second, so passing the registry-derived list first would
    // restore the discard while still calling the right function.
    expect(src).toMatch(/applyCategoryRouting\(\s*iterationTools\s*,/)
  })

  it('the execution-time offered-set gate is not conditioned on the caller pin', () => {
    // The backstop for all of the above. Prompt-time narrowing decides what the
    // model is OFFERED; this decides what it may EXECUTE, and a tool named from
    // conversation history was never offered this turn. The gate used to open
    // `if (this.allowedTools && ...)` — the caller pin, which is set for harness
    // and mission runs and null in a TUI session — so it was live only where a
    // hard pin was already enforced a branch above, and dead everywhere else.
    const gate = src.match(/if \(([^\n]*this\.offeredToolNames[^\n]*)\) \{/)
    expect(gate, 'the offered-set gate moved or changed shape').not.toBeNull()
    expect(
      gate![1],
      'The offered-set gate is conditioned on allowedTools again. That field is the\n' +
        'caller pin, so the gate goes dead in every interactive session:\n' + gate![1],
    ).not.toContain('allowedTools')
  })

  it('a conflict between the router and the restriction is logged, not swallowed', () => {
    // The router picking a forbidden category is a real disagreement between two
    // subsystems. Silently preferring one of them is how the original defect
    // stayed invisible for as long as it did.
    expect(src).toContain('[routing] CONFLICT')
  })
})
