/**
 * What a reconnecting page is sent (engine/dashboard/replay.ts).
 *
 * A phone whose screen locked loses its socket while the turn goes on. The
 * dashboard numbers the frames that draw the Chat pane and keeps the recent
 * ones; a page that reconnects says how far it got and is sent what it missed,
 * in order, once. Token frames are the bulk of a turn, so consecutive ones are
 * kept as one growing entry and the cursor is (seq, off).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { ReplayBuffer, REPLAYED_TYPES, NOT_REPLAYED_TYPES, parseCursor } from '../../dashboard/replay.js'

const wire = (s: string | null) => JSON.parse(s!) as Record<string, any>
const tok = (text: string) => ({ type: 'stream.token', text })

describe('ReplayBuffer: numbering', () => {
  it('numbers a replayed frame and leaves every other frame exactly as it was', () => {
    const b = new ReplayBuffer()
    expect(wire(b.record({ type: 'tool.start', toolName: 'Read', toolId: 't1' }))).toEqual({ type: 'tool.start', toolName: 'Read', toolId: 't1', seq: 1 })
    expect(wire(b.record({ type: 'tool.complete', toolName: 'Read', toolId: 't1' })).seq).toBe(2)
    expect(b.record({ type: 'governance.status', health: 1 })).toBeNull()
    expect(b.record({ type: 'brain.uncertainty', points: [] })).toBeNull()
    expect(b.state()).toMatchObject({ seq: 2, off: 0 })
  })

  it('consecutive tokens share one seq and say how far into it they reach', () => {
    const b = new ReplayBuffer()
    expect(wire(b.record(tok('Hel')))).toEqual({ type: 'stream.token', text: 'Hel', seq: 1, off: 3 })
    expect(wire(b.record(tok('lo')))).toEqual({ type: 'stream.token', text: 'lo', seq: 1, off: 5 })
    // Thinking is its own run; a token after it starts a new one.
    expect(wire(b.record({ type: 'stream.thinking', text: 'hm' }))).toMatchObject({ seq: 2, off: 2 })
    expect(wire(b.record(tok('!')))).toMatchObject({ seq: 3, off: 1 })
    expect(b.state()).toMatchObject({ seq: 3, off: 1 })
  })

  it('a token of another message, or one carrying a field the run cannot hold, starts a new entry', () => {
    const b = new ReplayBuffer()
    b.record({ type: 'stream.token', text: 'a', messageId: 'm1' })
    expect(wire(b.record({ type: 'stream.token', text: 'b', messageId: 'm1' }))).toMatchObject({ seq: 1, off: 2 })
    expect(wire(b.record({ type: 'stream.token', text: 'c', messageId: 'm2' }))).toMatchObject({ seq: 2, off: 1 })
    expect(wire(b.record({ type: 'stream.token', text: 'd', messageId: 'm2', extra: true }))).toMatchObject({ seq: 3, extra: true })
  })
})

describe('ReplayBuffer: what a returning page is sent', () => {
  function turn() {
    const b = new ReplayBuffer()
    b.record(tok('The '))                 // seq 1, off 4
    b.record(tok('answer'))               // seq 1, off 10
    return b
  }

  it('nothing, when it missed nothing', () => {
    const b = turn()
    expect(b.since({ epoch: b.epoch, seq: 1, off: 10 })).toEqual({ frames: [], gap: false, known: true })
  })

  it('the rest of the run it was in the middle of, then everything after, in order', () => {
    const b = turn()
    const at = { epoch: b.epoch, seq: 1, off: 4 } // the socket died after "The "
    b.record(tok(' is 42.'))
    b.record({ type: 'tool.start', toolName: 'Bash', toolId: 't9' })
    b.record({ type: 'tool.complete', toolName: 'Bash', toolId: 't9' })
    b.record(tok('Done.'))
    b.record({ type: 'message.complete', stopReason: 'end_turn' })
    const r = b.since(at)
    expect(r.gap).toBe(false)
    expect(r.frames.map(wire)).toEqual([
      { type: 'stream.token', text: 'answer is 42.', seq: 1, off: 17 },
      { type: 'tool.start', toolName: 'Bash', toolId: 't9', seq: 2 },
      { type: 'tool.complete', toolName: 'Bash', toolId: 't9', seq: 3 },
      { type: 'stream.token', text: 'Done.', seq: 4, off: 5 },
      { type: 'message.complete', stopReason: 'end_turn', seq: 5 },
    ])
  })

  it('a page that was never here (no cursor) is sent nothing: what it draws on load is not this buffer\'s to give', () => {
    const b = turn()
    expect(b.since(null)).toEqual({ frames: [], gap: false, known: false })
  })

  it('a cursor from another engine, or from before the conversation changed, is sent nothing', () => {
    const b = turn()
    expect(b.since({ epoch: 'someone-else', seq: 1, off: 0 })).toEqual({ frames: [], gap: false, known: false })
    const before = { epoch: b.epoch, seq: 1, off: 4 }
    b.reset()
    b.record(tok('a new chat'))
    expect(b.epoch).not.toBe(before.epoch)
    expect(b.since(before)).toEqual({ frames: [], gap: false, known: false })
    expect(b.state()).toMatchObject({ seq: 1, off: 10 })
  })

  it('a cursor ahead of the buffer (it cannot be) is treated as unknown, not as "nothing missed"', () => {
    const b = turn()
    expect(b.since({ epoch: b.epoch, seq: 7, off: 0 }).known).toBe(false)
  })
})

describe('ReplayBuffer: partial surfaces', () => {
  it('keeps only the newest partial frame of a RenderUI call: each one carries the whole spec so far', () => {
    const b = new ReplayBuffer()
    b.record({ type: 'tool.start', toolName: 'RenderUI', toolId: 'u1' })
    const at = b.state()
    b.record({ type: 'ui.render', toolId: 'u1', surfaceId: 's', partial: true, spec: { n: 1 } })
    b.record({ type: 'ui.render', toolId: 'u1', surfaceId: 's', partial: true, spec: { n: 2 } })
    b.record({ type: 'ui.render', toolId: 'u1', surfaceId: 's', partial: false, spec: { n: 3 } })
    const frames = b.since({ epoch: b.epoch, seq: at.seq, off: at.off }).frames.map(wire)
    // The final frame supersedes the last partial as a partial supersedes the one before it.
    expect(frames.map(f => f.spec.n)).toEqual([3])
    expect(frames.map(f => f.seq)).toEqual([4])
  })

  it('a partial of another call, or one after something else was drawn, is kept beside it', () => {
    const b = new ReplayBuffer()
    b.record({ type: 'ui.render', toolId: 'u1', surfaceId: 'a', partial: true, spec: { n: 1 } })
    b.record({ type: 'ui.render', toolId: 'u2', surfaceId: 'b', partial: true, spec: { n: 2 } })
    b.record({ type: 'stream.token', text: 'x' })
    b.record({ type: 'ui.render', toolId: 'u2', surfaceId: 'b', partial: true, spec: { n: 3 } })
    expect(b.since({ epoch: b.epoch, seq: 0, off: 0 }).frames.map(f => wire(f).spec?.n ?? 'tok')).toEqual([1, 2, 'tok', 3])
  })
})

describe('ReplayBuffer: bounds', () => {
  it('drops the oldest entries past the cap; a page that needed them is told so and sent nothing, not a tail with a hole in it', () => {
    const b = new ReplayBuffer({ maxEntries: 3, maxChars: 1_000_000 })
    for (let i = 1; i <= 5; i++) b.record({ type: 'tool.start', toolName: 'Read', toolId: 't' + i })
    expect(b.since({ epoch: b.epoch, seq: 1, off: 0 })).toEqual({ frames: [], gap: true, known: true })
    // A page that was already past what was dropped has no gap.
    expect(b.since({ epoch: b.epoch, seq: 2, off: 0 })).toMatchObject({ gap: false })
    expect(b.since({ epoch: b.epoch, seq: 4, off: 0 }).frames).toHaveLength(1)
  })

  it('bounds the characters held too, and never drops the entry still growing', () => {
    const b = new ReplayBuffer({ maxEntries: 1000, maxChars: 200 })
    b.record({ type: 'tool.start', toolName: 'Write', toolId: 'big', input: 'x'.repeat(150) })
    b.record(tok('y'.repeat(150)))
    b.record(tok('z'.repeat(150)))
    expect(b.since({ epoch: b.epoch, seq: 0, off: 0 })).toEqual({ frames: [], gap: true, known: true })
    // The run still growing was kept whole: a page that had the dropped entry is sent all of it.
    expect(b.since({ epoch: b.epoch, seq: 1, off: 0 }).frames.map(wire)).toEqual([{ type: 'stream.token', text: 'y'.repeat(150) + 'z'.repeat(150), seq: 2, off: 300 }])
  })
})

describe('parseCursor', () => {
  it('reads epoch, since and off from the socket URL; anything malformed is no cursor', () => {
    const q = (s: string) => new URL('http://x/ws?' + s).searchParams
    expect(parseCursor(q('token=t&epoch=abc-1&since=12&off=40'))).toEqual({ epoch: 'abc-1', seq: 12, off: 40 })
    expect(parseCursor(q('token=t&epoch=abc-1&since=12'))).toEqual({ epoch: 'abc-1', seq: 12, off: 0 })
    expect(parseCursor(q('token=t'))).toBeNull()
    expect(parseCursor(q('epoch=abc&since=-1'))).toBeNull()
    expect(parseCursor(q('epoch=abc&since=1.5'))).toBeNull()
    expect(parseCursor(q('epoch=abc&since=x'))).toBeNull()
    expect(parseCursor(q('epoch=&since=1'))).toBeNull()
    expect(parseCursor(q('epoch=' + 'e'.repeat(80) + '&since=1'))).toBeNull()
  })
})

describe('every frame the page handles is decided: replayed, or not and why', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
  const start = html.indexOf('function handleEvent(')
  const body = html.slice(start, html.indexOf('\nfunction summarizeInput(', start))
  const handled = [...body.matchAll(/^    case '([a-zA-Z0-9_.]+)':/gm)].map(m => m[1]!)

  it('finds the page\'s cases', () => { expect(handled.length).toBeGreaterThan(25) })

  it('no case is left undecided, and none is on both lists', () => {
    const undecided = handled.filter(t => !REPLAYED_TYPES.has(t) && !(t in NOT_REPLAYED_TYPES))
    expect(undecided, `add to REPLAYED_TYPES or NOT_REPLAYED_TYPES (with the reason) in engine/dashboard/replay.ts: ${undecided.join(', ')}`).toEqual([])
    expect([...REPLAYED_TYPES].filter(t => t in NOT_REPLAYED_TYPES)).toEqual([])
  })

  it('a decision still pending is drawn from /api/session, never from the replay: an answered card must not come back', () => {
    expect(REPLAYED_TYPES.has('approval.request')).toBe(false)
    expect(REPLAYED_TYPES.has('ask.request')).toBe(false)
    expect(NOT_REPLAYED_TYPES['approval.request']).toMatch(/pending/)
  })

  it('what draws the Chat pane is replayed', () => {
    for (const t of ['stream.token', 'stream.thinking', 'tool.start', 'tool.complete', 'file.diff', 'message.complete', 'ui.render', 'ui.image', 'session.error', 'project.citations', 'project.ingest']) {
      expect(REPLAYED_TYPES.has(t), t).toBe(true)
    }
  })
})
