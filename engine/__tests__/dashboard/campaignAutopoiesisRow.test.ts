import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Phase 4 ruling 4: the Campaign panel's "Autopoiesis" row, read off the LAST
 * wave's `autopoiesis` as `/api/campaign` hands it over (`{ isAutopoietic,
 * missing }`, or `{ …, assessError }`, or null). index.html has no module
 * boundary, so the helper is lifted out of the page by brace matching and run
 * for real — the same source the browser loads — and pollCampaign is checked
 * to actually print it.
 */
const __dir = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = join(__dir, '../../dashboard/index.html')

function extractFunction(html: string, name: string): string {
  const start = html.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

describe('dashboard campaign panel: the Autopoiesis row', () => {
  const html = readFileSync(INDEX_HTML, 'utf-8')
  const text = new Function(extractFunction(html, 'campaignAutopoiesisText') + '\nreturn campaignAutopoiesisText')() as (waves: unknown) => string

  it('prints met/6 and the missing criteria from the last wave', () => {
    expect(text([
      { wave: 1, autopoiesis: { isAutopoietic: false, missing: ['hasBoundary', 'boundarySelfProduced', 'organizationallyClosed'] } },
      { wave: 2, autopoiesis: { isAutopoietic: false, missing: ['boundarySelfProduced', 'organizationallyClosed'] } },
    ])).toBe('4/6 — missing boundarySelfProduced, organizationallyClosed')
  })

  it('prints 6/6 when nothing is missing', () => {
    expect(text([{ wave: 1, autopoiesis: { isAutopoietic: true, missing: [] } }])).toBe('6/6')
  })

  it('names an assessment that threw', () => {
    expect(text([{ wave: 1, autopoiesis: { isAutopoietic: false, missing: [], assessError: 'boom' } }])).toBe('unassessed — boom')
  })

  it('skips a later stop/fault record with no reading and prints the last graded wave\'s', () => {
    expect(text([
      { wave: 1, autopoiesis: { isAutopoietic: false, missing: ['hasBoundary'] } },
      { wave: 2, autopoiesis: { isAutopoietic: false, missing: ['boundarySelfProduced'] } },
      { wave: 3, decision: { kind: 'stop' }, autopoiesis: null },
      { wave: 3, decision: { kind: 'fault' }, autopoiesis: null },
    ])).toBe('5/6 — missing boundarySelfProduced')
  })

  it('a dash when no wave carries a reading (or there are no waves)', () => {
    expect(text([{ wave: 1, autopoiesis: null }, { wave: 2, autopoiesis: null }])).toBe('—')
    expect(text([])).toBe('—')
    expect(text(undefined)).toBe('—')
  })

  it('pollCampaign prints the row through the helper', () => {
    const src = extractFunction(html, 'pollCampaign')
    expect(src).toContain("['Autopoiesis', campaignAutopoiesisText(c.waves)]")
  })
})
