/**
 * The page's half of the replay (engine/dashboard/replay.ts): it remembers the
 * last numbered frame it handled, names it on the next socket's URL, drops any
 * frame at or before it, and settles its idea of the run only after the engine
 * has sent what it missed. Page functions, lifted by text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { ReplayBuffer } from '../../dashboard/replay.js'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
function scripts(): string {
  const out: string[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1]!)
  return out.join('\n')
}
function fnSource(name: string): string {
  const js = scripts()
  const start = js.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found`).toBeGreaterThan(-1)
  const close = /\r?\n\}\r?\n/.exec(js.slice(start))
  expect(close).not.toBeNull()
  return js.slice(start, start + close!.index + close![0].length)
}

type Cursor = { epoch: string | null; seq: number; off: number }

describe('replayQuery: what the page puts on the socket URL', () => {
  const replayQuery = new Function(`${fnSource('replayQuery')}; return replayQuery;`)() as (c: Cursor) => string
  it('nothing until the engine has told it an epoch', () => {
    expect(replayQuery({ epoch: null, seq: 0, off: 0 })).toBe('')
  })
  it('the cursor once it has one', () => {
    expect(replayQuery({ epoch: 'ab12cd34ef56-0', seq: 12, off: 40 })).toBe('&epoch=ab12cd34ef56-0&since=12&off=40')
  })
})

describe('replayAccept: nothing is drawn twice', () => {
  const replayAccept = new Function(`${fnSource('replayAccept')}; return replayAccept;`)() as (c: Cursor, e: Record<string, unknown>) => boolean
  it('a frame with no number is always handled and moves nothing', () => {
    const c = { epoch: 'e', seq: 4, off: 2 }
    expect(replayAccept(c, { type: 'governance.status' })).toBe(true)
    expect(c).toEqual({ epoch: 'e', seq: 4, off: 2 })
  })
  it('a numbered frame past the cursor is handled and becomes the cursor', () => {
    const c = { epoch: 'e', seq: 4, off: 0 }
    expect(replayAccept(c, { type: 'tool.start', seq: 5 })).toBe(true)
    expect(c).toEqual({ epoch: 'e', seq: 5, off: 0 })
    expect(replayAccept(c, { type: 'stream.token', text: 'ab', seq: 6, off: 2 })).toBe(true)
    expect(replayAccept(c, { type: 'stream.token', text: 'c', seq: 6, off: 3 })).toBe(true)
    expect(c).toEqual({ epoch: 'e', seq: 6, off: 3 })
  })
  it('a frame at or before the cursor is dropped', () => {
    const c = { epoch: 'e', seq: 6, off: 3 }
    expect(replayAccept(c, { type: 'tool.start', seq: 5 })).toBe(false)
    expect(replayAccept(c, { type: 'stream.token', text: 'c', seq: 6, off: 3 })).toBe(false)
    expect(replayAccept(c, { type: 'stream.token', text: 'b', seq: 6, off: 2 })).toBe(false)
    expect(c).toEqual({ epoch: 'e', seq: 6, off: 3 })
  })
})

describe('a page and the engine\'s buffer, end to end: the pane after a reconnect is the pane that never left', () => {
  const replayAccept = new Function(`${fnSource('replayAccept')}; return replayAccept;`)() as (c: Cursor, e: Record<string, unknown>) => boolean
  const replayQuery = new Function(`${fnSource('replayQuery')}; return replayQuery;`)() as (c: Cursor) => string

  /** A stand-in for the Chat pane: text runs append to the last bubble of their kind, everything else is a row. */
  function pane() {
    const rows: string[] = []
    let open: string | null = null
    return {
      rows,
      handle(e: Record<string, any>) {
        if (e.type === 'stream.token' || e.type === 'stream.thinking') {
          if (open === e.type) rows[rows.length - 1] += e.text
          else { rows.push(`${e.type}> ${e.text}`); open = e.type }
        } else { rows.push(e.type + (e.toolId ? ' ' + e.toolId : '')); open = null }
      },
    }
  }

  const TURN: Record<string, any>[] = [
    { type: 'stream.thinking', text: 'The user ' }, { type: 'stream.thinking', text: 'wants a list.' },
    { type: 'stream.token', text: 'Here ' }, { type: 'stream.token', text: 'is ' }, { type: 'stream.token', text: 'the plan' },
    { type: 'governance.status', health: 1 },
    { type: 'tool.start', toolName: 'Read', toolId: 't1' }, { type: 'tool.complete', toolName: 'Read', toolId: 't1' },
    { type: 'stream.token', text: 'First, ' }, { type: 'stream.token', text: 'paint.' },
    { type: 'ui.render', toolId: 'u1', surfaceId: 's', partial: true, spec: {} },
    { type: 'ui.render', toolId: 'u1', surfaceId: 's', partial: false, spec: {} },
    { type: 'message.complete', stopReason: 'end_turn' },
  ]

  /** Run TURN with the socket down between frames `from` and `to` (exclusive); returns what the page drew. */
  function runWithOutage(from: number, to: number): string[] {
    const buffer = new ReplayBuffer()
    const cursor: Cursor = { epoch: null, seq: 0, off: 0 }
    const p = pane()
    const deliver = (json: string) => { const e = JSON.parse(json); if (replayAccept(cursor, e)) p.handle(e) }
    const adopt = () => { const s = buffer.state(); cursor.epoch = s.epoch; cursor.seq = s.seq; cursor.off = s.off }
    adopt() // the first connect's replay.state
    TURN.forEach((e, i) => {
      const json = buffer.record(e) ?? JSON.stringify(e)
      if (i < from || i >= to) deliver(json)
      if (i === to - 1) {
        // The socket reopens: the page names its cursor, the engine sends what it missed.
        const q = new URLSearchParams(replayQuery(cursor))
        const missed = buffer.since({ epoch: q.get('epoch')!, seq: Number(q.get('since')), off: Number(q.get('off')) })
        expect(missed.known).toBe(true)
        for (const m of missed.frames) deliver(m)
        // A late duplicate of the last live frame must change nothing.
        for (const m of missed.frames.slice(-1)) deliver(m)
      }
    })
    return p.rows
  }

  const never = runWithOutage(0, 0)
  it('the reference run draws the turn', () => {
    expect(never).toEqual([
      'stream.thinking> The user wants a list.',
      'stream.token> Here is the plan',
      'governance.status',
      'tool.start t1', 'tool.complete t1',
      'stream.token> First, paint.',
      'ui.render u1', 'ui.render u1',
      'message.complete',
    ])
  })

  // Every outage window over the turn: the numbered frames it covers are redelivered exactly.
  for (let from = 0; from < TURN.length; from++) {
    for (let to = from + 1; to <= TURN.length; to++) {
      it(`socket down for frames ${from}..${to - 1}: same text, same rows, nothing twice`, () => {
        const rows = runWithOutage(from, to)
        // Frames that are not replayed (a status snapshot) and a superseded partial surface may be absent; nothing else may differ.
        const essential = (r: string[]) => r.filter(x => x !== 'governance.status' && x !== 'ui.render u1')
        expect(essential(rows)).toEqual(essential(never))
        expect(rows.filter(x => x === 'ui.render u1').length).toBeGreaterThanOrEqual(1)
        expect(rows.filter(x => x === 'ui.render u1').length).toBeLessThanOrEqual(2)
      })
    }
  }
})

describe('settling the run state waits for the replay', () => {
  function page(over: Record<string, unknown> = {}) {
    const lines: string[] = []
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const projectsState: Record<string, any> = { active: null, renderedChat: null }
    const make = new Function('appendChatMsg', 'projectsState', 'setTimeout', 'clearTimeout',
      'var replayCursor = { epoch: null, seq: 0, off: 0 }; var replayWait = { settled: true, queue: [], timer: null };\n' +
      fnSource('replayOnOpen') + fnSource('replayTouch') + fnSource('whenReplayed') + fnSource('replaySettle') + fnSource('onReplayState') + fnSource('replayLost') +
      '\nreturn { replayOnOpen: replayOnOpen, replayTouch: replayTouch, whenReplayed: whenReplayed, onReplayState: onReplayState, cursor: function() { return replayCursor; }, wait: function() { return replayWait; } };')
    const p = make(
      (role: string, text: string) => lines.push(`${role}: ${text}`),
      Object.assign(projectsState, over),
      (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length },
      (id: number) => { if (id && timers[id - 1]) timers[id - 1]!.cleared = true },
    )
    const fire = () => { const t = timers.filter(x => !x.cleared).pop(); if (t) { t.cleared = true; t.fn() } }
    return { ...p, lines, timers, fire, projectsState }
  }
  const STATE = { type: 'replay.state', reason: 'connect', epoch: 'e-0', seq: 3, off: 0, replayed: 0, resumed: false, gap: false }

  it('with no socket opening, a settle runs at once', () => {
    const p = page()
    let ran = 0
    p.whenReplayed(() => ran++)
    expect(ran).toBe(1)
  })

  it('after a socket opens, the settle is held until replay.state, then runs once', () => {
    const p = page()
    let ran = 0
    p.replayOnOpen()
    p.whenReplayed(() => ran++)
    expect(ran).toBe(0)
    p.onReplayState(STATE)
    expect(ran).toBe(1)
    expect(p.cursor()).toEqual({ epoch: 'e-0', seq: 3, off: 0 })
    p.onReplayState(STATE)
    expect(ran).toBe(1)
  })

  it('an engine that never says is not waited on for ever: quiet for 1.5 s settles it, and frames arriving push that back', () => {
    const p = page()
    let ran = 0
    p.replayOnOpen()
    p.whenReplayed(() => ran++)
    expect(p.timers[p.timers.length - 1]!.ms).toBe(1500)
    const before = p.timers.length
    p.replayTouch() // a missed frame arrived: the replay is still coming
    expect(p.timers.length).toBe(before + 1)
    expect(p.timers[before - 1]!.cleared).toBe(true)
    expect(ran).toBe(0)
    p.fire()
    expect(ran).toBe(1)
    p.replayTouch() // settled: no timer is started for live frames
    expect(p.timers.length).toBe(before + 1)
  })

  it('a settle queued for a socket that closed first is dropped when the next one opens', () => {
    const p = page()
    const ran: string[] = []
    p.replayOnOpen()
    p.whenReplayed(() => ran.push('stale'))
    p.replayOnOpen()
    p.whenReplayed(() => ran.push('fresh'))
    p.onReplayState(STATE)
    expect(ran).toEqual(['fresh'])
  })

  it('a first connect, and a resumed one, say nothing and redraw nothing', () => {
    const p = page({ active: { slug: 'yard', chat: 'c1.jsonl' }, renderedChat: 'yard/c1.jsonl' })
    p.replayOnOpen(); p.onReplayState(STATE)
    p.replayOnOpen(); p.onReplayState({ ...STATE, seq: 9, replayed: 6, resumed: true })
    expect(p.lines).toEqual([])
    expect(p.projectsState.renderedChat).toBe('yard/c1.jsonl')
    expect(p.cursor().seq).toBe(9)
  })

  it('a page that was here and could not be caught up, in a project chat: the chat is redrawn from its stored transcript', () => {
    const p = page({ active: { slug: 'yard', chat: 'c1.jsonl' }, renderedChat: 'yard/c1.jsonl' })
    p.replayOnOpen(); p.onReplayState(STATE)
    p.replayOnOpen(); p.onReplayState({ ...STATE, epoch: 'f-0', seq: 0 }) // a restarted engine
    // onProjectOpened redraws a bound chat the pane does not hold; forgetting which one it holds is how that is asked for.
    expect(p.projectsState.renderedChat).toBeNull()
    expect(p.lines).toEqual([])
    expect(p.cursor()).toEqual({ epoch: 'f-0', seq: 0, off: 0 })
  })

  it('…in the coding session with a gap: said in the pane, nothing invented', () => {
    const p = page()
    p.replayOnOpen(); p.onReplayState(STATE)
    p.replayOnOpen(); p.onReplayState({ ...STATE, seq: 9000, gap: true })
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0]).toMatch(/^system: More went by while this page was away than the engine keeps/)
  })

  it('a change of conversation while connected only moves the cursor', () => {
    const p = page({ active: { slug: 'yard', chat: 'c1.jsonl' }, renderedChat: 'yard/c1.jsonl' })
    p.replayOnOpen(); p.onReplayState(STATE)
    p.onReplayState({ ...STATE, reason: 'reset', epoch: 'e-1', seq: 0 })
    expect(p.cursor()).toEqual({ epoch: 'e-1', seq: 0, off: 0 })
    expect(p.projectsState.renderedChat).toBe('yard/c1.jsonl')
    expect(p.lines).toEqual([])
  })
})

describe('wiring in the page', () => {
  const js = scripts()
  it('the socket URL carries the cursor, the open starts the wait, and every frame passes the duplicate guard before handleEvent', () => {
    const connect = fnSource('connectWS')
    expect(connect).toContain('replayQuery(replayCursor)')
    const onopen = connect.slice(connect.indexOf('ws.onopen = function()'), connect.indexOf('ws.onclose'))
    expect(onopen.indexOf('replayOnOpen()')).toBeGreaterThan(-1)
    expect(onopen.indexOf('replayOnOpen()')).toBeLessThan(onopen.indexOf('fetchSessionState()'))
    const onmessage = connect.slice(connect.indexOf('ws.onmessage = function'))
    expect(onmessage).toContain("event.type === 'replay.state'")
    expect(onmessage.indexOf('replayAccept(replayCursor, event)')).toBeGreaterThan(-1)
    expect(onmessage.indexOf('replayAccept(replayCursor, event)')).toBeLessThan(onmessage.indexOf('handleEvent(event)'))
  })
  it('fetchSessionState settles the run through whenReplayed', () => {
    expect(fnSource('fetchSessionState')).toMatch(/whenReplayed\(function\(\) \{ applyRunState\(data\); \}\)/)
  })
  it('the page-level state exists once', () => {
    expect(js.split('var replayCursor = ').length).toBe(2)
    expect(js.split('var replayWait = ').length).toBe(2)
  })
})
