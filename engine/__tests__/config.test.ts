import { describe, expect, it, afterEach, beforeEach, mock } from 'bun:test'
import { loadConfig } from '../config.js'

describe('config', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LOCALCODE_')) delete process.env[key]
    }
  })

  it('returns defaults when no env vars', () => {
    const c = loadConfig()
    expect(c.baseUrl).toBe('http://localhost:11434')
    expect(c.model).toBeUndefined()
    expect(c.tier).toBe('auto')
    expect(c.temperature).toBe(0.7)
    expect(c.maxOutputTokens).toBe(16384)
    expect(c.timeout).toBe(300000)
  })

  it('reads LOCALCODE_ env vars', () => {
    process.env.LOCALCODE_BASE_URL = 'http://192.168.1.100:11434'
    process.env.LOCALCODE_MODEL = 'qwen3:32b'
    process.env.LOCALCODE_TIER = 'advanced'
    const c = loadConfig()
    expect(c.baseUrl).toBe('http://192.168.1.100:11434')
    expect(c.model).toBe('qwen3:32b')
    expect(c.tier).toBe('advanced')
  })

  it('reads LOCALCODE_CONTEXT_LENGTH', () => {
    process.env.LOCALCODE_CONTEXT_LENGTH = '32768'
    expect(loadConfig().contextLength).toBe(32768)
  })

  it('rejects invalid tier, falls back to auto', () => {
    process.env.LOCALCODE_TIER = 'turbo'
    expect(loadConfig().tier).toBe('auto')
  })
})

describe('config with LOCALCODE_PROFILE', () => {
  // These tests use the profile system integration.
  // We set up a temp directory with profile YAML files and point HOME there.

  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')

  let tmpDir: string
  let origHome: string | undefined
  let origCwd: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-config-profile-'))
    fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true })
    origHome = process.env.HOME
    origCwd = process.cwd()
    process.env.HOME = path.join(tmpDir, 'home')
    process.chdir(path.join(tmpDir, 'project'))
  })

  afterEach(() => {
    process.env.HOME = origHome
    process.chdir(origCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LOCALCODE_')) delete process.env[key]
    }
  })

  function writeProfile(name: string, content: string) {
    const dir = path.join(tmpDir, 'home', '.cynco', 'profiles')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.yml`), content)
  }

  it('applies profile settings when LOCALCODE_PROFILE is set', () => {
    writeProfile('test-profile', `
name: test-profile
model: deepseek-coder-v2:33b
temperature: 0.3
max_output_tokens: 16384
context_length: 32768
timeout: 60000
`)
    process.env.LOCALCODE_PROFILE = 'test-profile'
    const c = loadConfig()
    expect(c.model).toBe('deepseek-coder-v2:33b')
    expect(c.temperature).toBe(0.3)
    expect(c.maxOutputTokens).toBe(16384)
    expect(c.contextLength).toBe(32768)
    expect(c.timeout).toBe(60000)
  })

  it('env vars override profile values', () => {
    writeProfile('base-profile', `
name: base-profile
model: profile-model:7b
temperature: 0.5
`)
    process.env.LOCALCODE_PROFILE = 'base-profile'
    process.env.LOCALCODE_MODEL = 'env-model:13b'
    const c = loadConfig()
    // Env var should override profile
    expect(c.model).toBe('env-model:13b')
    // Profile value should be used when no env var
    expect(c.temperature).toBe(0.5)
  })

  it('ignores nonexistent profile gracefully', () => {
    process.env.LOCALCODE_PROFILE = 'nonexistent-profile'
    const c = loadConfig()
    // Should fall back to defaults
    expect(c.baseUrl).toBe('http://localhost:11434')
    expect(c.model).toBeUndefined()
    expect(c.tier).toBe('auto')
  })

  it('profile base_url maps to config baseUrl', () => {
    writeProfile('remote', `
name: remote
base_url: http://gpu-server:11434
`)
    process.env.LOCALCODE_PROFILE = 'remote'
    const c = loadConfig()
    expect(c.baseUrl).toBe('http://gpu-server:11434')
  })

  it('profile tier setting is applied', () => {
    writeProfile('advanced-profile', `
name: advanced-profile
tier: advanced
`)
    process.env.LOCALCODE_PROFILE = 'advanced-profile'
    const c = loadConfig()
    expect(c.tier).toBe('advanced')
  })

  it('profile tools scoping is passed through to config', () => {
    writeProfile('scoped-tools', `
name: scoped-tools
tools:
  allowed:
    - Read
    - Write
  denied:
    - Bash
`)
    process.env.LOCALCODE_PROFILE = 'scoped-tools'
    const c = loadConfig()
    expect(c.tools).toBeDefined()
    expect(c.tools!.allowed).toEqual(['Read', 'Write'])
    expect(c.tools!.denied).toEqual(['Bash'])
  })

  it('config tools is undefined when profile has no tools scoping', () => {
    writeProfile('no-tools', `
name: no-tools
model: llama3:8b
`)
    process.env.LOCALCODE_PROFILE = 'no-tools'
    const c = loadConfig()
    expect(c.tools).toBeUndefined()
  })

  it('config tools is undefined when no profile is set', () => {
    const c = loadConfig()
    expect(c.tools).toBeUndefined()
  })
})
