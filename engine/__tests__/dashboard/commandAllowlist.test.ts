import { describe, expect, it } from 'bun:test'
import { dashboardCommandRefusal } from '../../dashboard/server.js'

// Regression origin: the dashboard's `/ws` is gated at scope `inference` — the
// READ scope, injected into the page's own HTML because a browser cannot set
// headers on a WebSocket handshake. Its `message` handler forwarded any frame
// with a `type` straight to `handleCommand`, the same privileged entry point
// the header-authenticated TUI bridge uses. Two frames turned the read token
// into arbitrary unapproved shell:
//
//   {"type":"command","command":"/approve-all"}   → loop.setApproveAll(true)
//   {"type":"user.message","text":"..."}          → the agent runs
//
// `approvalGate` short-circuits on that flag and `Bash`'s tier:'approval' is
// the only thing in front of an unsandboxed exec(). These tests pin the
// boundary that now sits in between.

describe('dashboardCommandRefusal', () => {
  const allowed = (frame: unknown) => dashboardCommandRefusal(frame) === null

  it('refuses /approve-all — the finding itself', () => {
    const refusal = dashboardCommandRefusal({ type: 'command', command: '/approve-all' })
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('/approve-all')
  })

  // Each of these reaches something a read-scoped browser must not reach:
  // disk, the process, live config, the kill switch, the working tree, or the
  // conversation itself.
  const FORBIDDEN_SLASH = [
    '/approve-all',
    '/skill',
    '/quit',
    '/exit',
    '/model',
    '/reset',
    '/undo',
    '/compact',
    '/commit',
    '/export',
    '/analyze',
    '/audit-start',
    '/audit-result',
    '/read',
    '/search',
    '/agent',
  ]

  for (const command of FORBIDDEN_SLASH) {
    it(`refuses ${command}`, () => {
      expect(allowed({ type: 'command', command })).toBe(false)
    })
  }

  // The Chat tab is a shipped feature; the fix must not be "turn it off".
  const ALLOWED_SLASH = [
    '/tools', '/spend', '/context', '/s5', '/governance',
    '/git', '/diff',
    '/tdd', '/debug', '/review', '/plan', '/brainstorm', '/critique', '/research', '/cancel',
  ]

  for (const command of ALLOWED_SLASH) {
    it(`allows ${command}`, () => {
      expect(dashboardCommandRefusal({ type: 'command', command })).toBeNull()
    })
  }

  it('allows the frame types the Chat tab needs', () => {
    expect(allowed({ type: 'user.message', text: 'hello' })).toBe(true)
    expect(allowed({ type: 'abort' })).toBe(true)
    expect(allowed({ type: 'approval.response', requestId: 'r1', approved: true })).toBe(true)
    expect(allowed({ type: 'ask.answer', requestId: 'r1', answer: 'yes' })).toBe(true)
  })

  it('allows the frame types the Vibe tab needs', () => {
    // These start and steer the agent; they do not lift an approval.
    expect(allowed({ type: 'vibe.start', mode: 'new', description: 'hi' })).toBe(true)
    expect(allowed({ type: 'vibe.answer', questionId: 'q1', answer: 'a' })).toBe(true)
    expect(allowed({ type: 'vibe.action', action: 'done' })).toBe(true)
    expect(allowed({ type: 'vibe.escalation_response', requestId: 'r1', action: 'skip' })).toBe(true)
  })

  it('refuses an unknown frame type', () => {
    expect(allowed({ type: 'config.patch', model: 'evil' })).toBe(false)
    expect(allowed({ type: '' })).toBe(false)
  })

  it('refuses a frame that is not an object, or has no string type', () => {
    expect(allowed(null)).toBe(false)
    expect(allowed(undefined)).toBe(false)
    expect(allowed('user.message')).toBe(false)
    expect(allowed(42)).toBe(false)
    expect(allowed([])).toBe(false)
    expect(allowed({})).toBe(false)
    expect(allowed({ type: 7 })).toBe(false)
  })

  it('refuses a command frame whose command is not a string', () => {
    // `command` reaches a `switch` in main.ts; a non-string that fell through
    // the allowlist would reach the default arm carrying whatever it liked.
    expect(allowed({ type: 'command' })).toBe(false)
    expect(allowed({ type: 'command', command: null })).toBe(false)
    expect(allowed({ type: 'command', command: ['/approve-all'] })).toBe(false)
    expect(allowed({ type: 'command', command: { toString: () => '/tools' } })).toBe(false)
  })

  it('is an allowlist, not a denylist — an unlisted command is refused', () => {
    // The property that matters for everything added after this file was
    // written: a new slash command does not inherit the browser's reach.
    expect(allowed({ type: 'command', command: '/some-future-command' })).toBe(false)
    expect(allowed({ type: 'command', command: '/' })).toBe(false)
  })

  it('does not match on a prefix or a suffix of an allowed command', () => {
    // `/tools` is allowed; `/toolsx` and `x/tools` are different commands and
    // a substring test would have accepted both.
    expect(allowed({ type: 'command', command: '/toolsx' })).toBe(false)
    expect(allowed({ type: 'command', command: 'x/tools' })).toBe(false)
    expect(allowed({ type: 'command', command: '/tools ' })).toBe(false)
    expect(allowed({ type: 'command', command: 'tools' })).toBe(false)
  })

  it('does not let a case change past the list', () => {
    expect(allowed({ type: 'command', command: '/TOOLS' })).toBe(false)
    expect(allowed({ type: 'USER.MESSAGE' })).toBe(false)
  })

  it('reports a reason, so a refusal is not a silent drop', () => {
    // The handler logs this string. An empty or absent reason would make a
    // refusal indistinguishable from a socket that lost the frame.
    for (const frame of [null, {}, { type: 'nope' }, { type: 'command' }, { type: 'command', command: '/quit' }]) {
      const refusal = dashboardCommandRefusal(frame)
      expect(typeof refusal).toBe('string')
      expect((refusal as string).length).toBeGreaterThan(0)
    }
  })
})
