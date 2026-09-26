/**
 * The ledger README's gate-outcomes example rows must be REAL rows.
 *
 * The README says of them: "All three are real rows, copied out of an export
 * run against `~/.cynco/campaigns`". The gate-outcomes dataset is the
 * denominator the gate-lines dataset leaves out (a refused gate has no lines),
 * and a reader who builds a query against the documented row shape is building
 * it against this example. A field quietly added to (or dropped from)
 * `gateOutcomeRows` without the README moving with it turns the documented row
 * into a lie.
 *
 * So the field list is NOT restated here. It is computed from `gateOutcomeRows`
 * (scripts/cynco-gate-lines.mjs) — the only writer of the dataset — and the
 * README's example rows must carry precisely that set.
 *
 * Modelled on ledgerReadmeGateLines.test.ts, which guards the block beside it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
// @ts-expect-error — .mjs script, no types; it is the dataset's only writer.
import { gateOutcomeRows } from '../../../scripts/cynco-gate-lines.mjs'

const README = join(process.cwd(), 'benchmark', 'cynco-ledger', 'README.md')
/** CRLF in the checkout must not decide whether the guard can read the block. */
const read = () => readFileSync(README, 'utf-8').replace(/\r\n/g, '\n')
const OUTCOMES = ['refused', 'sealed', 'held', 'resealed']

/** The row shape as the writer actually emits it, from both of its sources. */
function producedFields(): string[] {
  const rows = gateOutcomeRows({
    states: [{ id: 'cX', author: 'cynco', sealedAt: null, decided: false, refusals: [{ at: 't', by: 'supervisor', notePath: 'n' }], attempts: 2, reseals: [] }],
    history: { campaigns: [{ id: 'cY', author: 'human', decided: true, lineIds: ['CY.1.thing'], resealed: [] }] },
  })
  expect(rows.length, 'gateOutcomeRows produced no rows for the guard fixture').toBe(2)
  const [a, b] = rows.map((r: object) => Object.keys(r).sort())
  expect(a, 'the runner row and the history row disagree on their fields').toEqual(b)
  return a
}

/** The example rows out of the README's ```jsonc block, as objects. */
function readmeRows(text: string): Record<string, unknown>[] {
  const block = text.match(/### Gate outcomes dataset[\s\S]*?```jsonc\n([\s\S]*?)```/)
  expect(block, 'the ledger README has no ```jsonc example block under "Gate outcomes dataset"').toBeTruthy()
  const objects = block![1].match(/\{[\s\S]*?\}/g) ?? []
  return objects.map(o => JSON.parse(o) as Record<string, unknown>)
}

describe('ledger README: the gate-outcomes example rows match the real row', () => {
  const text = read()

  it('documents gate-outcome rows at all', () => {
    expect(readmeRows(text).length, 'no gate-outcomes example row in the ledger README').toBeGreaterThan(0)
  })

  it('every example row carries exactly the fields gateOutcomeRows writes', () => {
    const want = producedFields()
    for (const row of readmeRows(text)) {
      const got = Object.keys(row).sort()
      expect(got, `documented row ${JSON.stringify(row)} does not carry the fields ` +
        `gateOutcomeRows writes (${want.join(', ')}) — the README example has drifted ` +
        'from scripts/cynco-gate-lines.mjs').toEqual(want)
    }
  })

  it('the row shape is exactly the six documented fields', () => {
    expect(producedFields(), 'gateOutcomeRows no longer writes exactly the six documented fields')
      .toEqual(['attempts', 'author', 'campaign', 'outcome', 'refusals', 'sealedAt'])
  })

  it('every example row\'s outcome is one the dataset defines, and the README defines all four', () => {
    for (const row of readmeRows(text)) {
      expect(OUTCOMES, `documented outcome "${String(row.outcome)}" is not one of ${OUTCOMES.join(' | ')}`)
        .toContain(row.outcome)
    }
    const section = text.match(/### Gate outcomes dataset[\s\S]*?(?=\n### )/)![0]
    for (const o of OUTCOMES) expect(section, `the README never defines the "${o}" outcome`).toContain(`**\`${o}\`**`)
  })
})
