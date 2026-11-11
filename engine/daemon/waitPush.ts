// engine/daemon/waitPush.ts
// Tell the phone when the engine waits. An approval card is refused after five
// minutes and an AskUser question resolves empty after five minutes; a phone
// whose screen locked has no socket, so the frame that drew the card reached
// nobody. One ntfy notification goes out when a wait is still open after a
// short grace and no client is connected, or still open after a minute whoever
// is connected: an open tab is not a person looking.
//
// The frame only starts the clock. What decides is the engine's own state: the
// `approval.request` frame is emitted before the approval is registered, and
// the beginner-mode warning frame uses the same type and never waits.

/** How long a wait must stay open, unanswered and unwatched, before the phone hears of it. */
export const WAIT_PUSH_GRACE_MS = 5000

/**
 * How long a wait may stay unanswered before the phone hears of it even though a client is connected.
 * A connected client is not a person looking: the desk tab stays open while its owner is out, and a
 * phone can drop its socket after the grace has passed. One minute leaves four of the five to answer.
 */
export const WAIT_PUSH_UNANSWERED_MS = 60000

const MAX_MESSAGE = 400

/** The part of `ConversationLoop.pendingDecisions()` a notice is written from. */
export type WaitingOn =
  | { kind: 'approval'; requestId: string; toolName: string; description: string }
  | { kind: 'ask'; requestId: string; question: string; options?: string[] }

export interface WaitNotice {
  title: string
  message: string
  priority: number
  /** Where a tap on the notification goes (ntfy's `click`). Absent when no address is known. */
  click?: string
}

export interface WaitPushDeps {
  publish: (notice: WaitNotice) => Promise<boolean>
  pending: () => WaitingOn[]
  /** Dashboard sockets plus the TUI: anyone who was shown the card. */
  clientCount: () => number
  /**
   * The dashboard address to open from the notification, or null when none is known: the origin a
   * paired device last opened the page on, else the bound phone listener (`DashboardServer.phoneOrigin`). The page itself, not a
   * chat inside it: the engine holds one conversation and puts a connecting page in it, with the card,
   * whereas asking for a chat by name is `project.open`, which ends the turn that is waiting.
   */
  openAt?: () => string | null
  graceMs?: number
  unansweredMs?: number
  log?: (line: string) => void
}

/** The notification for one open wait. The five minutes are `requestApproval`'s and `AskBroker`'s own timeouts. */
export function waitNotice(d: WaitingOn, link?: string | null): WaitNotice {
  const title = d.kind === 'approval' ? 'CynCo needs your approval' : 'CynCo has a question'
  const body = d.kind === 'approval'
    ? `${d.toolName}: ${d.description}`
    : d.options?.length ? `${d.question}\n${d.options.join(' / ')}` : d.question
  const tail = d.kind === 'approval'
    ? 'Refused if nobody answers within 5 minutes.'
    : 'Goes on without an answer after 5 minutes.'
  const room = MAX_MESSAGE - tail.length - 1
  const text = body.length > room ? `${body.slice(0, room - 1)}…` : body
  return { title, message: `${text}\n${tail}`, priority: 4, ...(link ? { click: link } : {}) }
}

export class WaitPush {
  /** The waits being timed, each with whether the phone was told; an entry lives from the frame to the second check, so one wait is one notice. */
  private readonly waits = new Map<string, boolean>()

  constructor(private readonly deps: WaitPushDeps) {}

  /** Every loop event passes through here; only a frame that opens a wait starts its two checks. */
  onEvent(event: { type: string; requestId?: unknown }): void {
    if (event.type !== 'approval.request' && event.type !== 'ask.request') return
    const requestId = event.requestId
    if (typeof requestId !== 'string' || !requestId || this.waits.has(requestId)) return
    this.waits.set(requestId, false)
    this.after(this.deps.graceMs ?? WAIT_PUSH_GRACE_MS, () => this.check(requestId, 'unwatched'))
    this.after(this.deps.unansweredMs ?? WAIT_PUSH_UNANSWERED_MS, () => this.check(requestId, 'unanswered').finally(() => { this.waits.delete(requestId) }))
  }

  private after(ms: number, run: () => Promise<void>): void {
    const timer = setTimeout(() => { void run() }, ms)
    // A pending check must not keep a finished engine alive.
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
  }

  /**
   * `unwatched`, after the grace: tell the phone when nobody is connected. `unanswered`, after the
   * minute: tell it whoever is connected, unless the first check already did. A notice ntfy did not
   * take does not count as told, so the second check is also the one retry.
   */
  private async check(requestId: string, why: 'unwatched' | 'unanswered'): Promise<void> {
    const log = this.deps.log ?? ((line: string) => console.log(line))
    if (this.waits.get(requestId) !== false) return
    try {
      const waiting = this.deps.pending().find(d => d.requestId === requestId)
      if (!waiting) return
      const clients = this.deps.clientCount()
      if (why === 'unwatched' && clients > 0) return
      this.waits.set(requestId, true)
      const ok = await this.deps.publish(waitNotice(waiting, this.deps.openAt?.()))
      if (!ok && this.waits.has(requestId)) this.waits.set(requestId, false)
      const reason = why === 'unwatched' ? 'nobody connected' : `unanswered for ${Math.round((this.deps.unansweredMs ?? WAIT_PUSH_UNANSWERED_MS) / 1000)} s, ${clients} client${clients === 1 ? '' : 's'} connected`
      // The request's own text stays out of the log: it is already in the transcript.
      log(ok ? `[wait-push] told the phone: ${waiting.kind} waiting (${reason})` : `[wait-push] not delivered: ntfy did not take the ${waiting.kind} notice`)
    } catch (err) {
      if (this.waits.has(requestId)) this.waits.set(requestId, false)
      log(`[wait-push] not delivered: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
