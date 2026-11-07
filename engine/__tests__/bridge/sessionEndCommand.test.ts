import { describe, it, expect } from 'vitest'
import { validateCommand } from '../../bridge/commandSchema.js'
import { parseCommandResult } from '../../bridge/protocol.js'

/**
 * The TUI's clean shutdown sends `{ type: 'session.end' }`
 * (tui/localcode_tui/bridge.py send_session_end) and main.ts has a
 * `case 'session.end'` that writes the continuity handoff. Between them sits
 * `validateCommand`, whose schema table never listed the type, so every quit
 * was answered with "command frame refused: unknown command type" and the
 * handoff case was unreachable. Found by the strict type-check (A1): the
 * `case` label was not comparable to the TUICommand union.
 */
describe('session.end is a command the bridge accepts', () => {
  it('validateCommand admits the bare frame', () => {
    const v = validateCommand({ type: 'session.end' })
    expect(v.ok, 'ok' in v && !v.ok ? v.reason : '').toBe(true)
  })

  it('parseCommandResult hands it to the engine as a command', () => {
    const parsed = parseCommandResult(JSON.stringify({ type: 'session.end' }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.command.type).toBe('session.end')
  })
})
