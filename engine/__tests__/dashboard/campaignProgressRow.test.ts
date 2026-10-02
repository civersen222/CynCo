import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Phase 7 ruling 5: the Campaign panel draws each wave's gate progress (fails
 * over the wave clock, off `/api/campaign`'s `waves[].progress`) with the
 * shadow rules' fired ticks marked, and prints the v1 | v2 governance
 * verdicts. index.html has no module boundary, so the helpers are lifted out
 * of the page by brace matching and run for real — the same source the
 * browser loads — and pollCampaign is checked to actually use them.
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

const html = readFileSync(INDEX_HTML, 'utf-8')
// The two progress helpers share campaignProgressMeasured; it is lifted with them.
const lift = <T>(name: string, ...deps: string[]): T =>
  new Function([...deps, name].map(n => extractFunction(html, n)).join('\n') + '\nreturn ' + name)() as T
const svgOf = lift<(p: unknown) => string>('campaignProgressSvg', 'campaignProgressMeasured')
const progressText = lift<(p: unknown) => { text: string; title: string }>('campaignProgressText', 'campaignProgressMeasured')
const governanceText = lift<(g: unknown) => string>('campaignGovernanceText')

// /api/campaign's reduced shape (server.ts reduceProgress), as the endpoint
// test pins it: a reused start, a fault, two gate runs, R2 fired at 75 %.
const PROGRESS = {
  startFails: 9,
  readings: [
    { elapsedFraction: 0.25, fails: 9, sha7: 'aaaaaaa', fault: null },
    { elapsedFraction: null, fails: null, sha7: null, fault: 'gate timed out (exit null)' },
    { elapsedFraction: 0.5, fails: 6, sha7: 'bbbbbbb', fault: null },
    { elapsedFraction: 0.75, fails: 6, sha7: 'ccccccc', fault: null },
  ],
  decisions: {
    'R1.no-progress': { n: 4, fired: 0, firedAt: [] },
    'R2.stalled': { n: 4, fired: 1, firedAt: [0.75] },
  },
}

describe('dashboard campaign panel: the wave progress curve', () => {
  it('draws fails over elapsedFraction from the start count, faults left out, fired ticks as circles on the curve', () => {
    const svg = svgOf(PROGRESS)
    expect(svg.startsWith('<svg viewBox="0 0 100 24"')).toBe(true)
    // (0, start) then each measured reading: y = 24 − 24·fails/9.
    expect(svg).toContain('points="0,0 25,0 50,8 75,8"')
    expect(svg.match(/<circle /g)?.length).toBe(1)
    expect(svg).toContain('cx="75" cy="8"')
    expect(svg).toContain('<title>R2.stalled fired at 75%</title>')
  })

  it('no graphic for a wave without progress, or with no measured reading', () => {
    expect(svgOf(null)).toBe('')
    expect(svgOf({ startFails: null, readings: [], decisions: {} })).toBe('')
    expect(svgOf({ startFails: 3, readings: [{ elapsedFraction: null, fails: null, sha7: null, fault: 'x' }], decisions: {} })).toBe('')
  })

  it('a count above the start stays inside the box', () => {
    const svg = svgOf({ startFails: 2, readings: [{ elapsedFraction: 0.5, fails: 4, sha7: 'a', fault: null }], decisions: {} })
    expect(svg).toContain('points="0,12 50,0"')
  })

  it('labels the curve with the counts, faults and each rule\'s fired/decided; the shas ride the tooltip', () => {
    const t = progressText(PROGRESS)
    expect(t.text).toBe('9 → 6 fails · 3 readings, 1 fault · R1.no-progress 0/4 fired · R2.stalled 1/4 fired')
    expect(t.title).toContain('25% aaaaaaa 9 fails')
    expect(t.title).toContain('fault: gate timed out (exit null)')
  })

  it('a wave without progress says why there is no curve', () => {
    expect(progressText(null).text).toBe('no gate curve (wave predates Phase 6, or the runner did not wait on it)')
  })

  // T7-M2: a measured reading whose clock was unknown is still a reading —
  // counted and listed — but has no x to be drawn at.
  it('counts and lists a measured reading with a null elapsedFraction, and does not draw it', () => {
    const p = { startFails: 9, readings: [{ elapsedFraction: 0.5, fails: 6, sha7: 'aaaaaaa', fault: null }, { elapsedFraction: null, fails: 5, sha7: 'bbbbbbb', fault: null }], decisions: {} }
    expect(svgOf(p)).toContain('points="0,0 50,8"')
    const t = progressText(p)
    expect(t.text).toBe('9 → 5 fails · 2 readings')
    expect(t.title).toContain('?% bbbbbbb 5 fails')
    // Only clockless readings: listed, nothing drawn.
    const only = { startFails: 9, readings: [{ elapsedFraction: null, fails: 5, sha7: 'b', fault: null }], decisions: {} }
    expect(svgOf(only)).toBe('')
    expect(progressText(only).text).toBe('9 → 5 fails · 1 reading')
  })

  // T7-M3: a fraction past the clock (a check that overran) or below 0 is
  // drawn at the box's edge, never outside it.
  it('clamps elapsedFraction to [0, 1] when drawing', () => {
    const svg = svgOf({ startFails: 9, readings: [{ elapsedFraction: -0.1, fails: 9, sha7: 'a', fault: null }, { elapsedFraction: 1.25, fails: 6, sha7: 'b', fault: null }],
      decisions: { 'R2.stalled': { n: 1, fired: 1, firedAt: [1.25] } } })
    expect(svg).toContain('points="0,0 100,8"')
    expect(svg).toContain('cx="100" cy="8"')
    expect(svg).toContain('<title>R2.stalled fired at 125%</title>')
  })
})

describe('dashboard campaign panel: v1 | v2 governance', () => {
  it('prints v1 alone when the wave predates v2', () => {
    expect(governanceText({ verdict: 'Consistent', onsetWave: null, v2: null })).toBe('Consistent')
    expect(governanceText({ verdict: 'Contradicted', onsetWave: 2 })).toBe('Contradicted (drift onset wave 2)')
  })

  it('prints v1 | v2 (e of t earned) when v2 exists', () => {
    expect(governanceText({ verdict: 'Contradicted', onsetWave: 1, v2: { verdict: 'Consistent', stated: { earned: 0, total: 8 } } }))
      .toBe('v1 Contradicted (drift onset wave 1) | v2 Consistent (0 of 8 earned)')
  })

  it('an unmeasured v2 says so', () => {
    expect(governanceText({ verdict: 'Contradicted', onsetWave: null, v2: { verdict: null, stated: null } }))
      .toBe('v1 Contradicted | v2 unmeasured')
  })

  it('a dash when there is no reading', () => {
    expect(governanceText(null)).toBe('—')
  })

  it('pollCampaign uses all three helpers and names the in-flight empty state', () => {
    const poll = extractFunction(html, 'pollCampaign')
    expect(poll).toContain('campaignProgressSvg(w.progress)')
    expect(poll).toContain('campaignProgressText(w.progress)')
    expect(poll).toContain('campaignGovernanceText(c.governancePosiwid)')
    expect(poll).toContain('campaignGovernanceText(w.governancePosiwid)')
    expect(poll).toContain('appears at its verdict')
  })

  // T7-M4: a curve that does not parse is never inserted (DOMParser returns a
  // <parsererror> document rather than throwing).
  it('pollCampaign checks the parsed curve for a parsererror before inserting it', () => {
    const poll = extractFunction(html, 'pollCampaign')
    const parse = poll.indexOf("new DOMParser().parseFromString(svg, 'image/svg+xml')")
    const check = poll.indexOf("getElementsByTagName('parsererror').length === 0")
    const insert = poll.indexOf('curve.appendChild(document.importNode(')
    expect(parse).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(parse)
    expect(insert).toBeGreaterThan(check)
  })
})
