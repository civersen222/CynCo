// The driver's main() against a scripted dashboard socket: a `ws` server on
// port 0 plays the engine (project.open → project.opened, user.message → a
// frame sequence) and each scenario asserts the exit code and the log lines.
// This is where the wiring lives that the pure-function tests cannot see: the
// turn's end, exit 4 on a refusal, the re-queued picture, another turn's
// frames after ours, pictures already made and the hold's self-close guard.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { main } from '../project-chat-drive.mjs'

const TOKEN = 'dash-token-for-tests'
const HOME = mkdtempSync(join(tmpdir(), 'pcd-socket-'))
writeFileSync(join(HOME, 'tokens.json'), JSON.stringify({ tokens: [{ name: 'mission', secret: 'not-this-one', scopes: ['admin'] }, { name: 'dashboard', secret: TOKEN, scopes: ['read'] }] }))
const ENV = { CYNCO_HOME: HOME }

const K1 = '0123456789abcdef'.repeat(2)
const K2 = 'fedcba9876543210'.repeat(2)
const K3 = '13579bdf02468ace'.repeat(2)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const NOTE = (n) => `Pictures: ${n} generating — they appear in their cards by themselves; do not call RenderUI again for them.`
/** The engine's note for a call whose pictures were all made before (engine/imagegen/service.ts annotateInner), and for a mix. */
const MADE_NOTE = (n) => `Pictures: ${n} already made — shown in their cards.`
const MIX_NOTE = (q, c) => `Pictures: ${q} generating, ${c} already made — they appear in their cards by themselves; do not call RenderUI again for them.`
const img = (prompt, seed, key, status = 'queued') => ({ type: 'Image', props: { prompt, seed }, image: { status, key } })
/** One RenderUI call as the loop sends it: tool.start, a partial frame, the final frame (before tool.complete), tool.complete. */
const renderCall = (toolId, images, note) => {
  const elements = { g: { type: 'Grid', children: Object.keys(images) }, ...images }
  return [
    { type: 'tool.start', toolId, toolName: 'RenderUI', input: { surface: 's', spec: { root: 'g', elements } } },
    { type: 'ui.render', toolId, surfaceId: 's', partial: true, spec: { root: 'g', elements: { g: elements.g } } },
    { type: 'ui.render', toolId, surfaceId: 's', partial: false, spec: { root: 'g', elements } },
    { type: 'tool.complete', toolId, toolName: 'RenderUI', isError: false, result: `Rendered ${Object.keys(elements).length} elements. (surface: s)\n${note}` },
  ]
}
const image = (key, status, extra = {}) => ({ type: 'ui.image', key, status, ...extra })
const COMPLETE = { type: 'message.complete', messageId: 'm1', stopReason: 'end_turn' }
const FIDELITY = { type: 'governance.session_fidelity', fidelity: 0.9 }
const TWO_TAKES = renderCall('t1', { i1: img('a red front door, morning light', 11, K1), i2: img('a blue front door, dusk', 12, K2) }, NOTE(2))

/**
 * The engine's end of the dashboard socket. `onOpen(frame)` answers our
 * project.open (default: project.opened for that slug, a new chat); `script`
 * is played on our user.message — a frame object is sent, a function is
 * awaited with the socket (for a pause, a probe or a close).
 */
async function fakeEngine({ onOpen, script = [] } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' })
  await once(wss, 'listening')
  const engine = { got: [], url: null, closedAt: null, closed: null }
  let closedResolve
  engine.closed = new Promise(r => { closedResolve = r })
  wss.on('connection', (sock, req) => {
    engine.url = req.url
    sock.on('close', () => { engine.closedAt = Date.now(); closedResolve() })
    sock.on('message', async (data) => {
      const f = JSON.parse(String(data))
      engine.got.push(f)
      const steps = f.type === 'project.open' ? (onOpen ?? ((o) => [{ type: 'project.opened', slug: o.slug, chat: null, title: 'Front yard' }]))(f)
        : f.type === 'user.message' ? script : []
      for (const step of steps) {
        if (typeof step === 'function') await step(sock)
        else if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(step))
      }
    })
  })
  engine.base = `http://127.0.0.1:${wss.address().port}`
  engine.stop = () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) })
  return engine
}

let logs = []
let engines = []
const has = (re) => logs.some(l => re.test(l))
const indexOf = (re) => logs.findIndex(l => re.test(l))
/** The verdict's FAIL lines, one per failed criterion (timestamp, then "FAIL <criterion>"). */
const failedCriteria = () => logs.filter(l => /\.\d{3} FAIL /.test(l))
const waitForLog = async (re, ms = 3000) => { const end = Date.now() + ms; while (!has(re)) { if (Date.now() > end) throw new Error(`no log line ${re}`); await sleep(10) } }
const summaryPath = () => join(mkdtempSync(join(tmpdir(), 'pcd-summary-')), 'run.json')
const readSummary = (file) => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.map(String).join(' ')) })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const e of engines) await e.stop()
  engines = []
})

async function drive(opts, extra = []) {
  const engine = await fakeEngine(opts)
  engines.push(engine)
  const code = await main(['--slug', 'front-yard-diorama', '--new', '--message', 'show me two takes of the front door', '--base', engine.base, ...extra], { env: ENV, settleMs: 10 })
  return { code, engine }
}

describe('project-chat-drive: main() against a scripted socket', () => {
  it('(a) happy path: two pictures generated, the turn ends on end_turn → every criterion PASS, exit 0', async () => {
    const { code, engine } = await drive({ script: [...TWO_TAKES, image(K1, 'running'), image(K2, 'running'), image(K1, 'done'), image(K2, 'done'), COMPLETE, FIDELITY] })
    expect(code).toBe(0)
    // The dashboard token from CYNCO_HOME/tokens.json, then project.open (no chat: a new one), then the message.
    expect(engine.url).toBe(`/ws?token=${TOKEN}`)
    expect(engine.got).toEqual([{ type: 'project.open', slug: 'front-yard-diorama' }, { type: 'user.message', text: 'show me two takes of the front door' }])
    expect(has(/PASS a final RenderUI frame with prompted Images carrying a seed: 1 final frame\(s\), 2 prompted Image\(s\), 2 with a seed/)).toBe(true)
    expect(has(/PASS a RenderUI result says the pictures are generating or already made: Pictures: 2 generating — /)).toBe(true)
    expect(has(/PASS the turn ended: stop=end_turn at \+/)).toBe(true)
    expect(has(/PASS every picture of the turn reached done: 2 picture\(s\): 2 done, 0 failed, 0 pending/)).toBe(true)
    expect(has(/\[driver\] verdict: PASS \(7\/7 criteria\), exit 0/)).toBe(true)
    expect(failedCriteria()).toEqual([])
  })

  it('(b) project.open refused → exit 4, no user.message sent', async () => {
    const { code, engine } = await drive({ onOpen: () => [{ type: 'session.error', error: 'project.open refused: no such project' }] })
    expect(code).toBe(4)
    expect(has(/\[driver\] finished: project\.open refused — project\.open refused: no such project/)).toBe(true)
    expect(engine.got.map(f => f.type)).toEqual(['project.open'])
  })

  it('(c) the socket refuses our user.message → exit 4, naming the frame', async () => {
    const { code } = await drive({ script: [{ type: 'session.error', error: 'command frame refused: user.message: text must be a string' }] })
    expect(code).toBe(4)
    expect(has(/\[driver\] finished: the engine refused our user\.message frame — user\.message: text must be a string/)).toBe(true)
  })

  it('(c2) a refusal that names no frame → exit 4 as "a command frame", not the user.message', async () => {
    const { code } = await drive({ script: [{ type: 'session.error', error: 'command frame refused: frame is not valid JSON' }] })
    expect(code).toBe(4)
    expect(has(/\[driver\] finished: the engine refused a command frame — frame is not valid JSON/)).toBe(true)
    expect(has(/refused (our|the) user\.message/)).toBe(false)
  })

  it('(d) a stream cut: session.error then session_fidelity, no message.complete → exit 1, "the turn ended" FAIL naming the error', async () => {
    const { code } = await drive({ script: [...renderCall('t1', { i1: img('a red front door', 3, K1) }, NOTE(1)), image(K1, 'done'), { type: 'session.error', error: 'stream cut: socket hang up' }, FIDELITY] })
    expect(code).toBe(1)
    expect(has(/ FAIL the turn ended: session\.error at \+\s*[\d.]+s: stream cut: socket hang up/)).toBe(true)
    expect(failedCriteria()).toHaveLength(1)
    expect(has(/\[driver\] verdict: FAIL \(6\/7 criteria\), exit 1/)).toBe(true)
  })

  it('(e) an aborted turn: session_fidelity only → exit 1, "the turn ended" FAIL as aborted', async () => {
    const { code } = await drive({ script: [...renderCall('t1', { i1: img('a red front door', 3, K1) }, NOTE(1)), image(K1, 'done'), FIDELITY] })
    expect(code).toBe(1)
    expect(has(/ FAIL the turn ended: aborted: governance\.session_fidelity at \+/)).toBe(true)
    expect(failedCriteria()).toHaveLength(1)
  })

  it('(e2) a halted turn and one stopped at max_iterations → exit 1', async () => {
    for (const stopReason of ['halted', 'max_iterations']) {
      logs.length = 0
      const { code } = await drive({ script: [...renderCall('t1', { i1: img('a red front door', 3, K1) }, NOTE(1)), image(K1, 'done'), { ...COMPLETE, stopReason }, FIDELITY] })
      expect(code, stopReason).toBe(1)
      expect(has(stopReason === 'halted' ? / FAIL the turn ended: halted: message\.complete stop=halted/ : / FAIL the turn ended: stopped at max_iterations/), stopReason).toBe(true)
    }
  })

  it('(e3) the stuck-loop halt, which ends with stop=end_turn → exit 1', async () => {
    const halt = { type: 'stream.token', messageId: '', text: '\n\n---\n**Session halted** — stuck for 15 turns without progress. Send a message to redirect.\n' }
    const { code } = await drive({ script: [...renderCall('t1', { i1: img('a red front door', 3, K1) }, NOTE(1)), image(K1, 'done'), halt, COMPLETE, FIDELITY] })
    expect(code).toBe(1)
    expect(has(/ FAIL the turn ended: halted: the stuck-loop halt at \+/)).toBe(true)
  })

  it('(f) a picture that failed and a later final frame re-queued → waits for it, exit 0 only after the second done', async () => {
    const probe = {}
    const door = () => ({ i1: img('a red front door, morning light', 7, K1) })
    const { code } = await drive({
      script: [
        ...renderCall('t1', door(), NOTE(1)),
        image(K1, 'running'), image(K1, 'failed', { reason: 'ComfyUI is not running' }),
        ...renderCall('t2', door(), NOTE(1)),
        COMPLETE, FIDELITY,
        async () => { await sleep(300); probe.finishedBeforeSecondDone = has(/\[driver\] finished/) },
        image(K1, 'running'), image(K1, 'done'),
      ],
    })
    expect(probe.finishedBeforeSecondDone).toBe(false)
    expect(code).toBe(0)
    expect(has(/picture 01234567 re-requested after it failed \(ComfyUI is not running\) → queued; waiting for it again \(1 pending\)/)).toBe(true)
    const done = indexOf(/ui\.image 01234567 done/)
    expect(done).toBeGreaterThan(-1)
    expect(indexOf(/\[driver\] finished: the turn ended and every picture is settled/)).toBeGreaterThan(done)
    expect(has(/PASS every picture of the turn reached done: 1 picture\(s\): 1 done, 0 failed, 0 pending; 0 not generated; 1 re-requested after settling/)).toBe(true)
  })

  it('(h) frames after the turn ended are another turn\'s: a later message.complete, session.error or session_fidelity changes nothing → exit 0', async () => {
    const summary = summaryPath()
    const { code } = await drive({
      script: [
        ...TWO_TAKES,
        // Another tab's refused open, broadcast while our turn runs: not ours either.
        { type: 'session.error', error: 'project.open refused: no such project' },
        COMPLETE, FIDELITY,
        // A gap, so our turn's end and the other turn's are told apart by time.
        async () => { await sleep(150) },
        // Another turn (a queued click, the operator typing on the page) while our pictures generate.
        { type: 'message.complete', messageId: 'm2', stopReason: 'max_iterations' },
        { type: 'session.error', error: 'stream cut: the batch did not run' },
        FIDELITY,
        image(K1, 'done'), image(K2, 'done'),
      ],
    }, ['--summary', summary])
    expect(code).toBe(0)
    expect(has(/session\.error \(another tab's project\.open; not this turn's\): project\.open refused: no such project/)).toBe(true)
    expect(has(/message\.complete \(after our turn ended; not this turn's\): stop=max_iterations/)).toBe(true)
    expect(has(/session\.error \(after our turn ended; not this turn's\): stream cut: the batch did not run/)).toBe(true)
    expect(has(/governance\.session_fidelity \(after our turn ended; not this turn's\): another turn ended/)).toBe(true)
    expect(logs.filter(l => /governance\.session_fidelity: the turn ended/.test(l))).toHaveLength(1)
    expect(has(/PASS the turn ended: stop=end_turn/)).toBe(true)
    expect(has(/PASS no "did not run": none/)).toBe(true)
    expect(has(/\[driver\] verdict: PASS \(7\/7 criteria\), exit 0/)).toBe(true)
    // The turn's end is ours, not the later turn's: its stop, its time, and the timeline's.
    const sum = readSummary(summary)
    expect(sum.turnEnded).toMatchObject({ stopReason: 'end_turn', error: null })
    expect(sum.complete.stopReason).toBe('end_turn')
    expect(sum.notOurs.map(n => n.type)).toEqual(['session.error', 'message.complete', 'session.error', 'governance.session_fidelity'])
    const later = sum.notOurs.find(n => n.type === 'governance.session_fidelity')
    expect(later.at - sum.turnEnded.at).toBeGreaterThanOrEqual(100)
    const t0 = Date.parse(sum.startedAt)
    expect(Math.abs(sum.timeline.turnEndedS - (sum.turnEnded.at - t0) / 1000)).toBeLessThanOrEqual(0.051)
    expect(sum.timeline.turnEndedS).toBeLessThan((later.at - t0) / 1000 - 0.05)
  })

  it('(i) another turn after ours (a click re-dispatched after the turn, the operator typing): its Bash call, cards, surface and picture are not ours → exit 0, 7/7, done once our pictures are', async () => {
    const summary = summaryPath()
    const probe = {}
    let probed
    const probeDone = new Promise(r => { probed = r })
    const { code, engine } = await drive({
      script: [
        ...TWO_TAKES,
        // A second surface of ours that streamed and never got its final frame.
        { type: 'ui.render', toolId: 't2', surfaceId: 's2', partial: true, spec: { root: 'g', elements: { g: { type: 'Grid' } } } },
        COMPLETE, FIDELITY,
        // runTurn's finally withdraws it (closePendingUiSurfaces) AFTER session_fidelity: a known surface, still ours.
        { type: 'ui.render', toolId: 't2', surfaceId: 's2', partial: false, spec: null, errors: ['the turn ended before this surface was finished'] },
        // The other turn: a Bash call, an approval card, an AskUser card, a RenderUI call with a new picture K3, its own end.
        { type: 'tool.start', toolId: 'o1', toolName: 'Bash', input: { command: 'curl -s http://127.0.0.1:8188/prompt' } },
        { type: 'tool.complete', toolId: 'o1', toolName: 'Bash', isError: true, result: 'refused: a project chat does not drive ComfyUI' },
        { type: 'approval.request', requestId: 'r9', toolName: 'Bash', description: 'curl the image server', risk: 'risky' },
        { type: 'ask.request', requestId: 'q9', question: 'Paint another take?', options: ['No', 'Yes, one more'] },
        { type: 'tool.start', toolId: 'o2', toolName: 'RenderUI', input: { surface: 's3', spec: { root: 'g', elements: {} } } },
        { type: 'ui.render', toolId: 'o2', surfaceId: 's3', partial: true, spec: { root: 'g', elements: { g: { type: 'Grid' } } } },
        { type: 'ui.render', toolId: 'o2', surfaceId: 's3', partial: true, spec: { root: 'g', elements: { g: { type: 'Grid' } } } },
        { type: 'ui.render', toolId: 'o2', surfaceId: 's3', partial: false, spec: { root: 'g', elements: { g: { type: 'Grid', children: ['i3'] }, i3: img('a green front door, noon', 13, K3) } } },
        { type: 'tool.complete', toolId: 'o2', toolName: 'RenderUI', isError: false, result: `Rendered 2 elements. (surface: s3)\n${NOTE(1)}` },
        { type: 'message.complete', messageId: 'm2', stopReason: 'end_turn' }, FIDELITY,
        image(K1, 'running'), image(K1, 'done'), image(K2, 'running'), image(K2, 'done'),
        // Before the other turn's picture settles: our run has finished already.
        async () => { probe.finishedBeforeK3 = await waitForLog(/\[driver\] finished/, 1000).then(() => true, () => false); probed() },
        image(K3, 'running'), image(K3, 'done'),
      ],
    }, ['--summary', summary])
    expect(code).toBe(0)
    await probeDone
    expect(probe.finishedBeforeK3).toBe(true)
    expect(indexOf(/\[driver\] finished: the turn ended and every picture is settled/)).toBeGreaterThan(indexOf(/ui\.image fedcba98 done/))
    expect(has(/ui\.image 13579bdf/)).toBe(false)
    // The other turn's frames: logged as not ours, never counted.
    expect(has(/tool\.start \(after our turn ended; not this turn's\): Bash command: curl -s http:\/\/127\.0\.0\.1:8188\/prompt/)).toBe(true)
    expect(has(/tool\.complete \(after our turn ended; not this turn's\): Bash isError=true: refused: a project chat does not drive ComfyUI/)).toBe(true)
    expect(has(/approval\.request \(after our turn ended; not this turn's\): Bash risk=risky: curl the image server → answered approved:false/)).toBe(true)
    expect(has(/ask\.request \(after our turn ended; not this turn's\): Paint another take\? options=\["No","Yes, one more"\] → answered "Yes, one more"/)).toBe(true)
    expect(has(/approval\.request FAIL-MARK/)).toBe(false)
    // A card the engine waits on is still answered.
    expect(engine.got).toContainEqual({ type: 'approval.response', requestId: 'r9', approved: false })
    expect(engine.got).toContainEqual({ type: 'ask.answer', requestId: 'q9', answer: 'Yes, one more' })
    // The other surface: its first partial and its final frame, one line each.
    expect(logs.filter(l => /ui\.render \(after our turn ended; not this turn's\): .*toolId=o2/.test(l))).toHaveLength(2)
    expect(has(/ui\.render \(after our turn ended; not this turn's\): FINAL surface=s3 toolId=o2 Grid×1 Image×1; prompted Images: 1/)).toBe(true)
    // Our own surface's terminal frame after session_fidelity is kept.
    expect(has(/ui\.render FINAL surface=s2 spec=null errors=\["the turn ended before this surface was finished"\]/)).toBe(true)
    // The verdict: our turn only.
    expect(has(/PASS no Bash call: none/)).toBe(true)
    expect(has(/PASS no approval\.request: none/)).toBe(true)
    expect(has(/PASS a RenderUI result says the pictures are generating or already made: Pictures: 2 generating — /)).toBe(true)
    expect(has(/PASS every picture of the turn reached done: 2 picture\(s\): 2 done, 0 failed, 0 pending; 0 not generated$/)).toBe(true)
    expect(has(/\[driver\] verdict: PASS \(7\/7 criteria\), exit 0/)).toBe(true)
    expect(failedCriteria()).toEqual([])
    const sum = readSummary(summary)
    expect(sum.tools.map(t => `${t.toolId} ${t.name}`)).toEqual(['t1 RenderUI'])
    expect(sum.surfaces.map(s => s.toolId)).toEqual(['t1', 't2'])
    expect(sum.pictures.map(p => p.key)).toEqual([K1, K2])
    expect(sum.approvals).toEqual([])
    expect(sum.asks).toEqual([])
    expect(sum.turnEnded).toMatchObject({ stopReason: 'end_turn', error: null })
    expect(sum.notOurs.map(n => n.type)).toEqual(['tool.start', 'tool.complete', 'approval.request', 'ask.request', 'tool.start', 'ui.render', 'ui.render', 'tool.complete', 'message.complete', 'governance.session_fidelity'])
  })

  it('(j) every picture already made (the same prompts and seeds again): done at the frame, no ui.image → exit 0, both picture criteria PASS as already made', async () => {
    const { code } = await drive({
      script: [
        ...renderCall('t1', { i1: img('a red front door, morning light', 11, K1, 'done'), i2: img('a blue front door, dusk', 12, K2, 'done') }, MADE_NOTE(2)),
        COMPLETE, FIDELITY,
      ],
    })
    expect(code).toBe(0)
    expect(has(/PASS a RenderUI result says the pictures are generating or already made: Pictures: 2 already made \(nothing painted this run\)$/)).toBe(true)
    expect(has(/PASS every picture of the turn reached done: 2 picture\(s\): 2 done, 0 failed, 0 pending; 0 not generated; 2 already made at the frame \(nothing painted this run\)$/)).toBe(true)
    expect(has(/\[driver\] finished: the turn ended and every picture is settled/)).toBe(true)
    expect(has(/\[driver\] verdict: PASS \(7\/7 criteria\), exit 0/)).toBe(true)
    expect(failedCriteria()).toEqual([])
  })

  it('(j2) a mix: one picture already made, one painted → exit 0, the evidence names both', async () => {
    const { code } = await drive({
      script: [
        ...renderCall('t1', { i1: img('a red front door, morning light', 11, K1, 'done'), i2: img('a blue front door, dusk', 12, K2) }, MIX_NOTE(1, 1)),
        image(K2, 'running'), COMPLETE, FIDELITY, image(K2, 'done'),
      ],
    })
    expect(code).toBe(0)
    expect(indexOf(/\[driver\] finished: the turn ended and every picture is settled/)).toBeGreaterThan(indexOf(/ui\.image fedcba98 done/))
    expect(has(/PASS a RenderUI result says the pictures are generating or already made: Pictures: 1 generating, 1 already made — /)).toBe(true)
    expect(has(/PASS every picture of the turn reached done: 2 picture\(s\): 2 done, 0 failed, 0 pending; 0 not generated; 1 already made at the frame$/)).toBe(true)
    expect(has(/\[driver\] verdict: PASS \(7\/7 criteria\), exit 0/)).toBe(true)
    expect(failedCriteria()).toEqual([])
  })

  it('(k) a job of another project for the same key (a key does not name the project) is not ours: the driver waits for our own done → exit 0', async () => {
    const { code } = await drive({
      script: [
        ...renderCall('t1', { i1: img('a red front door, morning light', 11, K1) }, NOTE(1)),
        image(K1, 'running', { slug: 'front-yard-2' }), image(K1, 'done', { slug: 'front-yard-2' }),
        COMPLETE, FIDELITY,
        async () => { await sleep(150) },
        image(K1, 'running', { slug: 'front-yard-diorama' }), image(K1, 'done', { slug: 'front-yard-diorama' }),
      ],
    })
    expect(code).toBe(0)
    expect(has(/ui\.image 01234567 running \(another project's, slug=front-yard-2; not this turn's\)/)).toBe(true)
    expect(has(/ui\.image 01234567 done \(another project's, slug=front-yard-2; not this turn's\)/)).toBe(true)
    // finished only after our own project's done, not on the other project's
    expect(indexOf(/\[driver\] finished: the turn ended and every picture is settled/)).toBeGreaterThan(indexOf(/ui\.image 01234567 done \(\d/))
    expect(has(/\[driver\] verdict: PASS \(7\/7 criteria\), exit 0/)).toBe(true)
  })

  it('(g) --hold-min: the engine closing the socket during the hold is logged as the engine going away', async () => {
    const { code, engine } = await drive({
      script: [
        ...TWO_TAKES, image(K1, 'done'), image(K2, 'done'), COMPLETE, FIDELITY,
        async (sock) => { await waitForLog(/holding the socket open/); sock.close(1012, 'engine restarting') },
      ],
    }, ['--hold-min', '1'])
    expect(code).toBe(0)
    await engine.closed
    expect(has(/\[driver\] socket closed code=1012 reason=engine restarting/)).toBe(true)
    expect(has(/\[driver\] \(holding: the engine went away under an open socket\)/)).toBe(true)
  })

  it('(g2) --hold-min: a hold that ends on its own closes the socket itself, with no "went away" line', async () => {
    const { code, engine } = await drive({
      script: [
        ...TWO_TAKES, image(K1, 'done'), image(K2, 'done'), COMPLETE, FIDELITY,
        // A frame the engine still sends during the hold gets its one line.
        async (sock) => { await waitForLog(/holding the socket open/); sock.send(JSON.stringify({ type: 'stream.token', text: 'x' })) },
      ],
    }, ['--hold-min', '0.01'])
    expect(code).toBe(0)
    await engine.closed
    await sleep(50) // the client's own close event has run by now
    expect(has(/\[driver\] hold: stream\.token/)).toBe(true)
    expect(has(/\[driver\] hold over/)).toBe(true)
    expect(has(/went away/)).toBe(false)
    expect(has(/\[driver\] socket closed/)).toBe(false)
  })
})
