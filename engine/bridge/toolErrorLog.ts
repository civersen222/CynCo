import { redactSecretValues } from '../training/messageSnapshot.js'

/**
 * Failure log F15: the loop recorded `[loop] Tool result: Bash isError=true` and
 * nothing else — no command, no exit code, no stderr — and the brain JSONL
 * carries only kind/turn_idx/tool_entropy. So the circuit breaker fired on a
 * count whose inputs the log never preserved, and a trip could not be
 * reconstructed after the fact.
 *
 * These two functions produce the one line that makes it reconstructable: which
 * tool, which argument, how the failure was CLASSIFIED (a red test suite and a
 * contract verification check that answers "no" are both deliberately not
 * counted), and a redacted, capped slice of the payload.
 */

export type ToolErrorClass =
  | 'counted'
  | 'benign:test-failure'
  | 'benign:verification-check'

/** Argument keys worth naming, in the order they identify a call. */
const IDENTIFYING_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'agentId']

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…[+${text.length - cap} bytes]`
}

/**
 * The one argument that says which call this was. Falls back to the key names
 * so a tool with an unfamiliar schema still leaves a trace rather than nothing.
 */
export function summarizeToolInput(toolInput: unknown, cap = 160): string {
  if (!toolInput || typeof toolInput !== 'object') return 'args=none'
  const rec = toolInput as Record<string, unknown>
  for (const key of IDENTIFYING_KEYS) {
    const value = rec[key]
    if (typeof value === 'string' && value.length > 0) {
      return `${key}=${clip(redactSecretValues(value).replace(/\s+/g, ' '), cap)}`
    }
  }
  const keys = Object.keys(rec)
  return keys.length ? `argKeys=${keys.join(',')}` : 'args=none'
}

/**
 * Secrets are stripped before the cap, never after — a truncation that cuts a
 * key in half still leaks the half it kept.
 */
export function formatToolError(
  toolName: string,
  toolInput: unknown,
  output: string,
  classification: ToolErrorClass,
  cap = 300,
): string {
  const payload = clip(redactSecretValues(String(output ?? '')).replace(/\s+/g, ' ').trim(), cap)
  return `[loop] Tool error: ${toolName} class=${classification} ` +
    `${summarizeToolInput(toolInput)} :: ${payload || '(empty output)'}`
}
