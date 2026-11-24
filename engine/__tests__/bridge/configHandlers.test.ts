import { describe, expect, it } from 'bun:test'
import {
  handleConfigGet,
  handleConfigUpdate,
  handleProfileList,
  handleProfileValidate,
  handleProfileWrite,
} from '../../bridge/configHandlers.js'
import type { LocalCodeConfig } from '../../config.js'

function makeConfig(overrides: Partial<LocalCodeConfig> = {}): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 300000,
    contextLength: 32768,
    tools: undefined,
    contextManagement: { warningThreshold: 0.4, hardLimit: 0.8 },
    provider: 'ollama',
    apiKey: '',
    ...overrides,
  }
}

describe('handleConfigGet', () => {
  it('returns config.current event with all fields', () => {
    const config = makeConfig()
    const event = handleConfigGet(config)
    expect(event.type).toBe('config.current')
    expect(event.config.model).toBe('qwen3:8b')
    expect(event.config.temperature).toBe(0.7)
    expect(event.config.maxOutputTokens).toBe(8192)
    expect(event.config.timeout).toBe(300000)
    expect(event.config.baseUrl).toBe('http://localhost:11434')
    expect(event.config.tier).toBe('auto')
  })
})

describe('handleConfigUpdate', () => {
  it('applies valid temperature patch', () => {
    const config = makeConfig()
    const event = handleConfigUpdate(config, { temperature: 0.5 })
    expect(event.type).toBe('config.updated')
    expect(event.applied).toEqual({ temperature: 0.5 })
    expect(event.errors).toBeUndefined()
    expect(config.temperature).toBe(0.5)
  })

  it('applies multiple patches at once', () => {
    const config = makeConfig()
    const event = handleConfigUpdate(config, { temperature: 0.3, maxOutputTokens: 16384 })
    expect(event.applied).toEqual({ temperature: 0.3, maxOutputTokens: 16384 })
    expect(config.temperature).toBe(0.3)
    expect(config.maxOutputTokens).toBe(16384)
  })

  it('rejects invalid temperature (out of range)', () => {
    const config = makeConfig()
    const event = handleConfigUpdate(config, { temperature: 5.0 })
    expect(event.errors).toHaveLength(1)
    expect(event.errors![0].field).toBe('temperature')
    expect(config.temperature).toBe(0.7)
  })

  it('rejects unknown fields', () => {
    const config = makeConfig()
    const event = handleConfigUpdate(config, { bogusField: 42 })
    expect(event.errors).toHaveLength(1)
    expect(event.errors![0].field).toBe('bogusField')
  })

  it('applies valid fields and reports errors for invalid ones', () => {
    const config = makeConfig()
    const event = handleConfigUpdate(config, { temperature: 0.5, maxOutputTokens: -1 })
    expect(event.applied).toEqual({ temperature: 0.5 })
    expect(event.errors).toHaveLength(1)
    expect(event.errors![0].field).toBe('maxOutputTokens')
    expect(config.temperature).toBe(0.5)
    expect(config.maxOutputTokens).toBe(8192)
  })

  it('applies tool scoping patch', () => {
    const config = makeConfig()
    const event = handleConfigUpdate(config, {
      tools: { allowed: ['Read', 'Edit'], denied: ['Bash'] },
    })
    expect(event.applied).toHaveProperty('tools')
    expect(config.tools).toEqual({ allowed: ['Read', 'Edit'], denied: ['Bash'] })
  })
})

describe('handleProfileList', () => {
  it('returns profile.list event with profiles', () => {
    const event = handleProfileList('coding', undefined, () => ['coding', 'writing'])
    expect(event.type).toBe('profile.list')
    expect(event.profiles).toHaveLength(2)
    expect(event.profiles[0].name).toBe('coding')
    expect(event.profiles[0].active).toBe(true)
    expect(event.profiles[1].active).toBe(false)
  })

  it('handles empty profile list', () => {
    const event = handleProfileList(undefined, undefined, () => [])
    expect(event.profiles).toHaveLength(0)
  })
})

describe('handleProfileValidate', () => {
  it('validates correct YAML', () => {
    const event = handleProfileValidate('name: test\ntemperature: 0.3')
    expect(event.type).toBe('profile.validation')
    expect(event.ok).toBe(true)
    expect(event.errors).toHaveLength(0)
  })

  it('rejects YAML without name field', () => {
    const event = handleProfileValidate('temperature: 0.3')
    expect(event.ok).toBe(false)
    expect(event.errors.length).toBeGreaterThan(0)
  })

  it('rejects invalid YAML syntax', () => {
    const event = handleProfileValidate('{{not yaml')
    expect(event.ok).toBe(false)
  })
})

describe('handleProfileWrite', () => {
  it('validates before writing and rejects invalid', () => {
    const event = handleProfileWrite('bad', '{{not yaml', '/tmp')
    expect(event.type).toBe('profile.validation')
    expect((event as any).ok).toBe(false)
  })
})

// F242, entry 4.M5: the profiles folder is FROZEN while a mission or a daemon task runs.
describe('handleProfileWrite while an integrity baseline is open (S7)', () => {
  const okYaml = 'name: t\nprovider: ollama\nmodel: m\n'

  it('refuses with the frozenWriteRefusal sentence and writes nothing; an empty or missing guard folder writes as before', () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = require('fs') as typeof import('fs')
    const { tmpdir } = require('os') as typeof import('os')
    const { join } = require('path') as typeof import('path')
    const root = mkdtempSync(join(tmpdir(), 'cynco-profile-frozen-'))
    const saved = process.env.LOCALCODE_GUARD_DIR
    try {
      const guard = join(root, 'guard')
      const profiles = join(root, 'profiles')
      mkdirSync(join(guard, 'manifests'), { recursive: true })
      process.env.LOCALCODE_GUARD_DIR = guard
      expect(handleProfileValidate(okYaml).ok).toBe(true)
      {
        writeFileSync(join(guard, 'manifests', 'daemon-m-t-20261123T120000-ab12.before.json'), '{}')
        const refused = handleProfileWrite('frozen', okYaml, profiles)
        expect(refused).toEqual({ type: 'profile.validation', ok: false, errors: [expect.stringMatching(/^a mission or daemon task is running \(daemon-m-t-20261123T120000-ab12\); this would change a protected folder and stop it\./)] })
        expect(existsSync(join(profiles, 'frozen.yml'))).toBe(false)

        rmSync(join(guard, 'manifests', 'daemon-m-t-20261123T120000-ab12.before.json'))
        expect(handleProfileWrite('free', okYaml, profiles).type).toBe('profile.written')
        // A guard folder that does not exist (as the suite's default): writes as today.
        process.env.LOCALCODE_GUARD_DIR = join(root, 'no-such-guard')
        expect(handleProfileWrite('free2', okYaml, profiles).type).toBe('profile.written')
      }
    } finally {
      if (saved === undefined) delete process.env.LOCALCODE_GUARD_DIR
      else process.env.LOCALCODE_GUARD_DIR = saved
      rmSync(root, { recursive: true, force: true })
    }
  })
})
