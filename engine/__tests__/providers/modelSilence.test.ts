/**
 * How long the model server has been silent on the request in flight (`modelSilence`).
 *
 * The stall clock (F235) knows this and told nobody: a request may wait twenty minutes for its
 * first token and ten between tokens before it is cut, and for all of that time the dashboard
 * and the phone showed a chat in which nothing happened. The clock now answers the question
 * "is a request in flight, and how long since the server last sent anything", and
 * `/api/session` carries the answer (work-order mission D4f).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { StreamWatchdog, modelSilence, STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS } from '../../providers/streamWatchdog.js'

const live: StreamWatchdog[] = []
const watch = (firstByteMs = STREAM_FIRST_BYTE_MS, idleMs = STREAM_IDLE_MS, who?: { server: string; logTag: string }) => {
  const w = new StreamWatchdog(undefined, firstByteMs, idleMs, who)
  live.push(w)
  return w
}
afterEach(() => { for (const w of live.splice(0)) w.dispose() })

describe('modelSilence', () => {
  it('is null when no request is in flight', () => {
    expect(modelSilence()).toBeNull()
    watch() // made, not yet sent: nothing is being waited for
    expect(modelSilence()).toBeNull()
  })

  it('a request that was sent and has not answered: the first-byte wait, and the limit it runs under', () => {
    const w = watch()
    const t0 = Date.now()
    w.waitFirstByte()
    const s = modelSilence(t0 + 80_000)!
    expect(s.phase).toBe('first-byte')
    expect(s.limitMs).toBe(STREAM_FIRST_BYTE_MS)
    expect(s.server).toBe('llama-server')
    expect(s.silentMs).toBeGreaterThan(79_000)
    expect(s.silentMs).toBeLessThanOrEqual(80_000)
  })

  it('every chunk starts the silence again, under the idle limit', () => {
    const w = watch()
    w.waitFirstByte()
    const t1 = Date.now()
    w.sawData()
    const s = modelSilence(t1 + 45_000)!
    expect(s.phase).toBe('mid-stream')
    expect(s.limitMs).toBe(STREAM_IDLE_MS)
    expect(s.silentMs).toBeGreaterThan(44_000)
    expect(s.silentMs).toBeLessThanOrEqual(45_000)
  })

  it('a request that ended is no longer waited for', () => {
    const w = watch()
    w.waitFirstByte()
    expect(modelSilence()).not.toBeNull()
    w.dispose()
    expect(modelSilence()).toBeNull()
  })

  it('a request the clock cut is not reported as still silent', async () => {
    const w = watch(15, 15)
    w.waitFirstByte()
    await new Promise(r => setTimeout(r, 60))
    expect(w.stalled).not.toBeNull()
    expect(modelSilence()).toBeNull()
  })

  it('with two requests in flight (a sub-agent beside a turn) it is the one silent longest, and it names its server', () => {
    const a = watch(STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS, { server: 'Ollama', logTag: 'ollama' })
    a.waitFirstByte()
    const tA = Date.now()
    const b = watch()
    b.waitFirstByte()
    b.sawData()
    const s = modelSilence(tA + 30_000)!
    expect(s.server).toBe('Ollama')
    expect(s.phase).toBe('first-byte')
  })

  it('never reports a negative silence for a clock read a moment early', () => {
    const w = watch()
    w.waitFirstByte()
    expect(modelSilence(Date.now() - 5_000)!.silentMs).toBe(0)
  })
})
