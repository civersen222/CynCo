/**
 * Regression: llama-cpp setup failure must be FATAL, not a silent Ollama
 * fallback. The 2026-07-02 live-session breakage: a stale model name made
 * GGUF resolution fail, the engine silently fell back to Ollama with the
 * wrong model + context budget, then every request timed out with no
 * visible cause. bootstrapProvider must throw instead.
 */
import { describe, it, expect, vi } from 'vitest'
import type { LocalCodeConfig } from '../config.js'

vi.mock('../llama/binaryManager.js', () => ({
  resolveBinary: vi.fn(() => 'C:/fake/bin/llama-server.exe'),
  downloadBinary: vi.fn(async () => 'C:/fake/bin/llama-server.exe'),
}))

vi.mock('../llama/modelResolver.js', () => ({
  resolveModel: vi.fn(() => {
    throw new Error("No GGUF found for 'stale-model:latest'")
  }),
}))

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn(() => ({ name: 'ollama-fallback' })),
}))

import { bootstrapProvider, binaryAction, isUnattendedMission } from '../bootstrapProvider.js'
import { createProvider } from '../providers/factory.js'
import { resolveBinary, downloadBinary } from '../llama/binaryManager.js'

/**
 * F161 residual (Phase 4 final review, I4): an unattended engine downloaded a
 * llama-server binary with nobody there to approve it — the live proof's second
 * launch reached GitHub and sat out the dispatch's ten-minute wait. A mission
 * refuses by name; an interactive engine keeps the download.
 */
describe('binaryAction: an unattended mission refuses instead of downloading', () => {
  const dirs = { binDir: 'H/bin', brainBinDir: 'H/bin-brain' }

  it('a resolved binary is used, attended or not', () => {
    expect(binaryAction({ binaryPath: 'H/bin/llama-server.exe', unattended: true, ...dirs })).toEqual({ kind: 'use', path: 'H/bin/llama-server.exe' })
    expect(binaryAction({ binaryPath: 'H/bin/llama-server.exe', unattended: false, ...dirs })).toEqual({ kind: 'use', path: 'H/bin/llama-server.exe' })
  })

  it('no binary, interactive: download (unchanged behaviour)', () => {
    expect(binaryAction({ binaryPath: null, unattended: false, ...dirs })).toEqual({ kind: 'download' })
  })

  it('no binary, unattended: a named F161 refusal naming both directories and the override', () => {
    const a = binaryAction({ binaryPath: null, unattended: true, ...dirs })
    expect(a.kind).toBe('refuse')
    expect(a.kind === 'refuse' && a.message).toBe(
      'F161: no llama-server under H/bin or H/bin-brain; an unattended engine does not download — stage the binary or set LOCALCODE_LLAMA_SERVER')
  })

  it('isUnattendedMission reads any non-empty LOCALCODE_MISSION_* key', () => {
    expect(isUnattendedMission({})).toBe(false)
    expect(isUnattendedMission({ LOCALCODE_MISSION_CHECK: '' })).toBe(false)
    expect(isUnattendedMission({ LOCALCODE_MISSION_MARKER: 'C9_DONE' })).toBe(true)
    expect(isUnattendedMission({ LOCALCODE_MISSION_CWD: 'C:/repo', LOCALCODE_MISSION_CHECK: '' })).toBe(true)
    expect(isUnattendedMission({ LOCALCODE_MISSIONS: 'x' })).toBe(false)
  })

  it('bootstrapProvider under a mission env with no binary throws the refusal and never downloads', async () => {
    const prev = process.env.LOCALCODE_MISSION_MARKER
    process.env.LOCALCODE_MISSION_MARKER = 'F161_TEST'
    vi.mocked(resolveBinary).mockReturnValueOnce(null)
    vi.mocked(downloadBinary).mockClear()
    try {
      const config = { provider: 'llama-cpp', model: 'm', baseUrl: 'http://localhost:11434', port: 8081 } as unknown as LocalCodeConfig
      await expect(bootstrapProvider(config)).rejects.toThrow(/^F161: no llama-server under .*an unattended engine does not download/)
      expect(vi.mocked(downloadBinary)).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.LOCALCODE_MISSION_MARKER; else process.env.LOCALCODE_MISSION_MARKER = prev
    }
  })
})

describe('bootstrapProvider llama-cpp failure path', () => {
  it('throws on llama-cpp setup failure instead of falling back to Ollama', async () => {
    const config = {
      provider: 'llama-cpp',
      model: 'stale-model:latest',
      baseUrl: 'http://localhost:11434',
      port: 8081,
    } as unknown as LocalCodeConfig

    await expect(bootstrapProvider(config)).rejects.toThrow(/No GGUF found/)

    // The old bug: a silent createOllamaFallback() here. Must never happen.
    expect(vi.mocked(createProvider)).not.toHaveBeenCalled()
  })
})
