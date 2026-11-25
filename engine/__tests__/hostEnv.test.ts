import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'

const KEPT = ['LOCALCODE_INTEGRATION_TESTS']
const SUITE_SET = ['LOCALCODE_SANDBOX_ROOT', 'LOCALCODE_GUARD_DIR', 'LOCALCODE_AUDIT_DIR']

// Read at file load, before any test sets a key and before this file imports
// the setup module itself (importing it would clear the keys and prove
// nothing): vitest.config.ts must have run setup/hostEnv.ts already (F206).
const inheritedAtLoad = Object.keys(process.env).filter(k => k.startsWith('LOCALCODE_') && !KEPT.includes(k) && !SUITE_SET.includes(k))
const suiteSetAtLoad = SUITE_SET.map(k => [k, process.env[k]] as const)

describe('hostEnv', () => {
  it('the suite starts with no LOCALCODE_* variable from the shell that launched it', () => {
    expect(inheritedAtLoad).toEqual([])
  })

  it('the suite names its own sandbox, guard and audit folders, and none of them exists', () => {
    for (const [k, v] of suiteSetAtLoad) {
      expect(v, `${k} is not set: vitest.config.ts must list setup/containment.ts directly after setup/hostEnv.ts`).toBeTruthy()
      expect(existsSync(v!), `${k} names a folder that exists (${v}): the suite's default must refuse`).toBe(false)
    }
  })

  it('keeps only the switches that ask for more tests', async () => {
    const { KEPT_HOST_ENV } = await import('./setup/hostEnv.js')
    expect([...KEPT_HOST_ENV]).toEqual(KEPT)
  })

  it('keeps the host\'s models folder aside for the one test that measures a real model file, and out of the environment', async () => {
    const { hostModelsDir, hostModelsDirOf } = await import('./setup/hostEnv.js')
    expect(hostModelsDirOf({ LOCALCODE_MODELS_DIR: 'C:\\somewhere\\models' })).toBe('C:\\somewhere\\models')
    expect(hostModelsDirOf({})).toBeNull()
    expect(hostModelsDirOf({ LOCALCODE_MODELS_DIR: '' })).toBeNull()
    expect(hostModelsDirOf({ LOCALCODE_MODELS_DIR: '   ' })).toBeNull()
    // What this run was started with: a folder, or none. Asked twice, the same answer; and the variable itself is gone
    // (the first case of this file reads the environment at load).
    const first = hostModelsDir()
    expect(first === null || (typeof first === 'string' && first !== '')).toBe(true)
    expect(hostModelsDir()).toBe(first)
    expect(process.env.LOCALCODE_MODELS_DIR).toBeUndefined()
    // A second evaluation of the setup module, after the clear, must not forget the first reading.
    process.env.LOCALCODE_MODELS_DIR = 'C:\\set\\after\\the\\suite\\started'
    try {
      expect(hostModelsDir()).toBe(first)
    } finally {
      delete process.env.LOCALCODE_MODELS_DIR
    }
  })

  it('clears a variable exported after the suite started, when run again', async () => {
    process.env.LOCALCODE_EMBED_BASE_URL = 'http://127.0.0.1:1'
    process.env.LOCALCODE_INTEGRATION_TESTS = '1'
    try {
      const { clearHostEnv } = await import('./setup/hostEnv.js')
      clearHostEnv()
      expect(process.env.LOCALCODE_EMBED_BASE_URL).toBeUndefined()
      expect(process.env.LOCALCODE_INTEGRATION_TESTS).toBe('1')
    } finally {
      delete process.env.LOCALCODE_EMBED_BASE_URL
      delete process.env.LOCALCODE_INTEGRATION_TESTS
    }
  })
})
