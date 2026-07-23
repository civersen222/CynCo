import type { S5Input, S5Rule, TaskClass } from './types.js'

/**
 * P4.5 Phase 3 — S5 proactive tool surfacing.
 *
 * A static heuristic that maps a keyword-classified task to the tools that task
 * usually needs, then surfaces any that are not yet loaded. This is the ACTION
 * side of the (state, surfaced-tools, outcome) training triple; the table is a
 * hand-authored stand-in until enough triples exist to train a model.
 *
 * The rule is `info`-tier (never restricts — `surfaceTools` only pre-loads) and
 * is only registered when `isProactiveToolsEnabled()`. With the flag off it is
 * absent from the rule set, so no surfaceTools field is ever produced.
 */

// Static heuristic table (NOT a learned model — that's the future LoRA milestone).
// Keys are TaskClass; values are canonical registry tool names.
export const TASK_TOOL_HINTS: Record<TaskClass, string[]> = {
  debug: ['Bash', 'Grep', 'Read'],
  test: ['Bash'],
  research: ['WebFetch', 'WebSearch'],
  refactor: ['MultiEdit', 'ReplaceFunction'],
  general: [],
}

/**
 * Keyword classifier for proactive surfacing. Deliberately self-contained and
 * distinct from vsm/cyberneticsGovernance's `classifyTask` (that taxonomy is
 * complexity-oriented — simple_query…architectural — and has no test/research
 * class, so it cannot key TASK_TOOL_HINTS). Order matters: more specific classes
 * are checked first. Returns 'general' when nothing matches (no tools surfaced).
 */
export function classifyTaskClass(userMessage: string): TaskClass {
  const msg = userMessage.toLowerCase()
  if (/\b(test|tests|tdd|unit test|pytest|vitest|spec)\b/.test(msg)) return 'test'
  if (/\b(debug|bug|error|crash|broken|stack ?trace|failing|traceback)\b/.test(msg)) return 'debug'
  if (/\b(research|investigate|look up|find out|documentation|docs|compare)\b/.test(msg)) return 'research'
  if (/\b(refactor|rename|restructure|extract|clean ?up|deduplicate|move)\b/.test(msg)) return 'refactor'
  return 'general'
}

export const PROACTIVE_SURFACING: S5Rule = {
  id: 'P1',
  tier: 'info',
  name: 'Proactive tool surfacing',
  evaluate(input: S5Input) {
    if (!input.taskClass) return null
    const want = TASK_TOOL_HINTS[input.taskClass] ?? []
    if (want.length === 0) return null
    const loaded = new Set(input.loadedTools ?? [])
    const missing = want.filter(t => !loaded.has(t))
    if (missing.length === 0) return null
    return {
      surfaceTools: missing,
      reasoning: `task=${input.taskClass}; surfacing ${missing.join(', ')} proactively`,
    }
  },
}
