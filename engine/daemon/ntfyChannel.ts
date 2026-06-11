// engine/daemon/ntfyChannel.ts
// Self-hosted ntfy client. Publish: JSON API (POST {baseUrl}/). Subscribe: SSE.
// The ntfy server is expected to be bound to the Tailscale interface only —
// this client never opens a listening port.
import type { CommandMessage, Recommendation } from './types.js'

export interface NtfyOptions {
  baseUrl: string
  token?: string
  alertTopic: string
  commandTopic: string
}

interface NtfyAction {
  action: 'http' | 'view'
  label: string
  url: string
  method?: string
  body?: string
  clear?: boolean
}

interface PublishPayload {
  title: string
  message: string
  priority?: number
  actions?: NtfyAction[]
}

export class NtfyChannel {
  private baseUrl: string
  private token?: string
  private alertTopic: string
  private commandTopic: string
  private queue: PublishPayload[] = []
  private subscribed = false

  constructor(opts: NtfyOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.alertTopic = opts.alertTopic
    this.commandTopic = opts.commandTopic
  }

  get queuedCount(): number {
    return this.queue.length
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async post(payload: PublishPayload): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ topic: this.alertTopic, ...payload }),
        signal: AbortSignal.timeout(10000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  /** Publish a notification. On failure it is queued; queued items flush before the next publish. */
  async publish(payload: PublishPayload): Promise<boolean> {
    // Flush queue first (oldest first)
    while (this.queue.length > 0) {
      const queued = this.queue[0]
      if (await this.post(queued)) this.queue.shift()
      else break
    }
    const ok = await this.post(payload)
    if (!ok) this.queue.push(payload)
    return ok
  }

  /** Publish a recommendation with one-tap Approve/Reject buttons. */
  async publishRecommendation(rec: Recommendation): Promise<boolean> {
    const cmdUrl = `${this.baseUrl}/${this.commandTopic}`
    const action = (verdict: 'approve' | 'reject', label: string): NtfyAction => ({
      action: 'http',
      label,
      url: cmdUrl,
      method: 'POST',
      body: JSON.stringify({ recId: rec.id, verdict } satisfies CommandMessage),
      clear: true,
    })
    const actions: NtfyAction[] = [action('approve', 'Approve'), action('reject', 'Reject')]
    if (rec.deepLink) actions.push({ action: 'view', label: 'Open MFL', url: rec.deepLink })
    return this.publish({
      title: `[${rec.actionType}] ${rec.summary}`,
      message: rec.detail,
      priority: 4,
      actions,
    })
  }

  /**
   * Subscribe to the command topic via SSE. Reconnects with backoff until the
   * returned stop function is called.
   */
  subscribe(onCommand: (cmd: CommandMessage) => void): () => void {
    this.subscribed = true
    const loop = async () => {
      let backoffMs = 1000
      while (this.subscribed) {
        try {
          const resp = await fetch(`${this.baseUrl}/${this.commandTopic}/sse`, {
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
          })
          if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`)
          backoffMs = 1000
          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (this.subscribed) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim()
              buffer = buffer.slice(idx + 1)
              if (!line.startsWith('data:')) continue
              try {
                const event = JSON.parse(line.slice(5).trim())
                const cmd = JSON.parse(event.message)
                if ((cmd.verdict === 'approve' || cmd.verdict === 'reject') && typeof cmd.recId === 'string') {
                  onCommand({ recId: cmd.recId, verdict: cmd.verdict })
                }
              } catch {
                // malformed event — ignore
              }
            }
          }
          try { reader.cancel() } catch {}
        } catch {
          // connection failed — back off and retry
          await new Promise((r) => setTimeout(r, backoffMs))
          backoffMs = Math.min(backoffMs * 2, 60000)
        }
      }
    }
    void loop()
    return () => { this.subscribed = false }
  }
}
