import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { cyncoHome } from '../../paths.js'
import { sidecarDecision, jlensArtifactsDir, sidecarRelay } from '../../brain/jlensSidecar.js'

describe('sidecarDecision', () => {
  it('starts when artifacts are present and no external URL is set', () => {
    expect(sidecarDecision({ artifactsPresent: true })).toEqual({ start: true })
  })

  it('starts when the URL is the default loopback sidecar', () => {
    expect(sidecarDecision({ jlensUrl: 'http://127.0.0.1:9163', artifactsPresent: true }))
      .toEqual({ start: true })
    expect(sidecarDecision({ jlensUrl: 'http://localhost:9163/', artifactsPresent: true }))
      .toEqual({ start: true })
  })

  it('refuses to compete with an externally managed lens', () => {
    const d = sidecarDecision({ jlensUrl: 'http://10.0.0.7:9163', artifactsPresent: true })
    expect(d.start).toBe(false)
    if (!d.start) expect(d.reason).toContain('externally managed')
  })

  it('refuses a non-default port even on loopback', () => {
    const d = sidecarDecision({ jlensUrl: 'http://127.0.0.1:9200', artifactsPresent: true })
    expect(d.start).toBe(false)
  })

  it('names the download step when artifacts are missing', () => {
    const d = sidecarDecision({ artifactsPresent: false })
    expect(d.start).toBe(false)
    if (!d.start) expect(d.reason).toContain('jlens_service.download')
  })

  it('external URL wins over missing artifacts — the remote lens needs no local files', () => {
    const d = sidecarDecision({ jlensUrl: 'http://10.0.0.7:9163', artifactsPresent: false })
    expect(d.start).toBe(false)
    if (!d.start) expect(d.reason).toContain('externally managed')
  })
})

describe('jlensArtifactsDir', () => {
  it('defaults to <cyncoHome()>/jlens and honours JLENS_DIR', () => {
    const prev = process.env.JLENS_DIR
    try {
      delete process.env.JLENS_DIR
      expect(jlensArtifactsDir()).toBe(join(cyncoHome(), 'jlens'))
      process.env.JLENS_DIR = 'C:\\elsewhere\\lens'
      expect(jlensArtifactsDir()).toBe('C:\\elsewhere\\lens')
    } finally {
      if (prev === undefined) delete process.env.JLENS_DIR
      else process.env.JLENS_DIR = prev
    }
  })
})

// The operator's engine log (2026-10-12/13) was flooded with the sidecar's
// "client closed the connection" lines — one per reset of an idle keep-alive
// socket, every few seconds. The relay logs every line of the sidecar's
// output on its own, and collapses a run of those to one a minute, saying
// how many it swallowed; nothing else is hidden.
describe('sidecarRelay', () => {
  it('relays each line of a chunk as its own [jlens] line, buffering a line split across chunks', () => {
    const lines: string[] = []
    const relay = sidecarRelay(l => lines.push(l), () => 0)
    relay.chunk('[jlens] loading artifacts...\n[jlens] serving on 127.0.0.1:9163 layers=[24]\n')
    relay.chunk('[jlens] readout er')
    relay.chunk('ror: bad layer\n\n')
    // the sidecar's own "[jlens] " prefix is not doubled; a line without one gets it
    expect(lines).toEqual(['[jlens] loading artifacts...', '[jlens] serving on 127.0.0.1:9163 layers=[24]', '[jlens] readout error: bad layer'])
    relay.chunk('tail without a newline')
    expect(lines).toHaveLength(3)
    relay.flush()
    expect(lines[3]).toBe('[jlens] tail without a newline')
    relay.flush()
    expect(lines).toHaveLength(4)
  })

  it('collapses a run of "client closed the connection" lines to one a minute and leaves every other line alone', () => {
    const lines: string[] = []
    let t = 1000
    const relay = sidecarRelay(l => lines.push(l), () => t)
    relay.chunk('[jlens] client closed the connection (port 50001)\n')
    t = 1500
    relay.chunk('[jlens] client closed the connection (port 50002)\n[jlens] client closed the connection (port 50003)\n')
    t = 30_000
    relay.chunk('Traceback (most recent call last):\n  File "server.py", line 1\nRuntimeError: boom\n')
    t = 59_999
    relay.chunk('[jlens] client closed the connection (port 50004)\n')
    t = 61_000
    relay.chunk('[jlens] client closed the connection (port 50005)\n')
    t = 200_000
    relay.chunk('[jlens] client closed the connection (port 50006)\n')
    expect(lines).toEqual([
      '[jlens] client closed the connection (port 50001)',
      '[jlens] Traceback (most recent call last):',
      '[jlens]   File "server.py", line 1',
      '[jlens] RuntimeError: boom',
      '[jlens] client closed the connection (port 50005) (+3 more in the minute after the last)',
      '[jlens] client closed the connection (port 50006)',
    ])
  })
})
