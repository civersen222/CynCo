/**
 * engine/power/reporter/logTail.ts — what the engine wrote in its own log that the watcher should know.
 *
 * Two kinds of line. `[engine] the event loop was blocked for N s, until
 * HH:MM:SSZ` (`engine/loopWatch.ts`, F225) is the engine saying nothing was
 * answered for that long. `[embed] No embedding endpoint answered at <url>`
 * and `[embed] the embedding endpoint at <url> answers again`
 * (`engine/index/embedClient.ts`, F215) are a dependent saying, in its own
 * words, that a service it needs did not answer, and that it is back.
 *
 * The engine log carries no times, so a line is stamped with when this process
 * read it; the loop-blocked line carries its own time of day. `FileTail` reads
 * only what was appended since the last look and starts at the end of the file
 * the first time, because an old line cannot be given a time.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'fs'
import { toSecond, type WatchEvent } from './types.js'

const BLOCKED = /^\[engine\] the event loop was blocked for ([\d.]+) s.*?until (\d{2}):(\d{2}):(\d{2})Z/
const EMBED_DOWN = /^\[embed\] No embedding endpoint answered at (\S+)/
const EMBED_UP = /^\[embed\] the embedding endpoint at (\S+) answers again/

/** The most a single look reads; a longer burst is picked up at the next look. */
const MAX_READ_BYTES = 1024 * 1024
const TEXT_MAX = 240

/** `HH:MM:SS` UTC as the most recent such moment at or before `seenAt` (a line read just after midnight belongs to yesterday). */
function timeOfDayBefore(seenAt: Date, h: number, m: number, s: number): Date {
  const d = new Date(Date.UTC(seenAt.getUTCFullYear(), seenAt.getUTCMonth(), seenAt.getUTCDate(), h, m, s))
  // A minute of slack: the line's own clock and ours are the same machine's, read a moment apart.
  if (d.getTime() > seenAt.getTime() + 60_000) d.setUTCDate(d.getUTCDate() - 1)
  return d
}

export function logLineEvents(lines: string[], seenAt: Date): WatchEvent[] {
  const out: WatchEvent[] = []
  const seenIso = seenAt.toISOString()
  for (const line of lines) {
    const b = BLOCKED.exec(line)
    if (b) {
      const until = timeOfDayBefore(seenAt, Number(b[2]), Number(b[3]), Number(b[4])).toISOString()
      out.push({ t: 'event', at: until, kind: 'engine.loop_blocked', key: `blocked:${toSecond(until)}`, data: { seconds: Number(b[1]), until: toSecond(until) } })
      continue
    }
    const down = EMBED_DOWN.exec(line)
    if (down) {
      out.push({ t: 'event', at: seenIso, kind: 'service.said_down', key: `embed-down:${toSecond(seenIso)}`, data: { service: 'embed', by: 'the engine', url: down[1], text: line.slice(0, TEXT_MAX) } })
      continue
    }
    const up = EMBED_UP.exec(line)
    if (up) out.push({ t: 'event', at: seenIso, kind: 'service.said_up', key: `embed-up:${toSecond(seenIso)}`, data: { service: 'embed', by: 'the engine', url: up[1], text: line.slice(0, TEXT_MAX) } })
  }
  return out
}

/**
 * New whole lines of a growing file. `offset` is where the last look ended; `null` means "never
 * looked", and the first look reads nothing and remembers the end. A file that got shorter was
 * replaced: it is read from its start.
 */
export class FileTail {
  constructor(private readonly path: string, public offset: number | null = null) {}

  read(): string[] {
    if (!existsSync(this.path)) return []
    const size = statSync(this.path).size
    if (this.offset === null) { this.offset = size; return [] }
    if (size < this.offset) this.offset = 0
    if (size === this.offset) return []
    const want = Math.min(size - this.offset, MAX_READ_BYTES)
    const buf = Buffer.alloc(want)
    const fd = openSync(this.path, 'r')
    let got = 0
    try {
      // The file may have changed between the stat and the open: never read past what is there now.
      got = readSync(fd, buf, 0, Math.min(want, Math.max(0, fstatSync(fd).size - this.offset)), this.offset)
    } finally {
      closeSync(fd)
    }
    const text = buf.subarray(0, got)
    const end = text.lastIndexOf(0x0a)
    if (end < 0) {
      // No line ending in a full read: one enormous line. Step over it instead of reading it forever.
      if (got === MAX_READ_BYTES) this.offset += got
      return []
    }
    this.offset += end + 1
    return text.subarray(0, end).toString('utf-8').split('\n').map(l => l.replace(/\r$/, ''))
  }
}
