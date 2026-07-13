/**
 * Tool-call transport repair ladder (P1.8, STATE-AND-VISION VI.1).
 *
 * Single source of truth for parsing tool-call arguments from model output.
 * Ladder: JSON.parse → jsonrepair salvage → malformed marker (never discard).
 * The marker flows to conversationLoop.executeOneTool, which answers it with
 * an error-feedback tool result (one bounded retry) and surfaces the event
 * to the mission ledger via the toolcall.transport protocol event.
 */
import { randomUUID } from 'crypto'
import { jsonrepair } from 'jsonrepair'

/** Marker key on tool_use.input identifying unparseable arguments. */
export const MALFORMED_KEY = '__malformed'

/** Cap raw malformed arguments carried in the marker (keeps context + logs bounded). */
const MAX_RAW_LENGTH = 2000

export type RepairResult =
  | { ok: true; input: Record<string, unknown>; repaired: boolean }
  | { ok: false; error: string; raw: string }

/** Parse tool-call arguments: strict JSON first, jsonrepair salvage second. */
export function repairToolCall(raw: string): RepairResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, input: {}, repaired: false }

  let firstError: string
  try {
    const parsed = JSON.parse(trimmed)
    if (isPlainObject(parsed)) return { ok: true, input: parsed, repaired: false }
    firstError = `arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e)
  }

  try {
    const repaired = JSON.parse(jsonrepair(trimmed))
    if (isPlainObject(repaired)) return { ok: true, input: repaired, repaired: true }
  } catch {
    // fall through to malformed
  }

  return { ok: false, error: firstError, raw: raw.slice(0, MAX_RAW_LENGTH) }
}

export type OpenAIToolCall = {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export type ParsedToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Convert an OpenAI tool_calls array into internal tool_use blocks.
 * Unparseable arguments become malformed-marked blocks — never dropped.
 */
export function parseNativeToolCalls(toolCalls: OpenAIToolCall[]): ParsedToolUseBlock[] {
  const blocks: ParsedToolUseBlock[] = []
  for (const tc of toolCalls) {
    const name = tc.function?.name ?? 'unknown'
    const id = tc.id || `call_${randomUUID()}`
    const result = repairToolCall(tc.function?.arguments ?? '')
    blocks.push({
      type: 'tool_use',
      id,
      name,
      input: result.ok
        ? result.input
        : { [MALFORMED_KEY]: true, raw: result.raw, error: result.error },
    })
  }
  return blocks
}

/** True if a tool_use input carries the malformed marker. */
export function isMalformedInput(input: unknown): boolean {
  return isPlainObject(input) && (input as any)[MALFORMED_KEY] === true
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
