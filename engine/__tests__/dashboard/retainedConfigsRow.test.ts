import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Phase 4 task 4: the Governance panel's "Retained configs" row, read off the
 * `governance.status` frame's `ultrastable.retained` / `ultrastable.retainedVersion`
 * (the session-feedback instance's retained-configuration table and its stored
 * version). index.html has no module boundary, so the helper is lifted out of the
 * page by brace matching and run for real, and renderGovernance is checked to
 * print it into the row.
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

describe('dashboard governance panel: the Retained configs row', () => {
  const html = readFileSync(INDEX_HTML, 'utf-8')
  const text = new Function(extractFunction(html, 'retainedConfigsText') + '\nreturn retainedConfigsText')() as (u: unknown) => string

  it('prints the key count and the stored version', () => {
    expect(text({ margin: 0.4, retained: { ev0: { Continuous: [1] }, ev1: { Continuous: [2] } }, retainedVersion: 7 })).toBe('2 keys, v7')
    expect(text({ retained: { ev0: { Continuous: [1] } }, retainedVersion: 1 })).toBe('1 key, v1')
  })

  it('says when nothing is stored yet', () => {
    expect(text({ retained: {}, retainedVersion: null })).toBe('0 keys, not stored yet')
  })

  it('a dash when there is no ultrastable block or it predates the store', () => {
    expect(text(null)).toBe('—')
    expect(text(undefined)).toBe('—')
    expect(text({ margin: 0.4 })).toBe('—')
  })

  it('has its own row, printed by renderGovernance', () => {
    expect(html).toContain('<span class="label">Retained configs: </span><span class="value" id="govRetained">')
    const render = extractFunction(html, 'renderGovernance')
    expect(render).toMatch(/getElementById\('govRetained'\)[\s\S]*retainedConfigsText\(gov\.ultrastable\)/)
  })
})
