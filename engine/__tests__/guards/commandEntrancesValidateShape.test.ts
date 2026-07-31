/**
 * Both command entrances must check the shape, not just the discriminant.
 *
 * `parseCommand` (protocol.ts) was `JSON.parse` + `'type' in obj` + a cast into
 * a 19-variant discriminated union. The dashboard socket was the same check
 * inline. Every field consumed downstream was `any` in practice:
 *
 *   main.ts:496   loop.handleUserMessage(command.text, ...)   text: unknown
 *   main.ts:518   dispatch on command.command                 command: unknown
 *   approval flow command.approved                            approved: unknown
 *
 * `{ type: 'approval.response', requestId: 'r1', approved: 'no' }` approved the
 * call — `'no'` is truthy. That is the shared root of findings #1 and #2: a
 * boundary that authenticates and authorizes but never asks what it was handed.
 *
 * One validator, both entrances, one shape rule per variant.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { parseCommand } from '../../bridge/protocol.js'
import { COMMAND_SCHEMA, validateCommand } from '../../bridge/commandSchema.js'
import { dashboardCommandRefusal } from '../../dashboard/server.js'

const protocolSource = readFileSync('engine/bridge/protocol.ts', 'utf-8')

/** One well-formed frame per variant. Both a fixture set and a contract: the
 *  set-equality test below refuses a variant that has no example here. */
const VALID: Record<string, Record<string, unknown>> = {
  'user.message': { type: 'user.message', text: 'hello' },
  'approval.response': { type: 'approval.response', requestId: 'r1', approved: false },
  'ask.answer': { type: 'ask.answer', requestId: 'r1', answer: 'yes' },
  'command': { type: 'command', command: '/tools' },
  'abort': { type: 'abort' },
  'file.open': { type: 'file.open', path: '/tmp/a.ts' },
  'config.update': { type: 'config.update', patches: { temperature: 0.5 } },
  'config.get': { type: 'config.get' },
  'profile.list': { type: 'profile.list' },
  'profile.activate': { type: 'profile.activate', name: 'fast' },
  'profile.write': { type: 'profile.write', name: 'fast', yaml: 'a: 1\n' },
  'profile.validate': { type: 'profile.validate', yaml: 'a: 1\n' },
  'tools.list': { type: 'tools.list' },
  'wizard.query': { type: 'wizard.query', requestId: 'r1', prompt: 'p' },
  'web.search': { type: 'web.search', requestId: 'r1', queries: ['a', 'b'] },
  'vibe.start': { type: 'vibe.start', mode: 'new' },
  'vibe.answer': { type: 'vibe.answer', questionId: 'q1', answer: 'a' },
  'vibe.action': { type: 'vibe.action', action: 'done' },
  'vibe.escalation_response': { type: 'vibe.escalation_response', requestId: 'r1', action: 'fix' },
}

/** The `type: '...'` literal of every member of the TUICommand union, read off
 *  protocol.ts. Derived, not transcribed — a transcribed list agrees with
 *  itself forever. */
function declaredCommandTypes(): string[] {
  const union = protocolSource.match(/export type TUICommand =\r?\n([\s\S]*?)\r?\n\r?\n/)?.[1]
  if (!union) throw new Error('could not find the TUICommand union in protocol.ts')
  const names = [...union.matchAll(/\|\s*(\w+)/g)].map(m => m[1])
  expect(names.length, 'the TUICommand union parsed as empty').toBeGreaterThan(10)
  return names.map(name => {
    const decl = protocolSource.match(new RegExp(`export type ${name} = \\{\\r?\\n\\s*type: '([^']+)'`))
    if (!decl) throw new Error(`${name} has no \`type: '...'\` discriminant in protocol.ts`)
    return decl[1]
  })
}

describe('the schema covers the union it claims to validate', () => {
  it('has exactly one rule per declared command type', () => {
    // A variant added to the union but not to the table would be refused at
    // both entrances — fail-closed, but silently broken. A rule in the table
    // for a variant that no longer exists is dead weight nothing exercises.
    expect(new Set(Object.keys(COMMAND_SCHEMA))).toEqual(new Set(declaredCommandTypes()))
  })

  it('has a well-formed example for every rule', () => {
    expect(new Set(Object.keys(VALID))).toEqual(new Set(Object.keys(COMMAND_SCHEMA)))
  })
})

describe('a well-formed frame is accepted', () => {
  it.each(Object.keys(VALID))('%s', (type) => {
    const res = validateCommand(VALID[type])
    expect(res.ok ? null : res.reason, 'a valid frame was refused').toBeNull()
    expect(parseCommand(JSON.stringify(VALID[type]))).not.toBeNull()
  })

  it('accepts the optional fields of user.message when they are well-typed', () => {
    const res = validateCommand({
      type: 'user.message', text: 'go', cwd: '/tmp',
      contract: { title: 't', brief: 'b', assertions: ['pytest -q'] },
      readOnlyPaths: ['/tmp/brief.md'], unattended: true,
    })
    expect(res.ok ? null : res.reason).toBeNull()
  })

  it('accepts a variant whose optional fields are simply absent', () => {
    expect(validateCommand({ type: 'user.message', text: 'go' }).ok).toBe(true)
  })
})

describe('a frame of the right type but the wrong shape is refused', () => {
  const BAD: Array<[string, unknown]> = [
    ['user.message with no text at all', { type: 'user.message' }],
    ['user.message whose text is a number', { type: 'user.message', text: 42 }],
    ['user.message whose text is an object', { type: 'user.message', text: { toString: 'x' } }],
    ['user.message whose cwd is a number', { type: 'user.message', text: 'go', cwd: 7 }],
    // Absent and null are different answers. A client that means "no cwd"
    // omits the key; one that sends null has a bug worth hearing about.
    ['user.message whose cwd is null', { type: 'user.message', text: 'go', cwd: null }],
    ['user.message whose readOnlyPaths holds a non-string', { type: 'user.message', text: 'go', readOnlyPaths: ['/a', 2] }],
    ['user.message whose contract has no assertions', { type: 'user.message', text: 'go', contract: { title: 't' } }],
    ['user.message whose contract title is a number', { type: 'user.message', text: 'go', contract: { title: 1, assertions: [] } }],
    ['user.message whose unattended is the string "true"', { type: 'user.message', text: 'go', unattended: 'true' }],
    // The one that decides whether a tool call runs.
    ['approval.response whose approved is the string "no"', { type: 'approval.response', requestId: 'r1', approved: 'no' }],
    ['approval.response with no requestId', { type: 'approval.response', approved: true }],
    ['command whose command is an object', { type: 'command', command: { toString: 'x' } }],
    ['command whose args is an array', { type: 'command', command: '/tools', args: ['a'] }],
    ['config.update whose patches is a string', { type: 'config.update', patches: 'temperature=1' }],
    ['config.update whose patches is an array', { type: 'config.update', patches: [] }],
    ['web.search whose queries is a bare string', { type: 'web.search', requestId: 'r1', queries: 'a' }],
    ['web.search whose queries holds a number', { type: 'web.search', requestId: 'r1', queries: ['a', 2] }],
    ['vibe.start with a mode nobody implements', { type: 'vibe.start', mode: 'wipe-disk' }],
    ['vibe.action with an action nobody implements', { type: 'vibe.action', action: 'sudo' }],
    ['vibe.escalation_response with an action nobody implements', { type: 'vibe.escalation_response', requestId: 'r1', action: 'ignore' }],
    ['profile.activate with no name', { type: 'profile.activate' }],
    ['file.open whose path is null', { type: 'file.open', path: null }],
  ]

  it.each(BAD)('%s', (_label, frame) => {
    const res = validateCommand(frame)
    expect(res.ok, 'the validator accepted a malformed frame').toBe(false)
    expect(parseCommand(JSON.stringify(frame)), 'the bridge entrance accepted it').toBeNull()
  })

  it('names the field it refused on, not just "invalid"', () => {
    // A refusal that says nothing is a refusal nobody can act on — and it is
    // also how a shape rule quietly stops being about the field it was written
    // for.
    const res = validateCommand({ type: 'approval.response', requestId: 'r1', approved: 'no' })
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.reason).toMatch(/approved/)
  })
})

describe('a frame that is not a command at all is refused', () => {
  it.each([
    ['an unknown type', { type: 'shell.exec', cmd: 'rm -rf /' }],
    ['no type field', { text: 'hello' }],
    ['a null frame', null],
    ['an array', [{ type: 'abort' }]],
    ['a bare string', 'abort'],
    ['a number', 7],
    ['a type that is not a string', { type: 42 }],
  ])('%s', (_label, frame) => {
    expect(validateCommand(frame).ok).toBe(false)
  })

  it('refuses invalid JSON and empty input at the bridge entrance', () => {
    expect(parseCommand('not json at all')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })
})

describe('both entrances go through the same validator', () => {
  it('the dashboard refuses a malformed frame of an allowed type', () => {
    // `user.message` is on the dashboard allowlist, so authorization passes and
    // only the shape check stands between this frame and handleUserMessage.
    const refusal = dashboardCommandRefusal({ type: 'user.message', text: { toString: 'x' } })
    expect(refusal, 'the dashboard checked the type and not the payload').not.toBeNull()
    expect(refusal).toMatch(/text/)
  })

  it('the dashboard still accepts a well-formed allowed frame', () => {
    expect(dashboardCommandRefusal({ type: 'user.message', text: 'hello' })).toBeNull()
    expect(dashboardCommandRefusal({ type: 'command', command: '/tools' })).toBeNull()
  })

  it('the dashboard still refuses an allowed shape at a forbidden slash', () => {
    // Shape validity must not buy authorization: /approve-all is a perfectly
    // well-formed SlashCommand and is exactly what finding #1 was about.
    expect(dashboardCommandRefusal({ type: 'command', command: '/approve-all' })).not.toBeNull()
  })

  it('neither entrance keeps a private copy of the shape rules', () => {
    // Two mechanisms for one rule means the loser can never be observed
    // failing. Both entrances must call the one validator.
    const dashboardSource = readFileSync('engine/dashboard/server.ts', 'utf-8')
    expect(protocolSource).toMatch(/validateCommand/)
    expect(dashboardSource).toMatch(/validateCommand/)
  })
})
