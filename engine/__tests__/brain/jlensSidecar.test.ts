import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { homedir } from 'os'
import { sidecarDecision, jlensArtifactsDir } from '../../brain/jlensSidecar.js'

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
  it('defaults to ~/.cynco/jlens and honours JLENS_DIR', () => {
    const prev = process.env.JLENS_DIR
    try {
      delete process.env.JLENS_DIR
      expect(jlensArtifactsDir()).toBe(join(homedir(), '.cynco', 'jlens'))
      process.env.JLENS_DIR = 'C:\\elsewhere\\lens'
      expect(jlensArtifactsDir()).toBe('C:\\elsewhere\\lens')
    } finally {
      if (prev === undefined) delete process.env.JLENS_DIR
      else process.env.JLENS_DIR = prev
    }
  })
})
