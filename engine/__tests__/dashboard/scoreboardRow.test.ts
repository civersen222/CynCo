import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Phase 5 ruling 2 (Task 3): the Campaign panel's "Scoreboard" row per
 * campaign and the pooled line at the top of the panel, read off
 * `/api/campaign`'s `campaigns[].scoreboard` and `pooled`. index.html has no
 * module boundary, so the helpers are lifted out of the page by brace
 * matching and run for real — the same source the browser loads — and
 * pollCampaign is checked to print them with textContent, never innerHTML.
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
const lift = (name: string) => new Function(
  extractFunction(html, 'scoreboardNum') + '\n' + extractFunction(html, name) + '\nreturn ' + name,
)() as (x: unknown) => { text: string; title: string }

describe('dashboard campaign panel: the Scoreboard row', () => {
  const row = lift('campaignScoreboardText')

  it('prints the five numbers', () => {
    const r = row({
      wave: 2, passRatePerGpuHour: 0.25, wavesPerCampaign: 2,
      gateLinesFixedPerLandedWave: { value: 1.5, landedWaves: 2, fixed: 3 },
      humanInterventionsPerWave: { value: 0.5, notes: 1 },
      perRulePrecision: { predictive: 1, total: 8, best: { id: 'I3', precision: 0.58, ci: [0.4, 0.7], verdict: 'NO EVIDENCE' } },
      unmeasured: [],
    })
    expect(r.text).toBe('PASS/GPU-h 0.250 · waves/campaign 2 · lines fixed/landed wave 1.50 · human acts/wave 0.50 · rules predictive 1/8 (best I3 58%)')
    expect(r.title).toBe('')
  })

  it('prints — for every null, with the unmeasured reasons on the title', () => {
    const r = row({
      wave: 1, passRatePerGpuHour: null, wavesPerCampaign: null,
      gateLinesFixedPerLandedWave: { value: null, reason: 'no wave landed a commit' },
      humanInterventionsPerWave: { value: 0, notes: 0 },
      perRulePrecision: null,
      unmeasured: ['passRatePerGpuHour: open — undecided after 1 wave(s)', 'perRulePrecision: no rule-verdicts.json — missing or unreadable'],
    })
    expect(r.text).toBe('PASS/GPU-h — · waves/campaign — · lines fixed/landed wave — · human acts/wave 0.00 · rules predictive —')
    expect(r.title).toBe('passRatePerGpuHour: open — undecided after 1 wave(s)\nperRulePrecision: no rule-verdicts.json — missing or unreadable')
  })

  it('a board that threw (all null) and a missing board both print dashes', () => {
    const r = row({ wave: 1, passRatePerGpuHour: null, wavesPerCampaign: null, gateLinesFixedPerLandedWave: null,
      humanInterventionsPerWave: null, perRulePrecision: null, unmeasured: ['scoreboard: boom'] })
    expect(r.text).toBe('PASS/GPU-h — · waves/campaign — · lines fixed/landed wave — · human acts/wave — · rules predictive —')
    expect(r.title).toBe('scoreboard: boom')
    expect(row(null)).toEqual({ text: '—', title: 'no wave record carries a scoreboard yet' })
    expect(row(undefined).text).toBe('—')
  })
})

describe('dashboard campaign panel: the pooled line', () => {
  const pooled = lift('pooledScoreboardText')

  it('prints the pooled numbers and counts, exclusions and reasons on the title', () => {
    const r = pooled({
      campaigns: 2, decided: 1, waves: 3, gpuHours: 6,
      passRatePerGpuHour: 1 / 6, wavesPerCampaign: 2,
      gateLinesFixedPerLandedWave: { value: 1.5 }, humanInterventionsPerWave: { value: 1 / 3 },
      supervisionDollars: 10, supervisionDollarsPerWave: 10 / 3,
      excluded: ['c7: boom'], unmeasured: ['gateLinesFixedPerLandedWave: c6 wave 1 x'],
    })
    expect(r.text).toBe('2 campaigns, 1 decided, 3 waves — PASS/GPU-h 0.167 · waves/campaign 2 · lines fixed/landed wave 1.50 · human acts/wave 0.33 · supervision $/wave 3.33')
    expect(r.title).toBe('gateLinesFixedPerLandedWave: c6 wave 1 x\nexcluded: c7: boom')
  })

  it('an empty pool prints dashes, not zeros', () => {
    const r = pooled({
      campaigns: 0, decided: 0, waves: 0, gpuHours: null, passRatePerGpuHour: null, wavesPerCampaign: null,
      gateLinesFixedPerLandedWave: { value: null }, humanInterventionsPerWave: { value: null },
      supervisionDollars: null, supervisionDollarsPerWave: null, excluded: [], unmeasured: ['passRatePerGpuHour: no runner-driven campaign has decided yet'],
    })
    expect(r.text).toBe('0 campaigns, 0 decided, 0 waves — PASS/GPU-h — · waves/campaign — · lines fixed/landed wave — · human acts/wave — · supervision $/wave —')
  })

  it('a pool that threw is named; an absent pool is a dash', () => {
    expect(pooled({ error: 'bad board' })).toEqual({ text: 'unmeasured — bad board', title: '' })
    expect(pooled(undefined)).toEqual({ text: '—', title: '' })
  })
})

describe('pollCampaign prints them', () => {
  const src = extractFunction(html, 'pollCampaign')

  it('a Scoreboard row per campaign, under the Autopoiesis checklist row', () => {
    expect(src).toContain("['Scoreboard', board.text, board.title]")
    expect(src.indexOf("['Autopoiesis'")).toBeLessThan(src.indexOf("['Scoreboard'"))
  })

  it('one pooled line, placed before the roadmap and the campaign blocks', () => {
    expect(src).toContain('pooledScoreboardText(data.pooled)')
    expect(src.indexOf('pooledScoreboardText(data.pooled)')).toBeLessThan(src.indexOf('if (data.roadmap)'))
  })

  it('rows are built with textContent, never innerHTML', () => {
    // The only innerHTML left in pollCampaign is the list reset.
    const uses = src.match(/\.innerHTML\s*=/g) ?? []
    expect(uses).toHaveLength(1)
    expect(src).toContain("list.innerHTML = ''")
  })
})
