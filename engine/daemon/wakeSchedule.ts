/**
 * engine/daemon/wakeSchedule.ts — tell the doorman when to wake this PC.
 *
 * The daemon stays on the GPU box (moving it is a later design). While the box
 * sleeps the daemon does not tick, so something always-on has to wake it before
 * a trigger is due: the doorman (`scripts/doorman/`) does, 3 minutes ahead, from
 * the list posted here. After every tick round the daemon collects every
 * mission's `nextFire` times and, when the list changed since the last
 * SUCCESSFUL send, POSTs the whole list to `${CYNCO_DOORMAN_URL}/schedule`
 * (doorman replaces its list). A failed send is retried on the next change-or-
 * not call; nothing here throws. `CYNCO_DOORMAN_URL` unset = `skipped`, which
 * is today's behaviour. Design: docs/decisions/2026-11-08-wakefulness-design.md
 * (slice 3, builder's call 4).
 */

export type NextFireLedger = { state: { nextFire: Record<string, string> } }

/** Every mission's future next-fire times, ISO, sorted, unique. */
export function collectNextFires(ledgers: NextFireLedger[], now: Date = new Date()): string[] {
  const out = new Set<string>()
  for (const l of ledgers) {
    for (const iso of Object.values(l.state.nextFire ?? {})) {
      const t = Date.parse(iso)
      if (!Number.isFinite(t) || t <= now.getTime()) continue
      out.add(new Date(t).toISOString())
    }
  }
  return [...out].sort()
}

export type PublishResult = 'sent' | 'unchanged' | 'skipped' | 'failed'

export type WakePublisherDeps = {
  url: string | undefined
  target: string
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  now?: () => Date
}

export class WakePublisher {
  private lastSent: string | null = null
  private readonly fetchImpl: typeof fetch
  private readonly log: (line: string) => void
  private readonly now: () => Date

  constructor(private readonly deps: WakePublisherDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? (() => new Date())
  }

  async publishIfChanged(ledgers: NextFireLedger[]): Promise<PublishResult> {
    if (!this.deps.url) return 'skipped'
    const times = collectNextFires(ledgers, this.now())
    const key = times.join(',')
    if (key === this.lastSent) return 'unchanged'
    const url = `${this.deps.url.replace(/\/$/, '')}/schedule`
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: this.deps.target, times }),
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) {
        this.log(`[daemon] wake schedule not accepted by doorman: HTTP ${resp.status}`)
        return 'failed'
      }
      this.lastSent = key
      this.log(`[daemon] wake schedule sent to doorman: ${times.length} time(s), next ${times[0] ?? 'none'}`)
      return 'sent'
    } catch (e) {
      this.log(`[daemon] wake schedule send failed (will retry next tick): ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }
}
