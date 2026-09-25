/**
 * The ledger README's gate-lines example rows must be REAL rows.
 *
 * The README says of them: "Both of these are real rows, copied out of an
 * export run against `~/.cynco/campaigns`". That claim is the whole value of
 * the block — the gate-lines dataset is the evidence the gate-author seat
 * earns its authority on, and a reader who builds a query or a promotion check
 * against a documented row shape is building it against this example. A field
 * quietly added to (or dropped from) `gateLineRows` without the README moving
 * with it turns the documented row into a lie, exactly the way F149 turned
 * `meanDepth` into one.
 *
 * So the field list is NOT restated here. It is computed from `gateLineRows`
 * (scripts/cynco-gate-lines.mjs) — the only writer of the dataset — and the
 * README's example rows must carry precisely that set. Add a row field and
 * this guard fails until the README's example shows it.
 *
 * Modelled on ledgerReadmeBrainDepth.test.ts, which guards the same README
 * against the same class of drift.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
// @ts-expect-error — .mjs script, no types; it is the dataset's only writer.
import { gateLineRows } from '../../../scripts/cynco-gate-lines.mjs'

const README = join(process.cwd(), 'benchmark', 'cynco-ledger', 'README.md')
/** CRLF in the checkout must not decide whether the guard can read the block. */
const read = () => readFileSync(README, 'utf-8').replace(/\r\n/g, '\n')
const OUTCOMES = ['held', 'resealed', 'open']

/** The row shape as the writer actually emits it, from both of its sources. */
function producedFields(): string[] {
  const rows = gateLineRows({
    states: [{
      id: 'cX', author: 'cynco', decided: true, sealedAt: '2026-01-01T00:00:00.000Z',
      calibration: { baseFails: [{ id: 'CX.1a.thing', detail: 'a claim' }] },
      reseals: [], waves: [],
    }],
    history: { campaigns: [{ id: 'cY', author: 'human', decided: true, lineIds: ['CY.1.thing'], resealed: [] }] },
  })
  expect(rows.length, 'gateLineRows produced no rows for the guard fixture').toBe(2)
  const [a, b] = rows.map((r: object) => Object.keys(r).sort())
  expect(a, 'the runner row and the history row disagree on their fields').toEqual(b)
  return a
}

/** The example rows out of the README's ```jsonc block, as objects. */
function readmeRows(text: string): Record<string, unknown>[] {
  const block = text.match(/### Gate lines dataset[\s\S]*?```jsonc\n([\s\S]*?)```/)
  expect(block, 'the ledger README has no ```jsonc example block under "Gate lines dataset"').toBeTruthy()
  // One row per `{ ... }`; the rows are pretty-printed across two lines each.
  const objects = block![1].match(/\{[\s\S]*?\}/g) ?? []
  return objects.map(o => JSON.parse(o) as Record<string, unknown>)
}

describe('ledger README: the gate-lines example rows match the real row', () => {
  const text = read()

  it('documents gate-line rows at all', () => {
    expect(readmeRows(text).length, 'no gate-lines example row in the ledger README').toBeGreaterThan(0)
  })

  it('every example row carries exactly the fields gateLineRows writes', () => {
    const want = producedFields()
    for (const row of readmeRows(text)) {
      const got = Object.keys(row).sort()
      expect(got, `documented row ${JSON.stringify(row)} does not carry the fields ` +
        `gateLineRows writes (${want.join(', ')}) — the README example has drifted ` +
        'from scripts/cynco-gate-lines.mjs').toEqual(want)
    }
  })

  it('documents the seven fields the dataset is read by, whatever else rides along', () => {
    // The named seven are the ones every consumer (summarize, the --gate-lines
    // table, gateAuthorPromotion) actually reads; they may never silently go.
    const want = producedFields()
    for (const f of ['campaign', 'lineId', 'author', 'sealedAt', 'outcome', 'resealedAtWave', 'firstPassWave']) {
      expect(want, `gateLineRows no longer writes "${f}"`).toContain(f)
    }
  })

  it('every example row\'s outcome is one the dataset defines', () => {
    for (const row of readmeRows(text)) {
      expect(OUTCOMES, `documented outcome "${String(row.outcome)}" is not one of ${OUTCOMES.join(' | ')}`)
        .toContain(row.outcome)
    }
  })
})
