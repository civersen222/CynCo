// engine/daemon/waitPush.ts
// Tell the phone when the engine waits. An approval card is refused after five
// minutes and an AskUser question resolves empty after five minutes; a phone
// whose screen locked has no socket, so the frame that drew the card reached
// nobody. One ntfy notification goes out when a wait is still open after a
// short grace and no client is connected.
//
// The frame only starts the clock. What decides is the engine's own state: the
// `approval.request` frame is emitted before the approval is registered, and
// the beginner-mode warning frame uses the same type and never waits.

/** How long a wait must stay open, unanswered and unwatched, before the phone hears of it. */
export const WAIT_PUSH_GRACE_MS = 5000

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
   * paired device last opened the page on (`DashboardServer.lastRemoteOrigin`). The page itself, not a
   * chat inside it: the engine holds one conversation and puts a connecting page in it, with the card,
   * whereas asking for a chat by name is `project.open`, which ends the turn that is waiting.
   */
  openAt?: () => string | null
  graceMs?: number
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
  constructor(private readonly deps: WaitPushDeps) {}

  /** Every loop event passes through here; only a frame that opens a wait starts a check. */
  onEvent(event: { type: string; requestId?: unknown }): void {
    if (event.type !== 'approval.request' && event.type !== 'ask.request') return
    const requestId = event.requestId
    if (typeof requestId !== 'string' || !requestId) return
    const timer = setTimeout(() => { void this.check(requestId) }, this.deps.graceMs ?? WAIT_PUSH_GRACE_MS)
    // A pending check must not keep a finished engine alive.
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
  }

  private async check(requestId: string): Promise<void> {
    const log = this.deps.log ?? ((line: string) => console.log(line))
    try {
      const waiting = this.deps.pending().find(d => d.requestId === requestId)
      if (!waiting || this.deps.clientCount() > 0) return
      const ok = await this.deps.publish(waitNotice(waiting, this.deps.openAt?.()))
      // The request's own text stays out of the log: it is already in the transcript.
      log(ok ? `[wait-push] told the phone: ${waiting.kind} waiting` : `[wait-push] not delivered: ntfy did not take the ${waiting.kind} notice`)
    } catch (err) {
      log(`[wait-push] not delivered: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
