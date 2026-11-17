// engine/__tests__/emitLog.test.ts
import { describe, expect, it } from 'bun:test'
import { emitLogLine } from '../emitLog.js'

describe('the engine log names each event it emits, except the chunks of a stream', () => {
  it('an ordinary event is one line with its type', () => {
    expect(emitLogLine('message.complete')).toBe('[localcode] Emitting: message.complete')
    expect(emitLogLine('tool.start')).toBe('[localcode] Emitting: tool.start')
    expect(emitLogLine('session.error')).toBe('[localcode] Emitting: session.error')
  })

  // Measured on the live phone engine's log, 2026-11-17: of its last 20,000 lines, 17,319 were
  // `Emitting: stream.thinking` or `Emitting: stream.token`, one per chunk of the model's
  // answer. Nothing reads them, and the loop's own message_stop line counts the chunks.
  it('a chunk of streamed text or thinking is not a line', () => {
    expect(emitLogLine('stream.token')).toBeNull()
    expect(emitLogLine('stream.thinking')).toBeNull()
  })

  it('only those two are left out: every other stream or ui event is still named', () => {
    for (const type of ['stream.start', 'stream.end', 'ui.render', 'ui.image', 'stream.tokens']) {
      expect(emitLogLine(type)).toBe(`[localcode] Emitting: ${type}`)
    }
  })
})
