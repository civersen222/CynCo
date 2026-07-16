import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { currentCounts, EMPTY_CATCH } from './emptyCatchScan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const baseline: Record<string, number> = JSON.parse(
  readFileSync(join(here, 'emptyCatchBaseline.json'), 'utf-8'),
)

describe('empty catch ratchet (2026-07-16 audit)', () => {
  it('pattern catches comment-only catch bodies — still silent handlers', () => {
    const hits = (src: string) => src.match(EMPTY_CATCH)?.length ?? 0
    expect(hits('try {} catch {}')).toBe(1)
    expect(hits('try {} catch (e) {}')).toBe(1)
    expect(hits('try {} catch (e) { // ignore\n }')).toBe(1)
    expect(hits('try {} catch (e) { /* best effort */ }')).toBe(1)
    expect(hits('try {} catch (e) {\n  // reason\n  /* more */\n}')).toBe(1)
    expect(hits('try {} catch (e) { console.log(e) }')).toBe(0)
  })

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
