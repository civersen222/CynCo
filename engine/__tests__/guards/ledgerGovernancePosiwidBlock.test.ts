/**
 * The ledger README's illustrated `governancePosiwid` block must be a reading
 * the module can actually produce.
 *
 * F149 again, in the section Task 9 added: the block showed counts
 * `12 / 10 / 3` beside `"verdict": "Drifting"`, `"divergence": 0.47`,
 * `"dominantObserved": "signalsLogged"`. Running `governancePosiwid()` on those
 * counts returns `Consistent`, 0.467, `denialsChanged` — and `signalsLogged`
 * was the SMALLEST of the three, so it could not be dominant under any
 * threshold. A documented number no code produces is exactly what the repo
 * logged F149 for.
 *
 * So: parse the block out of the README, re-run the module on its own `counts`,
 * and fail if the verdict, the dominant bucket, the support or the divergence
 * the README prints is not what comes back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
// @ts-expect-error — plain .mjs harness module, no types
import { governancePosiwid } from '../../../scripts/cynco-governance-posiwid.mjs'

const README = join(process.cwd(), 'benchmark', 'cynco-ledger', 'README.md')

type Block = {
  verdict: string
  divergence: number
  dominantObserved: string
  support: number
  counts: { denialsChanged: number; recommendationsConsumed: number; signalsLogged: number }
}

/** The `"governancePosiwid": { … }` jsonc example, read as written. */
function parseBlock(text: string): Block {
  const start = text.indexOf('"governancePosiwid": {')
  expect(start, 'no "governancePosiwid" example block in the ledger README').toBeGreaterThan(-1)
  let depth = 0
  let end = -1
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  expect(end, 'unbalanced braces in the README governancePosiwid block').toBeGreaterThan(-1)
  const json = text.slice(text.indexOf('{', start), end).replace(/\/\/.*$/gm, '')
  return JSON.parse(json) as Block
}

describe('ledger README: the governancePosiwid block is a real reading', () => {
  const block = parseBlock(readFileSync(README, 'utf-8'))

  it('documents the three counts by their real names', () => {
    expect(Object.keys(block.counts).sort())
      .toEqual(['denialsChanged', 'recommendationsConsumed', 'signalsLogged'])
  })

  it('the module returns the verdict and dominant bucket the README prints', () => {
    const r = governancePosiwid([block.counts])
    expect(r.verdict, `README says ${block.verdict}, module says ${r.verdict} ` +
      `for counts ${JSON.stringify(block.counts)}`).toBe(block.verdict)
    expect(r.dominantObserved, `README says ${block.dominantObserved}, module says ` +
      `${r.dominantObserved}`).toBe(block.dominantObserved)
  })

  it('the module returns the support and divergence the README prints', () => {
    const r = governancePosiwid([block.counts])
    expect(r.support).toBe(block.support)
    // The README rounds; two decimals is the contract.
    expect(Number(r.divergence.toFixed(2))).toBe(block.divergence)
  })

  it('the dominant bucket the README prints is in fact its largest count', () => {
    const entries = Object.entries(block.counts) as [string, number][]
    const largest = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    expect(largest).toBe(block.dominantObserved)
  })
})
