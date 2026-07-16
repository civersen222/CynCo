import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { currentCounts } from './emptyCatchScan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const baseline: Record<string, number> = JSON.parse(
  readFileSync(join(here, 'emptyCatchBaseline.json'), 'utf-8'),
)

describe('empty catch ratchet (2026-07-16 audit)', () => {
  it('no file gains empty catch blocks — log the error or emit governance.alert instead', () => {
    const regressions: string[] = []
    for (const [file, n] of Object.entries(currentCounts())) {
      const allowed = baseline[file] ?? 0
      if (n > allowed) regressions.push(`${file}: ${n} empty catches (baseline ${allowed})`)
    }
    expect(regressions, `New empty catch blocks introduced:\n${regressions.join('\n')}`).toEqual([])
  })

  it('baseline stays honest — run genBaseline.mjs after removing empty catches', () => {
    const counts = currentCounts()
    const stale: string[] = []
    for (const [file, allowed] of Object.entries(baseline)) {
      if ((counts[file] ?? 0) < allowed) stale.push(`${file}: baseline ${allowed}, now ${counts[file] ?? 0}`)
    }
    expect(stale, `Ratchet down — regenerate the baseline:\n${stale.join('\n')}`).toEqual([])
  })
})
