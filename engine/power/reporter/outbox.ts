/**
 * engine/power/reporter/outbox.ts — what has not reached the watcher yet, bounded, and the POST.
 *
 * Records wait here until `<url>/push` answers 2xx. When the doorman cannot be
 * reached the backlog grows to `max` records and then loses its oldest; how
 * many were lost is itself reported (`reporter.dropped`) once the watcher is
 * back. The backlog is on disk only while there is one: a healthy minute
 * writes nothing. A push the watcher took but whose answer was lost is sent
 * again, which is safe: the watcher stores nothing twice.
 *
 * Nothing listens here; the box only ever speaks first.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { PushBody, WatchRecord } from './types.js'

export type OutboxFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>

export type OutboxOpts = {
  url: string
  box: string
  /** Where the backlog is kept while there is one. */
  file: string
  fetchImpl?: OutboxFetch
  /** Records kept while the watcher is unreachable (default 5000: about three days of samples). */
  max?: number
  /** Records per POST (the watcher refuses more than 500). */
  batch?: number
  timeoutMs?: number
  now?: () => Date
  log?: (line: string) => void
}

export type FlushResult = 'sent' | 'failed' | 'empty'

const FAILURE_SAID_EVERY_MS = 10 * 60_000

export class Outbox {
  private queue: WatchRecord[] = []
  private dropped = 0
  private onDisk = false
  private failures = 0
  private lastFailureSaidAt = 0
  private readonly url: string
  private readonly fetchImpl: OutboxFetch
  private readonly max: number
  private readonly batch: number
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly log: (line: string) => void

  constructor(private readonly opts: OutboxOpts) {
    this.url = `${opts.url.replace(/\/$/, '')}/push`
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.max = opts.max ?? 5000
    this.batch = opts.batch ?? 200
    this.timeoutMs = opts.timeoutMs ?? 5000
    this.now = opts.now ?? (() => new Date())
    this.log = opts.log ?? console.log
    this.load()
  }

  size(): number {
    return this.queue.length
  }

  add(records: WatchRecord[]): void {
    if (records.length === 0) return
    this.queue.push(...records)
    this.trim()
  }

  private trim(): void {
    const over = this.queue.length - this.max
    if (over <= 0) return
    this.queue.splice(0, over)
    this.dropped += over
  }

  /** Send the oldest batch. `sent` = the watcher took it; call again while there is more. */
  async flush(): Promise<FlushResult> {
    if (this.dropped > 0) {
      const at = this.now().toISOString()
      this.queue.push({ t: 'event', at, kind: 'reporter.dropped', key: `dropped:${at}`, data: { n: this.dropped } })
      this.log(`[watch] the watcher was unreachable for long enough that ${this.dropped} record(s) were dropped (the oldest); the rest is kept`)
      this.dropped = 0
      this.trim()
      this.dropped = 0 // the notice itself is never counted as a loss
    }
    if (this.queue.length === 0) return 'empty'
    const records = this.queue.slice(0, this.batch)
    const body: PushBody = { v: 1, box: this.opts.box, sentAt: this.now().toISOString(), records }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    let why = ''
    try {
      const resp = await this.fetchImpl(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
      if (resp.ok) {
        this.queue.splice(0, records.length)
        this.persist()
        if (this.failures > 0) this.log(`[watch] the watcher answers again after ${this.failures} failed tr${this.failures === 1 ? 'y' : 'ies'}; ${this.queue.length} record(s) still to send`)
        this.failures = 0
        this.lastFailureSaidAt = 0
        return 'sent'
      }
      why = `HTTP ${resp.status}`
      // 400 and 413 are the watcher refusing this batch as it stands: sending it again cannot work,
      // and keeping it would block everything behind it for ever. Any other answer (a 404 from a
      // wrong address, a 5xx) says nothing about the records, so they are kept.
      if (resp.status === 400 || resp.status === 413) {
        this.queue.splice(0, records.length)
        this.persist()
        this.log(`[watch] the watcher refused ${records.length} record(s) (${why}); they are not sent again`)
        return 'failed'
      }
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(timer)
    }
    this.persist()
    // Said at the first failure and then every ten minutes: an unreachable doorman is tried every
    // look, and a line per try would be thousands a day in a log nobody is asked to read.
    this.failures++
    const at = this.now().getTime()
    if (this.failures === 1 || at - this.lastFailureSaidAt >= FAILURE_SAID_EVERY_MS) {
      this.lastFailureSaidAt = at
      this.log(`[watch] not delivered to ${this.url} (${why}); ${this.queue.length} record(s) kept for the next try${this.failures > 1 ? ` (${this.failures} tries failed so far)` : ''}`)
    }
    return 'failed'
  }

  /** The backlog on disk mirrors the queue while there is one, and the file is gone when there is none. */
  private persist(): void {
    try {
      if (this.queue.length === 0) {
        if (this.onDisk) { rmSync(this.opts.file, { force: true }); this.onDisk = false }
        return
      }
      mkdirSync(dirname(this.opts.file), { recursive: true })
      const tmp = `${this.opts.file}.${process.pid}.tmp`
      writeFileSync(tmp, this.queue.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
      renameSync(tmp, this.opts.file)
      this.onDisk = true
    } catch (err) {
      this.log(`[watch] the backlog could not be written to ${this.opts.file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private load(): void {
    if (!existsSync(this.opts.file)) return
    this.onDisk = true
    try {
      for (const line of readFileSync(this.opts.file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as WatchRecord
          if (r && (r.t === 'sample' || r.t === 'event') && typeof r.at === 'string') this.queue.push(r)
        } catch {
          continue // a torn last line from a crash mid-write
        }
      }
      this.trim()
      this.dropped = 0 // what an earlier process could not keep is not this one's to report
      if (this.queue.length) this.log(`[watch] ${this.queue.length} record(s) from before this start are still to be sent`)
    } catch (err) {
      this.log(`[watch] the backlog at ${this.opts.file} could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
