/**
 * What a page that lost its socket is sent when it comes back.
 *
 * A phone whose screen locked loses its socket; the turn goes on without it.
 * Frames were broadcast once and never again, so the page came back to a gap:
 * it kept what it had drawn and said "anything streamed meanwhile is not shown
 * here". The Chat pane is a state machine over frames (a token appends to the
 * last bubble, a tool.complete finds its row by id), so the faithful repair is
 * not to redraw it from a stored transcript — that throws the state away and
 * still lacks the message being streamed — but to send it the frames it missed.
 *
 * The dashboard numbers each frame that draws the pane (`seq`) and keeps the
 * recent ones here. A page remembers the last number it handled and names it
 * when it reconnects (`/ws?…&epoch=…&since=…&off=…`); the server sends what
 * came after, in order, before any live frame. The page drops a frame at or
 * before its cursor, so nothing is drawn twice whatever the timing.
 *
 * Token frames are the bulk of a turn (one per token, an hour of streaming is
 * a hundred thousand), so consecutive tokens are kept as ONE entry whose text
 * grows, and they share its `seq`; `off` says how far into the entry a frame
 * reaches. The cursor is therefore (seq, off), and a page that left in the
 * middle of a run is sent only the rest of it. Kept that way, the buffer costs
 * about the size of the text.
 *
 * `epoch` names one engine process and one conversation. A new engine (a
 * restart, a dispatch swap) or a change of conversation (`project.opened`)
 * starts a new epoch with an empty buffer: a page holding the old one is sent
 * nothing and falls back to what a page load does (the stored transcript of a
 * project chat, `/api/session`). Replaying frames across a change of
 * conversation would draw them twice — the transcript the page then fetches
 * already holds those messages.
 *
 * Pure: no socket, no clock. server.ts owns the wiring.
 */
import { randomBytes } from 'crypto'

/**
 * The frames that draw the Chat pane, in the page's own words (`handleEvent` in
 * index.html). `replay.test.ts` reads the page's `case` list and fails when a
 * case is on neither list, so a new frame type cannot be forgotten here.
 */
export const REPLAYED_TYPES: ReadonlySet<string> = new Set([
  'stream.token',
  'stream.thinking',
  'tool.start',
  'tool.complete',
  'file.diff',
  'message.complete',
  'governance.alert',
  'mission.operator_note',
  'session.error',
  'ui.render',
  'ui.image',
  'project.citations',
  'project.ingest',
])

/** The frames the page handles that are NOT replayed, each with why. */
export const NOT_REPLAYED_TYPES: Readonly<Record<string, string>> = {
  'approval.request': 'a decision still pending is drawn from /api/session `pending`; one answered meanwhile must not come back as a live card',
  'ask.request': 'as approval.request: /api/session `pending` draws the question still open',
  'project.opened': 'a change of conversation starts a new epoch; the server sends the current binding to every socket that connects',
  'session.ready': 'a snapshot: /api/session carries the model and context length on every connect',
  'governance.status': 'a snapshot: polled from /api/governance, and the next frame replaces it',
  'context.status': 'a snapshot: seeded from /api/session, and the next frame replaces it',
  's2.decision': 'Governance tab history, not the Chat pane',
  's5.decision': 'Governance tab history, not the Chat pane',
  'config.current': 'a snapshot of configuration',
  'config.updated': 'the answer to this page\'s own POST',
  'control.signals': 'a snapshot',
  'trajectory.turn': 'a training counter, refreshed by its own poll',
  'bestOfN.start': 'a snapshot',
  'brain.uncertainty': 'Brain tab telemetry, one frame per token: the Brain trace shows a gap, as before',
  'brain.toolUncertainty': 'Brain tab telemetry',
  'brain.toolDivergence': 'Brain tab telemetry',
  'brain.workspace': 'Brain tab telemetry',
  'brain.tier': 'kept by the server\'s own last-value cache and resent on every connect',
}

/** Where a page got to: the last entry it handled and, for a token run, how many characters of it. */
export type ReplayCursor = { epoch: string; seq: number; off: number }

type Entry = {
  seq: number
  /** The frame as broadcast, without `seq`/`off`. For a token run, `text` is the whole run so far. */
  event: Record<string, unknown>
  /** A token run: its text is appended to, and frames into it carry `off`. */
  run: boolean
  /** Characters this entry is charged for against `maxChars`. */
  chars: number
}

const RUN_TYPES = new Set(['stream.token', 'stream.thinking'])
const RUN_KEYS = new Set(['type', 'text', 'messageId'])

/** A token frame that can join a run: nothing on it but its type, its text and the message it belongs to. */
function isRunFrame(event: Record<string, unknown>): boolean {
  if (!RUN_TYPES.has(event.type as string) || typeof event.text !== 'string') return false
  for (const k of Object.keys(event)) if (!RUN_KEYS.has(k)) return false
  return true
}

/** Defaults: about what an hour-long turn's tool traffic and text come to, bounded so a mission cannot grow it without end. */
export const REPLAY_MAX_ENTRIES = 4_000
export const REPLAY_MAX_CHARS = 8_000_000

const CURSOR_EPOCH_RE = /^[A-Za-z0-9-]{1,64}$/

/** The cursor a page put on its socket URL, or null when it sent none (a fresh page) or one that does not parse. */
export function parseCursor(q: URLSearchParams): ReplayCursor | null {
  const epoch = q.get('epoch') ?? ''
  const since = q.get('since') ?? ''
  const off = q.get('off') ?? '0'
  if (!CURSOR_EPOCH_RE.test(epoch) || !/^\d{1,15}$/.test(since) || !/^\d{1,15}$/.test(off)) return null
  return { epoch, seq: Number(since), off: Number(off) }
}

export class ReplayBuffer {
  private readonly base = randomBytes(6).toString('hex')
  private generation = 0
  private entries: Entry[] = []
  private counter = 0
  private chars = 0
  /** The highest seq dropped for space; a page whose cursor is below it has a gap. */
  private droppedThrough = 0
  private readonly maxEntries: number
  private readonly maxChars: number

  constructor(opts: { maxEntries?: number; maxChars?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? REPLAY_MAX_ENTRIES
    this.maxChars = opts.maxChars ?? REPLAY_MAX_CHARS
  }

  get epoch(): string { return `${this.base}-${this.generation}` }

  /** Where the stream is now — what a page that just connected starts counting from. */
  state(): ReplayCursor {
    const last = this.entries[this.entries.length - 1]
    return { epoch: this.epoch, seq: this.counter, off: last && last.run && last.seq === this.counter ? (last.event.text as string).length : 0 }
  }

  /** The conversation changed: nothing kept so far belongs to what a page will draw next. */
  reset(): void {
    this.generation++
    this.entries = []
    this.counter = 0
    this.chars = 0
    this.droppedThrough = 0
  }

  /**
   * Take a frame about to be broadcast. Returns the JSON to send in its place
   * (the frame with `seq`, and `off` for a token), or null when this type is
   * not replayed and the caller sends the frame as it was.
   */
  record(event: Record<string, unknown>): string | null {
    const type = event.type
    if (typeof type !== 'string' || !REPLAYED_TYPES.has(type)) return null
    const last = this.entries[this.entries.length - 1]

    if (isRunFrame(event)) {
      const text = event.text as string
      if (last && last.run && last.event.type === type && last.event.messageId === event.messageId) {
        last.event.text = (last.event.text as string) + text
        last.chars += text.length
        this.chars += text.length
        this.trim()
        return JSON.stringify({ ...event, seq: last.seq, off: (last.event.text as string).length })
      }
      const entry: Entry = { seq: ++this.counter, event: { ...event }, run: true, chars: text.length + 64 }
      this.push(entry)
      return JSON.stringify({ ...event, seq: entry.seq, off: text.length })
    }

    const json = JSON.stringify(event)
    // A partial ui.render carries the whole spec so far: only the newest one of a call is worth keeping.
    if (type === 'ui.render' && last && last.event.type === 'ui.render' && last.event.partial === true && last.event.toolId === event.toolId) {
      this.chars -= last.chars
      this.entries.pop()
    }
    const entry: Entry = { seq: ++this.counter, event, run: false, chars: json.length }
    this.push(entry)
    return withSeq(json, entry.seq)
  }

  /**
   * What a page at `cursor` has not seen, in order. `known` is false when the
   * cursor is not one this buffer gave out (no cursor, another epoch, a number
   * ahead of the stream): nothing is sent and the page loads as a fresh one.
   * `gap` is true when frames it needed were dropped for space. Then nothing
   * is sent either: a tail with a hole in it would glue the end of one message
   * onto whatever the page drew last. All of what was missed, or none of it.
   */
  since(cursor: ReplayCursor | null): { frames: string[]; gap: boolean; known: boolean } {
    if (cursor === null || cursor.epoch !== this.epoch || cursor.seq > this.counter) return { frames: [], gap: false, known: false }
    if (cursor.seq < this.droppedThrough) return { frames: [], gap: true, known: true }
    const frames: string[] = []
    for (const e of this.entries) {
      if (e.seq < cursor.seq) continue
      if (e.seq === cursor.seq) {
        if (!e.run) continue
        const text = e.event.text as string
        if (cursor.off >= text.length) continue
        frames.push(JSON.stringify({ ...e.event, text: text.slice(cursor.off), seq: e.seq, off: text.length }))
        continue
      }
      frames.push(e.run
        ? JSON.stringify({ ...e.event, seq: e.seq, off: (e.event.text as string).length })
        : withSeq(JSON.stringify(e.event), e.seq))
    }
    return { frames, gap: false, known: true }
  }

  private push(entry: Entry): void {
    this.entries.push(entry)
    this.chars += entry.chars
    this.trim()
  }

  /** Drop the oldest entries past either bound — never the newest, which may still be growing. */
  private trim(): void {
    while (this.entries.length > 1 && (this.entries.length > this.maxEntries || this.chars > this.maxChars)) {
      const gone = this.entries.shift()!
      this.chars -= gone.chars
      this.droppedThrough = gone.seq
    }
  }
}

/** `{"type":…}` → `{"type":…,"seq":N}` without parsing the frame again. */
function withSeq(json: string, seq: number): string {
  return `${json.slice(0, -1)},"seq":${seq}}`
}
