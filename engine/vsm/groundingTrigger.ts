import { probeEdit, type ConceptTable } from './groundingProbe.js'

export type GroundingAction = 'skip' | 'warn' | 'block'
export type GovernanceIntensity = 0 | 1 | 2 | 3

export interface GroundingDecision {
  action: GroundingAction
  /** concepts the edit resolved to the wrong (plain-field) source */
  concepts: string[]
  /** corrective text to surface to the model (empty when action === 'skip') */
  message: string
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** Pull the *added* source text out of an Edit/Write/MultiEdit tool input. */
export function extractAddedText(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Edit') return String(input.new_string ?? '')
  if (toolName === 'Write') return String(input.content ?? '')
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    return edits.map((e) => String(e?.new_string ?? '')).join('\n')
  }
  return ''
}

/** The file path(s) an Edit/Write/MultiEdit call targets. Used to scope a fired
 *  concept to its file so its outcome is judged on a later edit to the SAME file. */
export function extractTargetPaths(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'Edit' || toolName === 'Write') {
    return typeof input.file_path === 'string' ? [input.file_path] : []
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    const paths = edits.map((e) => e?.file_path).filter((p): p is string => typeof p === 'string')
    return [...new Set(paths)]
  }
  return []
}

function buildMessage(findings: { concept: string; systemSource: string }[], block: boolean): string {
  const lines = findings.map(
    (f) =>
      `  • "${f.concept}" is multi-source. You read it from a plain field, but the ` +
      `authoritative source of truth is \`${f.systemSource}\` (use its API, e.g. ` +
      `\`self.${f.systemSource}.<...>\`).`,
  )
  const head = block
    ? 'This edit was BLOCKED by the grounding check. It resolves a concept to the wrong source of truth:'
    : 'Grounding note: this edit resolves a concept to a non-authoritative source:'
  const tail = block
    ? 'Re-read the authoritative module, then redo the edit driving the value from the *_system source.'
    : 'Prefer the *_system source unless you have verified the plain field is correct here.'
  return [head, ...lines, tail].join('\n')
}

/**
 * Decide whether a proposed edit is grounded, and — scaled by governance
 * intensity — whether to skip / warn / block. Pure: no I/O, no side effects.
 */
export function evaluateGrounding(
  toolName: string,
  input: Record<string, unknown>,
  table: ConceptTable,
  intensity: GovernanceIntensity,
): GroundingDecision {
  if (!EDIT_TOOLS.has(toolName) || table.size === 0) {
    return { action: 'skip', concepts: [], message: '' }
  }
  const added = extractAddedText(toolName, input).split('\n')
  const findings = probeEdit(added, table)
  if (findings.length === 0 || intensity === 0) {
    return { action: 'skip', concepts: [], message: '' }
  }
  const concepts = findings.map((f) => f.concept)
  const block = intensity >= 2
  return {
    action: block ? 'block' : 'warn',
    concepts,
    message: buildMessage(findings, block),
  }
}
