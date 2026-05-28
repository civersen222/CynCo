/**
 * GBNF grammar emitter for tool-constrained decoding.
 *
 * Generates a GBNF grammar that constrains llama.cpp output to valid
 * <tool_call> XML blocks with correct JSON arguments per registered tool.
 *
 * Grammar shape:
 *   root           ::= text (tool-call text)*
 *   tool-call      ::= "<tool_call>" ws json-call ws "</tool_call>"
 *   json-call      ::= "{" ws ( <per-tool-call> | ... ) ws "}"
 *   <tool>-call    ::= name-kv "," ws args-kv  (fields ordered: name, arguments)
 *   <tool>-args    ::= "{" ws <field-rules> ws "}"
 */

import type { ToolImpl } from '../tools/types.js'

// ─── Public API ───────────────────────────────────────────────────

/**
 * Generate a GBNF grammar string constraining output to valid <tool_call>
 * XML for the given tools. Returns empty string for empty tool arrays.
 */
export function generateGBNF(tools: ToolImpl[]): string {
  if (tools.length === 0) return ''

  const lines: string[] = []

  // Root: optional text, then one or more tool calls each optionally preceded by text
  lines.push('root ::= text (tool-call text)*')
  lines.push('')

  // Text: characters that don't start a <tool_call> sequence
  lines.push('text ::= [^<]* ("<" [^t/] [^<]*)*')
  lines.push('')

  // Whitespace
  lines.push('ws ::= [ \\t\\n\\r]*')
  lines.push('')

  // Tool call wrapper
  lines.push('tool-call ::= "<tool_call>" ws json-call ws "</tool_call>"')
  lines.push('')

  // Top-level dispatch: each tool gets its own json-call variant
  const callAlts = tools
    .map(t => `${slugify(t.name)}-call`)
    .join('\n  | ')
  lines.push(`json-call ::= ${callAlts}`)
  lines.push('')

  // Per-tool call rules: { "name": "<toolname>", "arguments": { ... } }
  for (const tool of tools) {
    const slug = slugify(tool.name)
    const escapedName = escapeGbnfString(tool.name)
    lines.push(`${slug}-call ::= "{" ws '"name"' ws ":" ws "${escapedName}" ws "," ws '"arguments"' ws ":" ws ${slug}-args ws "}"`)
  }
  lines.push('')

  // Per-tool argument rules
  for (const tool of tools) {
    const slug = slugify(tool.name)
    const rule = buildArgsRule(slug, tool.inputSchema)
    lines.push(rule)
  }
  lines.push('')

  // JSON primitives
  lines.push('json-string ::= "\\"" json-string-char* "\\""')
  lines.push('json-string-char ::= [^"\\\\] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] )')
  lines.push('')
  lines.push('json-number ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [+-]? [0-9]+ )?')
  lines.push('')
  lines.push('json-boolean ::= "true" | "false"')
  lines.push('')
  lines.push('json-null ::= "null"')
  lines.push('')
  lines.push('json-value ::= json-string | json-number | json-boolean | json-null | json-object | json-array')
  lines.push('')
  lines.push('json-object ::= "{" ws ( json-string ws ":" ws json-value ( ws "," ws json-string ws ":" ws json-value )* ws )? "}"')
  lines.push('')
  lines.push('json-array ::= "[" ws ( json-value ( ws "," ws json-value )* ws )? "]"')

  return lines.join('\n')
}

// ─── Rule Builders ────────────────────────────────────────────────

/**
 * Build a GBNF rule for a tool's arguments object.
 * Required fields are emitted as mandatory; optional fields are wrapped in ( ... )?.
 */
function buildArgsRule(
  slug: string,
  inputSchema: ToolImpl['inputSchema'],
): string {
  const { properties, required = [] } = inputSchema
  const propEntries = Object.entries(properties)

  if (propEntries.length === 0) {
    return `${slug}-args ::= "{" ws "}"`
  }

  const requiredSet = new Set(required)
  const requiredProps = propEntries.filter(([k]) => requiredSet.has(k))
  const optionalProps = propEntries.filter(([k]) => !requiredSet.has(k))

  const parts: string[] = []

  // Required fields always appear, separated by commas
  for (let i = 0; i < requiredProps.length; i++) {
    const [key, schema] = requiredProps[i]
    const valueRule = schemaToRule(schema)
    if (i === 0) {
      parts.push(`"${escapeGbnfString(key)}" ws ":" ws ${valueRule}`)
    } else {
      parts.push(`ws "," ws "${escapeGbnfString(key)}" ws ":" ws ${valueRule}`)
    }
  }

  // Optional fields wrapped in ( ... )?
  for (const [key, schema] of optionalProps) {
    const valueRule = schemaToRule(schema)
    const sep = parts.length > 0 ? 'ws "," ws ' : ''
    parts.push(`( ${sep}"${escapeGbnfString(key)}" ws ":" ws ${valueRule} )?`)
  }

  const body = parts.join(' ')
  return `${slug}-args ::= "{" ws ${body} ws "}"`
}

/**
 * Map a JSON Schema property definition to a GBNF rule reference.
 */
function schemaToRule(schema: unknown): string {
  if (typeof schema !== 'object' || schema === null) return 'json-value'

  const s = schema as Record<string, unknown>

  // Handle anyOf / oneOf unions
  if (Array.isArray(s.anyOf)) {
    const alts = (s.anyOf as unknown[]).map(sub => schemaToRule(sub))
    return '( ' + alts.join(' | ') + ' )'
  }
  if (Array.isArray(s.oneOf)) {
    const alts = (s.oneOf as unknown[]).map(sub => schemaToRule(sub))
    return '( ' + alts.join(' | ') + ' )'
  }

  switch (s.type) {
    case 'string':  return 'json-string'
    case 'number':
    case 'integer': return 'json-number'
    case 'boolean': return 'json-boolean'
    case 'null':    return 'json-null'
    case 'array':   return 'json-array'
    case 'object':  return 'json-object'
    default:        return 'json-value'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Convert a tool name to a safe GBNF rule-name slug.
 * e.g. "Read" -> "read", "CodeIndex" -> "codeindex", "web-search" -> "web-search"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Escape a string for embedding in a GBNF string literal.
 */
function escapeGbnfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
