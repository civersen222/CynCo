// engine/bridge/commandSchema.ts
// One shape rule per TUICommand variant, used by BOTH command entrances.
//
// `parseCommand` was `JSON.parse` + `'type' in obj` + a cast into a 19-variant
// discriminated union, and the dashboard socket was the same check written
// inline. Everything read downstream — `command.text`, `command.command`,
// `command.approved`, `command.patches` — was `any` in practice, so
// `{ type: 'approval.response', requestId: 'r1', approved: 'no' }` approved the
// tool call: `'no'` is truthy. Two boundaries that authenticated and authorized
// but never asked what they had been handed.
//
// Hand-written rather than Zod, matching `engine/skills/types.ts`: the repo
// keeps a zero-runtime-dep posture and `validateFrontmatter` is the house style
// for this. The cost is that the table has to be kept in step with the union;
// `engine/__tests__/guards/commandEntrancesValidateShape.test.ts` reads the
// union out of protocol.ts and requires set equality with the table, so it is
// kept in step by measurement rather than by discipline.
//
// The import of TUICommand is type-only and erased at runtime, so protocol.ts
// importing this file back is not a runtime cycle.

import type { TUICommand } from './protocol.js'

type Frame = Record<string, unknown>

/** A field rule: null when satisfied, otherwise the reason to refuse on. */
type Check = (frame: Frame) => string | null

const isString = (v: unknown): boolean => typeof v === 'string'
const isBoolean = (v: unknown): boolean => typeof v === 'boolean'
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString)
/** An object, and not an array — `patches: []` would otherwise pass as one. */
const isPlainObject = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const oneOf = (...allowed: string[]) => (v: unknown): boolean =>
  typeof v === 'string' && allowed.includes(v)

/**
 * One assertion: plain text, or a redacted text paired with the command that
 * actually decides it.
 *
 * The second form exists because a mission's gate is held out from the model
 * (finding (ah)/(aj)) — the text is prose and the command travels beside it. A
 * boundary that only knew the string form refused the frame outright, which
 * would have turned "the gate is withheld" into "there is no contract".
 */
const isAssertion = (v: unknown): boolean => {
  if (isString(v)) return true
  if (!isPlainObject(v)) return false
  const a = v as Frame
  return isString(a.text) && isString(a.command)
}

/** The harness-supplied DoD contract on `user.message`. */
const isContract = (v: unknown): boolean => {
  if (!isPlainObject(v)) return false
  const c = v as Frame
  return isString(c.title)
    && (c.brief === undefined || isString(c.brief))
    && Array.isArray(c.assertions) && c.assertions.every(isAssertion)
}

/** Required field. */
function req(field: string, ok: (v: unknown) => boolean, what: string): Check {
  return f => (ok(f[field]) ? null : `${field} must be ${what}`)
}

/**
 * Optional field: absent is fine, present and wrong is not.
 *
 * `null` is not absent. A client that means "no cwd" omits the key; one that
 * sends `cwd: null` has a bug, and the difference between the two is exactly
 * what this boundary exists to report.
 */
function opt(field: string, ok: (v: unknown) => boolean, what: string): Check {
  return f => (f[field] === undefined || ok(f[field]) ? null : `${field} must be ${what} when present`)
}

/**
 * Every command variant and the shape it must have.
 *
 * Typed as `Record<TUICommand['type'], …>`, so a variant added to the union
 * without a rule here is a type error as well as a guard failure. An empty
 * array means the discriminant is the whole of the frame.
 */
export const COMMAND_SCHEMA: Record<TUICommand['type'], Check[]> = {
  'user.message': [
    req('text', isString, 'a string'),
    opt('cwd', isString, 'a string'),
    opt('contract', isContract, 'an object with a string title and a string[] of assertions'),
    opt('readOnlyPaths', isStringArray, 'an array of strings'),
    opt('unattended', isBoolean, 'a boolean'),
  ],
  'approval.response': [
    req('requestId', isString, 'a string'),
    // The field that decides whether a tool runs. A string here is truthy.
    req('approved', isBoolean, 'a boolean'),
  ],
  'ask.answer': [req('requestId', isString, 'a string'), req('answer', isString, 'a string')],
  'command': [req('command', isString, 'a string'), opt('args', isString, 'a string')],
  'abort': [],
  'file.open': [req('path', isString, 'a string')],
  'config.update': [req('patches', isPlainObject, 'an object')],
  'config.get': [],
  'profile.list': [],
  'profile.activate': [req('name', isString, 'a string')],
  'profile.write': [req('name', isString, 'a string'), req('yaml', isString, 'a string')],
  'profile.validate': [req('yaml', isString, 'a string')],
  'tools.list': [],
  'wizard.query': [
    req('requestId', isString, 'a string'),
    req('prompt', isString, 'a string'),
    opt('systemPrompt', isString, 'a string'),
  ],
  'web.search': [req('requestId', isString, 'a string'), req('queries', isStringArray, 'an array of strings')],
  'vibe.start': [
    req('mode', oneOf('new', 'continue', 'fix', 'explain'), "one of 'new', 'continue', 'fix', 'explain'"),
    opt('description', isString, 'a string'),
  ],
  'vibe.answer': [req('questionId', isString, 'a string'), req('answer', isString, 'a string')],
  'vibe.action': [
    req('action', oneOf('accept_suggestion', 'something_else', 'fix', 'done', 'skip', 'just_build'),
      "one of 'accept_suggestion', 'something_else', 'fix', 'done', 'skip', 'just_build'"),
    opt('text', isString, 'a string'),
  ],
  'vibe.escalation_response': [
    req('requestId', isString, 'a string'),
    req('action', oneOf('fix', 'skip', 'explain'), "one of 'fix', 'skip', 'explain'"),
  ],
}

export type CommandValidation =
  | { ok: true; command: TUICommand }
  | { ok: false; reason: string }

/**
 * Check an already-parsed frame against the schema for its own `type`.
 *
 * The refusal names the field. A boundary that answers "invalid" tells the
 * caller nothing it can act on, and tells a later reader nothing about which
 * rule was doing the work.
 */
export function validateCommand(frame: unknown): CommandValidation {
  if (!isPlainObject(frame)) return { ok: false, reason: 'frame is not an object' }
  const f = frame as Frame
  const type = f.type
  if (typeof type !== 'string') return { ok: false, reason: 'frame has no string type' }
  const checks = Object.prototype.hasOwnProperty.call(COMMAND_SCHEMA, type)
    ? COMMAND_SCHEMA[type as TUICommand['type']]
    : undefined
  if (!checks) return { ok: false, reason: `unknown command type ${JSON.stringify(type)}` }
  for (const check of checks) {
    const reason = check(f)
    if (reason !== null) return { ok: false, reason: `${type}: ${reason}` }
  }
  return { ok: true, command: frame as TUICommand }
}
