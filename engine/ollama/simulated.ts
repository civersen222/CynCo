/**
 * Simulated tool use and thinking extraction for the Standard tier.
 *
 * Models without native function calling can still use tools via
 * prompt-engineered XML tags. Models that emit <think> tags get
 * thinking blocks extracted into the conversation.
 */

import { randomUUID } from 'crypto'
import type { ToolDefinition, ToolUseBlock, ThinkingBlock } from '../types.js'
import { validateToolCall } from '../decoding/postValidator.js'
import { ALL_TOOLS } from '../tools/registry.js'

// ─── Simulated Tool Prompt ───────────────────────────────────────

/**
 * Build a system prompt addendum instructing the model to use
 * <tool_call> XML tags when it wants to invoke a tool.
 *
 * Internal uncached implementation — call buildSimulatedToolPrompt() instead.
 */
function buildSimulatedToolPromptUncached(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map(t => {
    const params = t.input_schema.properties
      ? Object.entries(t.input_schema.properties)
          .map(([k, v]) => `    "${k}": ${JSON.stringify(v)}`)
          .join(',\n')
      : ''
    const required = t.input_schema.required?.length
      ? `  Required: ${t.input_schema.required.join(', ')}`
      : ''
    return `- **${t.name}**: ${t.description}\n  Parameters:\n${params}\n${required}`
  }).join('\n\n')

  return `You have access to the following tools. To use a tool, output a <tool_call> XML block with a JSON object containing "name" and "arguments":

<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

You may use multiple tool calls in a single response. Only use the tools listed below.

Available tools:

${toolDescriptions}`
}

// Memoized: the prompt prefix must be byte-identical across turns for
// llama.cpp checkpoint caching. Single-slot cache keyed on tool names —
// the tool set is stable within a conversation; demotion/routing changes
// legitimately rebuild.
let simPromptKey: string | null = null
let simPromptValue: string | null = null

export function buildSimulatedToolPrompt(tools: ToolDefinition[]): string {
  const key = tools.map(t => t.name).join('\u0000')
  if (key === simPromptKey && simPromptValue !== null) return simPromptValue
  simPromptValue = buildSimulatedToolPromptUncached(tools)
  simPromptKey = key
  return simPromptValue
}

// ─── Tool Call Extraction ────────────────────────────────────────

type SimulatedToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

type ExtractToolCallsResult = {
  toolCalls: SimulatedToolCall[]
  remainingText: string
  validationErrors?: string[]
}

/**
 * Extract <tool_call> blocks from model output text.
 *
 * - Tool calls inside <think> blocks are ignored (thinking, not action)
 * - JSON repair: strips trailing commas, retries parse
 * - Unparseable tool calls are silently discarded
 * - Each extracted call gets a sim_ prefixed UUID
 */
export function extractSimulatedToolCalls(text: string): ExtractToolCallsResult {
  // First strip think blocks to avoid extracting tool calls from thinking
  const { remainingText: textWithoutThinking } = extractThinkingBlocks(text)

  const toolCalls: SimulatedToolCall[] = []
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

  let remaining = textWithoutThinking
  let match: RegExpExecArray | null

  while ((match = toolCallRegex.exec(textWithoutThinking)) !== null) {
    const jsonStr = match[1].trim()
    const parsed = tryParseJSON(jsonStr)
    if (parsed && typeof parsed.name === 'string') {
      toolCalls.push({
        id: `sim_${randomUUID()}`,
        name: parsed.name,
        input: parsed.arguments ?? {},
      })
    }
    // Remove the tool call from the remaining text
    remaining = remaining.replace(match[0], '')
  }

  // 2. Hermes-style <function=name>
  const hermes = extractHermesToolCalls(remaining)
  toolCalls.push(...hermes.calls)
  remaining = hermes.remaining

  // 3. Fenced JSON blocks (only if they look like tool calls)
  const jsonBlocks = extractJsonBlockToolCalls(remaining)
  toolCalls.push(...jsonBlocks.calls)
  remaining = jsonBlocks.remaining

  // 4. Bare call syntax the model wrote as prose. Only when no structured call
  //    was found at all — a model that emits <tool_call> correctly must not
  //    also have its narration mined for accidental extra calls.
  if (toolCalls.length === 0) {
    const prose = extractProseToolCalls(remaining, new Set(ALL_TOOLS.map(t => t.name)))
    toolCalls.push(...prose.calls)
    remaining = prose.remaining
  }

  // Post-validate extracted tool calls against registry schemas
  const validationErrors: string[] = []
  const toolMap = new Map(ALL_TOOLS.map(t => [t.name, t]))
  const validCalls: SimulatedToolCall[] = []

  for (const call of toolCalls) {
    const result = validateToolCall({ name: call.name, input: call.input }, toolMap)
    if (result.valid) {
      validCalls.push(call)
    } else {
      console.log(`[simulated] Invalid tool call "${call.name}": ${result.errors.join('; ')}`)
      validationErrors.push(result.correctionMessage)
    }
  }

  toolCalls.length = 0
  toolCalls.push(...validCalls)

  return {
    toolCalls,
    remainingText: remaining.trim(),
    validationErrors,
  }
}

// ─── Thinking Extraction ─────────────────────────────────────────

type ExtractThinkingResult = {
  thinkingBlocks: ThinkingBlock[]
  remainingText: string
}

/**
 * Extract <think> blocks from model output into ThinkingBlock array.
 */
export function extractThinkingBlocks(text: string): ExtractThinkingResult {
  const thinkingBlocks: ThinkingBlock[] = []
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g

  let remaining = text
  let match: RegExpExecArray | null

  while ((match = thinkRegex.exec(text)) !== null) {
    thinkingBlocks.push({
      type: 'thinking',
      text: match[1].trim(),
    })
    remaining = remaining.replace(match[0], '')
  }

  return {
    thinkingBlocks,
    remainingText: remaining.trim(),
  }
}

// ─── Additional Format Parsers ───────────────────────────────────

/**
 * Extract Hermes-style <function=name>{...}</function> tool calls.
 */
function extractHermesToolCalls(text: string): { calls: SimulatedToolCall[]; remaining: string } {
  const calls: SimulatedToolCall[] = []
  const regex = /<function=(\w+)>\s*([\s\S]*?)\s*<\/function>/g
  let remaining = text
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const name = match[1]
    const parsed = tryParseJSON(match[2].trim())
    if (parsed) {
      calls.push({
        id: `sim_${randomUUID()}`,
        name,
        input: parsed as Record<string, unknown>,
      })
    }
    remaining = remaining.replace(match[0], '')
  }

  return { calls, remaining }
}

/**
 * Extract tool calls from fenced JSON code blocks.
 * Only matches blocks containing both "name" and "arguments" keys.
 */
function extractJsonBlockToolCalls(text: string): { calls: SimulatedToolCall[]; remaining: string } {
  const calls: SimulatedToolCall[] = []
  const regex = /```(?:json)?\s*\n([\s\S]*?)\n```/g
  let remaining = text
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const parsed = tryParseJSON(match[1].trim())
    if (parsed && typeof parsed.name === 'string' && parsed.arguments !== undefined) {
      calls.push({
        id: `sim_${randomUUID()}`,
        name: parsed.name,
        input: (parsed.arguments ?? {}) as Record<string, unknown>,
      })
      remaining = remaining.replace(match[0], '')
    }
  }

  return { calls, remaining }
}

// ─── Bare Call Syntax ────────────────────────────────────────────

/**
 * Extract tool calls a model wrote as ordinary code, e.g.
 *
 *   Glob({ pattern: "*.py" })
 *   Read(file_path="/x/y.py", limit=50)
 *
 * qwen2.5-coder and devstral emit this instead of the <tool_call> XML the
 * prompt asks for. Every such call used to be dropped, so the run completed
 * zero tool calls and reported success having done nothing at all.
 *
 * The name must be a real tool (`known`), which is what keeps this from firing
 * on prose that merely happens to contain parentheses. Argument lists are
 * scanned with string- and nesting-awareness rather than a regex, because the
 * arguments that matter most — Bash commands, Edit old_string — routinely
 * contain quotes, commas and brackets.
 */
export function extractProseToolCalls(
  text: string,
  known: Set<string>,
): { calls: SimulatedToolCall[]; remaining: string } {
  const calls: SimulatedToolCall[] = []
  let remaining = text
  // Not preceded by a word char or dot: `foo.Read(` and `myRead(` are not calls.
  const nameRegex = /(?<![\w.])([A-Z][A-Za-z0-9_]*)\s*\(/g

  let match: RegExpExecArray | null
  while ((match = nameRegex.exec(text)) !== null) {
    const name = match[1]
    const open = match.index + match[0].length - 1
    if (!known.has(name)) continue
    const close = matchingBracket(text, open)
    if (close < 0) continue
    nameRegex.lastIndex = close + 1
    const input = parseArgList(text.slice(open + 1, close))
    if (!input) continue
    calls.push({ id: `sim_${randomUUID()}`, name, input })
    remaining = remaining.replace(text.slice(match.index, close + 1), '')
  }

  return { calls, remaining }
}

/** Index of the bracket closing the one at `open`, or -1. Skips string bodies. */
function matchingBracket(src: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split on commas that are not inside a string or a nested bracket. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      parts.push(src.slice(start, i))
      start = i + 1
    }
  }
  parts.push(src.slice(start))
  return parts.filter(p => p.trim().length > 0)
}

/** Split `key = value` / `key: value` at the first top-level separator. */
function splitKeyValue(part: string): [string, string] | null {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < part.length; i++) {
    const c = part[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if ((c === '=' || c === ':') && depth === 0) return [part.slice(0, i), part.slice(i + 1)]
  }
  return null
}

/**
 * Parse the inside of the parens into an argument object. Accepts both the
 * object-literal form `{ pattern: "*.py" }` and the keyword form
 * `file_path="x", limit=50`. Returns null when any argument is unreadable —
 * a half-parsed call is worse than none, since the tool would run on
 * arguments the model did not write.
 */
function parseArgList(inner: string): Record<string, unknown> | null {
  let body = inner.trim()
  if (body.length === 0) return {}
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1)

  const out: Record<string, unknown> = {}
  for (const part of splitTopLevel(body)) {
    const kv = splitKeyValue(part)
    if (!kv) return null
    const key = kv[0].trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
    if (!/^\w+$/.test(key)) return null
    out[key] = parseArgValue(kv[1])
  }
  return Object.keys(out).length > 0 ? out : null
}

function parseArgValue(raw: string): unknown {
  const s = raw.trim()
  // A single-quoted string is not JSON, but it is what a model writing Python
  // emits. Rewrite it before parsing rather than after failing.
  const asJson = s.length >= 2 && s.startsWith("'") && s.endsWith("'")
    ? `"${s.slice(1, -1).replace(/\\?"/g, '\\"')}"`
    : s
  try {
    return JSON.parse(asJson)
  } catch {
    if (s === 'True') return true
    if (s === 'False') return false
    if (s === 'None') return null
    // A bare word or an unquoted path — the model meant it as a string.
    return s
  }
}

// ─── JSON Repair ─────────────────────────────────────────────────

function tryParseJSON(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str)
  } catch {
    // Try repair: strip trailing commas before } or ]
    const repaired = str.replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(repaired)
    } catch {
      return null
    }
  }
}
