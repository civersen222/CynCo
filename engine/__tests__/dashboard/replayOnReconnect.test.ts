/**
 * A page that lost its socket is sent what it missed (docs/NOW.md, "Rebuild
 * what streamed while the phone was away"; engine/dashboard/replay.ts).
 *
 * The server side, over real sockets: a client reads frames, drops, the turn
 * goes on, the client reconnects naming where it got to, and receives exactly
 * the frames it missed, in order, before the `replay.state` frame that says it
 * is caught up. Decisions still open ride /api/session `pending`, as before.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

type Frame = Record<string, any>

async function start(deps: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-replay-'))
  dirs.push(dir)
  const tokens = loadOrCreateTokens(dir)
  const server = new DashboardServer({ port: 0, tokens, deps: { remoteAddress: () => '127.0.0.1', ...deps } })
  servers.push(server)
  await new Promise(r => setTimeout(r, 50))
  const token = tokens.tokenFor('inference')!
  /** Open a socket; `frames` fills as they arrive, `caughtUp` resolves with the server's replay.state. */
  const connect = async (cursor?: { epoch: string; seq: number; off: number }) => {
    const q = cursor ? `&epoch=${cursor.epoch}&since=${cursor.seq}&off=${cursor.off}` : ''
    const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}/ws?token=${token}${q}`)
    const frames: Frame[] = []
    let settle: (f: Frame) => void = () => {}
    const caughtUp = new Promise<Frame>(res => { settle = res })
    ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString()) as Frame
      if (f.type === 'replay.state') settle(f); else frames.push(f)
    })
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
    const state = await caughtUp
    const close = () => new Promise<void>(res => { ws.on('close', () => res()); ws.close() })
    /** The cursor a page holds after the frames it has handled: the last numbered one. */
    const cursor0 = () => {
      const numbered = frames.filter(f => typeof f.seq === 'number')
      const last = numbered[numbered.length - 1]
      return last ? { epoch: state.epoch as string, seq: last.seq as number, off: (last.off ?? 0) as number } : { epoch: state.epoch as string, seq: state.seq as number, off: state.off as number }
    }
    return { ws, frames, state, close, cursor: cursor0 }
  }
  const settle = () => new Promise(r => setTimeout(r, 60))
  const say = (e: Frame) => server.broadcast(e as any)
  return { server, connect, settle, say, token, port: server.getPort() }
}

/** What a page would have drawn from these frames: text runs joined, everything else by type. */
const drawn = (frames: Frame[]) => frames.map(f => f.type === 'stream.token' || f.type === 'stream.thinking' ? `${f.type}:${f.text}` : f.type + (f.toolId ? `:${f.toolId}` : ''))

describe('a fresh page', () => {
  it('is told where the stream is and sent nothing from before it arrived', async () => {
    const t = await start()
    t.say({ type: 'stream.token', text: 'before anyone was here' })
    const page = await t.connect()
    expect(page.frames).toEqual([])
    expect(page.state).toMatchObject({ type: 'replay.state', reason: 'connect', seq: 1, off: 22, replayed: 0, gap: false, resumed: false })
    expect(page.state.epoch).toMatch(/^[0-9a-f]{12}-0$/)
  })

  it('live frames that draw the pane are numbered; the others arrive exactly as broadcast', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'stream.token', text: 'Hi' })
    t.say({ type: 'governance.status', health: 0.9 })
    t.say({ type: 'tool.start', toolName: 'Read', toolId: 't1' })
    await t.settle()
    expect(page.frames).toEqual([
      { type: 'stream.token', text: 'Hi', seq: 1, off: 2 },
      { type: 'governance.status', health: 0.9 },
      { type: 'tool.start', toolName: 'Read', toolId: 't1', seq: 2 },
    ])
  })
})

describe('a page that comes back', () => {
  it('is sent what the turn produced while its socket was down, in order, once, and then the live frames', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'stream.thinking', text: 'let me look' })
    t.say({ type: 'stream.token', text: 'I will read ' })
    await t.settle()
    const at = page.cursor()
    await page.close()

    // The turn goes on with nobody connected.
    t.say({ type: 'stream.token', text: 'the file.' })
    t.say({ type: 'tool.start', toolName: 'Read', toolId: 't1', input: { file_path: 'a.ts' } })
    t.say({ type: 'governance.status', health: 0.9 })
    t.say({ type: 'tool.complete', toolName: 'Read', toolId: 't1', isError: false })
    t.say({ type: 'file.diff', path: 'a.ts', changeType: 'modify', hunks: [] })
    t.say({ type: 'stream.token', text: 'Done' })

    const back = await t.connect(at)
    expect(back.state).toMatchObject({ epoch: at.epoch, replayed: 5, gap: false, resumed: true })
    expect(drawn(back.frames)).toEqual([
      'stream.token:the file.',
      'tool.start:t1',
      'tool.complete:t1',
      'file.diff',
      'stream.token:Done',
    ])
    // Together with what it had, the page has drawn the turn exactly once.
    expect(drawn([...page.frames, ...back.frames]).filter(l => l.startsWith('stream.token')).map(l => l.slice(13)).join(''))
      .toBe('I will read the file.Done')

    // And it is live again from there: the next token continues the run it was sent.
    t.say({ type: 'stream.token', text: '.' })
    t.say({ type: 'message.complete', stopReason: 'end_turn' })
    await t.settle()
    expect(back.frames.slice(-2)).toEqual([
      { type: 'stream.token', text: '.', seq: 6, off: 5 },
      { type: 'message.complete', stopReason: 'end_turn', seq: 7 },
    ])
    expect(back.state).toMatchObject({ seq: 6, off: 4 })
  })

  it('a turn that ended while it was away ends on the page too: message.complete is among the frames', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'stream.token', text: 'Working' })
    await t.settle()
    const at = page.cursor()
    await page.close()
    t.say({ type: 'stream.token', text: ' on it. All done.' })
    t.say({ type: 'message.complete', stopReason: 'end_turn' })
    const back = await t.connect(at)
    expect(drawn(back.frames)).toEqual(['stream.token: on it. All done.', 'message.complete'])
  })

  it('coming back twice sends nothing twice', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'tool.start', toolName: 'Bash', toolId: 'b1' })
    await t.settle()
    const at = page.cursor()
    await page.close()
    t.say({ type: 'tool.complete', toolName: 'Bash', toolId: 'b1' })
    const back = await t.connect(at)
    expect(drawn(back.frames)).toEqual(['tool.complete:b1'])
    const at2 = back.cursor()
    await back.close()
    const again = await t.connect(at2)
    expect(again.frames).toEqual([])
    expect(again.state).toMatchObject({ replayed: 0, resumed: true })
  })

  it('a decision asked while it was away is not replayed as a frame; /api/session `pending` still carries it', async () => {
    const pending = [{ kind: 'approval', requestId: 'r1', toolName: 'Bash', description: 'rm -rf build', risk: 'high' }]
    const t = await start({ getPendingDecisions: () => pending })
    const page = await t.connect()
    const at = page.cursor()
    await page.close()
    t.say({ type: 'tool.start', toolName: 'Bash', toolId: 'b1' })
    t.say({ type: 'approval.request', requestId: 'r1', toolName: 'Bash', description: 'rm -rf build', risk: 'high' })
    t.say({ type: 'ask.request', requestId: 'q1', question: 'Which one?' })
    const back = await t.connect(at)
    expect(drawn(back.frames)).toEqual(['tool.start:b1'])
    const session = await (await fetch(`http://127.0.0.1:${t.port}/api/session`, { headers: { Authorization: `Bearer ${t.token}` } })).json()
    expect(session.pending).toEqual(pending)
  })

  it('a connected page still receives a decision frame live, unnumbered', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'approval.request', requestId: 'r1', toolName: 'Bash' })
    await t.settle()
    expect(page.frames).toEqual([{ type: 'approval.request', requestId: 'r1', toolName: 'Bash' }])
  })
})

describe('when the replay cannot bridge the gap', () => {
  it('a change of conversation starts over: the returning page is sent no frames and the binding as on any connect', async () => {
    let project: { slug: string; chat: string | null; title: string | null } | null = null
    const t = await start({ currentProject: () => project })
    const page = await t.connect()
    t.say({ type: 'stream.token', text: 'coding session text' })
    await t.settle()
    const at = page.cursor()
    await page.close()
    // Another client opens a project chat and a turn runs in it.
    project = { slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' }
    t.say({ type: 'project.opened', ...project })
    t.say({ type: 'stream.token', text: 'project chat text' })
    const back = await t.connect(at)
    await t.settle()
    expect(back.state).toMatchObject({ replayed: 0, resumed: false, gap: false })
    expect(back.state.epoch).not.toBe(at.epoch)
    // The engine's word on what it holds, sent to every socket that connects, as before.
    expect(back.frames).toEqual([{ type: 'project.opened', slug: 'yard', chat: 'c1.jsonl', title: 'Diorama' }])
  })

  it('a page connected through the change is told the numbering started over, before the frame that changes the conversation', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'stream.token', text: 'coding' })
    t.say({ type: 'project.opened', slug: 'yard', chat: null, title: null })
    t.say({ type: 'stream.token', text: 'project' })
    await t.settle()
    // connect() files replay.state frames apart; read the raw order from a second listener instead.
    expect(page.frames).toEqual([
      { type: 'stream.token', text: 'coding', seq: 1, off: 6 },
      { type: 'project.opened', slug: 'yard', chat: null, title: null },
      { type: 'stream.token', text: 'project', seq: 1, off: 7 },
    ])
    const raw: Frame[] = []
    page.ws.on('message', (d: Buffer) => raw.push(JSON.parse(d.toString())))
    t.say({ type: 'project.opened', slug: null, chat: null, title: null })
    await t.settle()
    expect(raw.map(f => f.type)).toEqual(['replay.state', 'project.opened'])
    expect(raw[0]).toMatchObject({ reason: 'reset', seq: 0, off: 0, resumed: false })
    expect(raw[0]!.epoch).not.toBe(page.state.epoch)
  })

  it('too much went by: the page is told there is a gap and sent nothing', async () => {
    const t = await start()
    const page = await t.connect()
    t.say({ type: 'tool.start', toolName: 'Read', toolId: 'first' })
    await t.settle()
    const at = page.cursor()
    await page.close()
    for (let i = 0; i < 4100; i++) t.say({ type: 'tool.start', toolName: 'Read', toolId: 't' + i })
    const back = await t.connect(at)
    expect(back.frames).toEqual([])
    expect(back.state).toMatchObject({ replayed: 0, resumed: false, gap: true })
  })

  it('a cursor from another engine (a restart) is not resumed', async () => {
    const t = await start()
    t.say({ type: 'stream.token', text: 'x' })
    const back = await t.connect({ epoch: '000000000000-0', seq: 1, off: 0 })
    expect(back.frames).toEqual([])
    expect(back.state).toMatchObject({ replayed: 0, resumed: false })
  })

  it('a malformed cursor on the URL is ignored, never an error', async () => {
    const t = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws?token=${t.token}&epoch=%3Cscript%3E&since=NaN`)
    const first = await new Promise<Frame>((res, rej) => { ws.on('message', (d: Buffer) => res(JSON.parse(d.toString()))); ws.on('error', rej) })
    expect(first).toMatchObject({ type: 'replay.state', resumed: false })
    ws.close()
  })
})
