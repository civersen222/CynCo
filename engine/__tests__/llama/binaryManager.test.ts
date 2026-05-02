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
