// engine/__tests__/llama/binaryManager.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveBinary, getVersionInfo, LLAMA_SERVER_BINARY } from '../../llama/binaryManager.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('resolveBinary', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-bin-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns explicit env path when set and file exists', () => {
    const binPath = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(binPath, 'fake-binary')
    const result = resolveBinary(binPath, tmpDir)
    expect(result).toBe(binPath)
  })

  it('throws when explicit env path does not exist', () => {
    expect(() => resolveBinary('/nonexistent/llama-server.exe', tmpDir))
      .toThrow('does not exist')
  })

  it('returns cynco bin path when binary exists there', () => {
    const binPath = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(binPath, 'fake-binary')
    const result = resolveBinary(undefined, tmpDir)
    expect(result).toBe(binPath)
  })

  it('returns null when binary not found anywhere', () => {
    const result = resolveBinary(undefined, tmpDir)
    expect(result).toBeNull()
  })

  it('prefers the brain build over the stock binary when both exist', () => {
    const binDir = path.join(tmpDir, 'bin')
    const brainDir = path.join(tmpDir, 'bin-brain')
    fs.mkdirSync(binDir)
    fs.mkdirSync(brainDir)
    fs.writeFileSync(path.join(binDir, LLAMA_SERVER_BINARY), 'stock')
    fs.writeFileSync(path.join(brainDir, LLAMA_SERVER_BINARY), 'patched')
    expect(resolveBinary(undefined, binDir, brainDir))
      .toBe(path.join(brainDir, LLAMA_SERVER_BINARY))
  })

  it('falls back to the stock binary when the brain dir has no binary', () => {
    const binDir = path.join(tmpDir, 'bin')
    const brainDir = path.join(tmpDir, 'bin-brain')
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, LLAMA_SERVER_BINARY), 'stock')
    expect(resolveBinary(undefined, binDir, brainDir))
      .toBe(path.join(binDir, LLAMA_SERVER_BINARY))
  })

  it('explicit env path outranks the brain build', () => {
    const brainDir = path.join(tmpDir, 'bin-brain')
    fs.mkdirSync(brainDir)
    fs.writeFileSync(path.join(brainDir, LLAMA_SERVER_BINARY), 'patched')
    const envBin = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(envBin, 'explicit')
    expect(resolveBinary(envBin, tmpDir, brainDir)).toBe(envBin)
  })

  it('LLAMA_SERVER_BINARY is llama-server.exe on Windows', () => {
    if (process.platform === 'win32') {
      expect(LLAMA_SERVER_BINARY).toBe('llama-server.exe')
    } else {
      expect(LLAMA_SERVER_BINARY).toBe('llama-server')
    }
  })
})

describe('getVersionInfo', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-ver-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no version.json exists', () => {
    expect(getVersionInfo(tmpDir)).toBeNull()
  })

  it('reads version info from version.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'version.json'),
      JSON.stringify({ version: 'b5432', downloadedAt: '2026-05-02T10:00:00Z' })
    )
    const info = getVersionInfo(tmpDir)
    expect(info).not.toBeNull()
    expect(info!.version).toBe('b5432')
    expect(info!.downloadedAt).toBe('2026-05-02T10:00:00Z')
  })
})
