/**
 * AskBroker — a human-in-the-loop question/answer round-trip for tools.
 *
 * Mirrors the pendingApprovals pattern in ConversationLoop: a tool calls
 * ask(), which emits a request event and returns a Promise that resolves when
 * the human's answer arrives via answer() (routed in from the bridge). On
 * timeout the Promise resolves to an empty string so the model is never
 * blocked forever.
 */
import { randomUUID } from 'crypto'

export type AskRequest = {
  requestId: string
  question: string
  options?: string[]
}

export type AskEmitter = (req: AskRequest) => void

type PendingAsk = {
  resolve: (answer: string) => void
  timer: ReturnType<typeof setTimeout>
}

export class AskBroker {
  private pending = new Map<string, PendingAsk>()
  private emitter: AskEmitter | null = null
  private readonly timeoutMs: number

  constructor(opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 300000
  }

  /** Wire the transport that surfaces questions to the human (TUI/dashboard). */
  setEmitter(emitter: AskEmitter | null): void {
    this.emitter = emitter
  }

  /** Pose a question to the human; resolves with their answer (or '' on timeout). */
  ask(question: string, options?: string[]): Promise<string> {
    const requestId = randomUUID()
    this.emitter?.({ requestId, question, options })

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(requestId)
        if (entry) {
          this.pending.delete(requestId)
          entry.resolve('')
        }
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, timer })
    })
  }

  /** Deliver a human answer for a pending request. Returns false if unknown. */
  answer(requestId: string, text: string): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve(text)
    return true
  }

  get pendingCount(): number {
    return this.pending.size
  }
}

export const globalAskBroker = new AskBroker()
