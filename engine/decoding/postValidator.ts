/**
 * Post-validator for tool call schema enforcement.
 *
 * After the model emits a tool call, this validates the call against the
 * registered tool's inputSchema before execution. If invalid, it builds a
 * correction message suitable for re-prompting the model.
 */

import type { ToolImpl } from '../tools/types.js'

// ─── Public types ─────────────────────────────────────────────────

export type ToolCallInput = {
  name: string
  input: Record<string, unknown>
}

export type ValidationResult = {
  valid: boolean
  errors: string[]
  correctionMessage: string
}

// ─── JSON Schema type strings ──────────────────────────────────────

type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'

// ─── Core validator ───────────────────────────────────────────────

/**
 * Validate a tool call against the registry's schema for that tool.
 *
 * Checks:
 *   1. Tool name exists in registry
 *   2. All required fields are present
 *   3. Known fields have the correct JSON Schema type
 *
 * Extra fields are allowed. On failure, correctionMessage includes the
 * specific errors plus the full schema JSON for re-prompting.
 */
export function validateToolCall(
  call: ToolCallInput,
  registry: Map<string, ToolImpl>,
): ValidationResult {
  const errors: string[] = []

  // 1. Tool name check
  const tool = registry.get(call.name)
  if (!tool) {
    const available = Array.from(registry.keys()).sort().join(', ')
    errors.push(
      `Unknown tool "${call.name}". Available tools: ${available}`,
    )
    return makeResult(errors, null)
  }

  const { properties, required = [] } = tool.inputSchema

  // 2. Required fields check
  for (const field of required) {
    if (!(field in call.input)) {
      errors.push(`Missing required field "${field}"`)
    }
  }

  // 3. Type check known fields that are present
  for (const [field, value] of Object.entries(call.input)) {
    const schemaDef = properties[field]
    if (schemaDef == null) {
      // Extra field — allowed, skip
      continue
    }

    const expectedType = extractType(schemaDef)
    if (expectedType !== null) {
      const actualType = jsTypeToSchemaType(value)
      if (!typeMatches(actualType, expectedType)) {
        errors.push(
          `Field "${field}": expected type "${expectedType}", got "${actualType}"`,
        )
      }
    }
  }

  return makeResult(errors, tool)
}

// ─── Helpers ──────────────────────────────────────────────────────

function makeResult(errors: string[], tool: ToolImpl | null): ValidationResult {
  if (errors.length === 0) {
    return { valid: true, errors: [], correctionMessage: '' }
  }

  const schemaJson = tool
    ? JSON.stringify(tool.inputSchema, null, 2)
    : null

  const parts: string[] = [
    'Tool call validation failed:',
    ...errors.map(e => `  - ${e}`),
  ]

  if (schemaJson !== null) {
    parts.push('')
    parts.push('Expected schema:')
    parts.push(schemaJson)
  }

  return {
    valid: false,
    errors,
    correctionMessage: parts.join('\n'),
  }
}

/**
 * Extract the `type` string from a JSON Schema property definition.
 * Returns null when no deterministic single type is present (anyOf, oneOf, etc.).
 */
function extractType(schemaDef: unknown): JsonSchemaType | null {
  if (typeof schemaDef !== 'object' || schemaDef === null) return null
  const s = schemaDef as Record<string, unknown>

  // anyOf / oneOf — skip type checking (union types)
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) return null

  const t = s.type
  if (typeof t === 'string') return t as JsonSchemaType

  return null
}

/**
 * Map a JavaScript runtime value to its JSON Schema type string.
 */
function jsTypeToSchemaType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

/**
 * Check whether a runtime type matches a JSON Schema type declaration.
 * Treats 'integer' as a subset of 'number'.
 */
function typeMatches(actual: string, expected: JsonSchemaType): boolean {
  if (actual === expected) return true
  // JSON Schema 'integer' — a number with no fractional part
  if (expected === 'integer' && actual === 'number') return true
  return false
}
