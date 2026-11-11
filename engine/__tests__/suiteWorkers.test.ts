import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { suiteWorkers } from './setup/suiteWorkers.js'

describe('how many test files run at once (F207)', () => {
  it('on Windows: half the logical processors, never fewer than one', () => {
    expect(suiteWorkers('win32', 32)).toBe(16)
    expect(suiteWorkers('win32', 12)).toBe(6)
    expect(suiteWorkers('win32', 5)).toBe(2)
    expect(suiteWorkers('win32', 1)).toBe(1)
  })

  it('elsewhere: vitest decides', () => {
    expect(suiteWorkers('linux', 4)).toBeUndefined()
    expect(suiteWorkers('darwin', 10)).toBeUndefined()
  })

  it('vitest.config.ts asks it', () => {
    const config = readFileSync('vitest.config.ts', 'utf-8')
    expect(config).toMatch(/maxWorkers:\s*suiteWorkers\(process\.platform,\s*availableParallelism\(\)\)/)
  })
})
