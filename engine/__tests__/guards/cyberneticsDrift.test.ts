import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const UPSTREAM = 'C:/Users/civer/cybernetics/cybernetics-ts/src'

describe('vendored cybernetics-core', () => {
  it('is byte-identical to upstream (scripts/sync-cybernetics.ts)', () => {
    if (!existsSync(UPSTREAM)) return // CI without the upstream checkout: nothing to compare
    const r = spawnSync('bun', ['scripts/sync-cybernetics.ts'], { encoding: 'utf8', cwd: process.cwd() })
    expect(r.stdout + r.stderr).toContain('IN SYNC')
    expect(r.status).toBe(0)
  })
})
