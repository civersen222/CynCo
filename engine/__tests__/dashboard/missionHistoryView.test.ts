// The Governance tab's Missions panel and the Campaign panel's home rows: pure
// page functions, lifted out of index.html by brace matching and run for real
// (the same source the browser loads), as missionsView.test.ts does.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function extractFunction(src: string, name: string): string {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}
function lift<T>(name: string, deps: string[] = []): T {
  const src = [...deps, name].map((n) => extractFunction(html, n)).join('\n')
  return new Function(`${src}\nreturn ${name};`)() as T
}

const ROW_DEPS = ['escHtml', 'escAttr', 'missionDurationText', 'missionWhenText', 'missionFileName', 'missionVerifiedHtml', 'missionCampaignHtml']
const missionDurationText = lift<(s: unknown) => string>('missionDurationText')
const missionHistoryRowHtml = lift<(m: any) => string>('missionHistoryRowHtml', ROW_DEPS)
const missionHistoryHtml = lift<(page: any, live: any) => string>('missionHistoryHtml', [...ROW_DEPS, 'missionHistoryRowHtml', 'missionLiveRowHtml'])
const missionHistoryRangeText = lift<(page: any) => string>('missionHistoryRangeText')
const missionHistoryFilterHtml = lift<(groups: any, selected: string) => string>('missionHistoryFilterHtml', ['escHtml', 'escAttr'])
const campaignSpecText = lift<(spec: any) => { text: string; title: string }>('campaignSpecText')

const t1 = {
  missionId: 't1-brief-1794596799340', campaignId: null, campaignFrom: null, campaignLink: null,
  cwd: 'C:\\Users\\civer\\casino', briefFile: 'C:/Users/civer/.cynco/campaigns/partynight/t1-brief.txt', marker: 'cast task 1 complete', markerSeen: true,
  dispatchedAt: '2026-11-13T19:06:39.340Z', durationS: 555, outcome: 'landed', verified: true,
  check: { command: 'node C:/Users/civer/.cynco/heldout/partynight/t1/gate_t1.mjs', result: 'exit 0', tail: 'T1.1: PASS' },
  exitReason: 'engine_closed_the_turn', commitRange: { base: 'aaaabbbbcccc', head: '293dc1cfbd02' }, turns: 39,
  graderProbes: { total: 59, probes: 0, uninspectable: 0 }, ledger: 'missions.0004.jsonl:19',
}
const c11 = { ...t1, missionId: 'c11-wave2-1791237906699', campaignId: 'c11', campaignFrom: 'ledger', campaignLink: 'c11', cwd: 'C:/Users/civer/civkings', check: null, verified: false }

describe('the Missions panel', () => {
  it('a mission with no campaign shows its repository, brief, outcome, check and commit range', () => {
    const h = missionHistoryRowHtml(t1)
    expect(h).toContain('t1-brief-1794596799340')
    expect(h).toContain('<span class="mh-sub">no campaign</span>')
    expect(h).toContain('repo C:\\Users\\civer\\casino')
    expect(h).toContain('>t1-brief.txt</span>')
    expect(h).toContain('ran 9m 15s')
    expect(h).toContain('<span class="mh-ok">verified</span>')
    expect(h).toContain('check <code>node C:/Users/civer/.cynco/heldout/partynight/t1/gate_t1.mjs</code> → exit 0')
    expect(h).toContain('commits aaaabbb..293dc1c')
    expect(h).toContain('turns 39')
    expect(h).toContain('grader probes 0 of 59')
    expect(h).toContain('engine_closed_the_turn')
  })
  it('a campaign mission links to its campaign; a campaign id with no folder is named, not linked', () => {
    expect(missionHistoryRowHtml(c11)).toContain('<a href="#" class="mh-campaign" data-campaign="c11"')
    expect(missionHistoryRowHtml(c11)).toContain('<span class="mh-bad">not verified</span>')
    expect(missionHistoryRowHtml(c11)).toContain('no check')
    const series = missionHistoryRowHtml({ ...t1, campaignId: 'partynight-cast' })
    expect(series).toContain('partynight-cast <span class="mh-sub">(no campaign folder)</span>')
    expect(series).not.toContain('mh-campaign')
    expect(missionHistoryRowHtml({ ...c11, campaignFrom: 'waves' })).toContain('(named by its waves)')
  })
  it('escapes every value that comes off disk', () => {
    const h = missionHistoryRowHtml({ ...t1, missionId: '<img src=x onerror=alert(1)>', exitReason: '"><script>', check: { command: '<b>', result: 'exit 1', tail: '"quoted"' } })
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<script>')
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(h).toContain('title="&quot;quoted&quot;"')
  })
  it('the live mission sits on top of the ledger rows while one runs', () => {
    const live = { active: true, marker: 'cast task 2 complete', markerSeen: false, cwd: 'C:\\Users\\civer\\casino', base: '293dc1cfbd02', commitsSinceBase: 0, toolCalls: 812, maxIterations: 2400, checkCmd: 'node gate_t2.mjs', gitStale: false }
    const h = missionHistoryHtml({ total: 2, offset: 0, limit: 25, missions: [t1, c11], errors: [] }, live)
    const at = (s: string) => h.indexOf(s)
    expect(at('mh-live')).toBeGreaterThan(-1)
    expect(at('LIVE')).toBeLessThan(at('t1-brief-1794596799340'))
    expect(at('t1-brief-1794596799340')).toBeLessThan(at('c11-wave2-1791237906699'))
    expect(h).toContain('tool calls 812 of 2400')
    expect(h).toContain('0 commit(s) since 293dc1c')
    // No live mission, no live row.
    expect(missionHistoryHtml({ missions: [t1], errors: [] }, { active: false })).not.toContain('mh-live')
  })
  it('says so when there is nothing, and names a shard that could not be read', () => {
    expect(missionHistoryHtml({ missions: [], errors: [], campaign: 'none' }, null)).toContain('No missions in the ledger for no campaign')
    expect(missionHistoryHtml({ missions: [t1], errors: ['missions.0004.jsonl: could not be re-read, showing the rows read before (x)'] }, null))
      .toContain('missions.0004.jsonl: could not be re-read')
  })
  it('the pager range and the campaign filter', () => {
    expect(missionHistoryRangeText({ total: 288, offset: 25, limit: 25, missions: new Array(25) })).toBe('26–50 of 288')
    expect(missionHistoryRangeText({ total: 0, offset: 0, limit: 25, missions: [] })).toBe('0 missions')
    const f = missionHistoryFilterHtml([{ campaignId: null, count: 2 }, { campaignId: 'c11', count: 3 }], 'none')
    expect(f).toContain('<option value="none" selected>no campaign (2)</option>')
    expect(f).toContain('<option value="c11">c11 (3)</option>')
    expect(f).toContain('<option value="">all campaigns</option>')
  })
  it('durations in words', () => {
    expect(missionDurationText(555)).toBe('9m 15s')
    expect(missionDurationText(7726)).toBe('2h 8m')
    expect(missionDurationText(42)).toBe('42s')
    expect(missionDurationText(null)).toBe('—')
  })
})

describe('the Campaign panel\'s Spec row', () => {
  it('names the spec it read and why, and a recorded spec that is gone', () => {
    expect(campaignSpecText({ path: 'C:/Users/civer/.cynco/campaigns/partynight/pn.campaign.json', from: 'state', missing: null }).text).toBe('C:/Users/civer/.cynco/campaigns/partynight/pn.campaign.json (recorded by the runner)')
    expect(campaignSpecText({ path: 'docs/civkings-redesign-briefs/c11.campaign.json', from: 'legacy', missing: 'C:/gone.json' })).toEqual({
      text: 'docs/civkings-redesign-briefs/c11.campaign.json (CivKings briefs folder: state.json predates the recorded path)',
      title: 'the runner recorded C:/gone.json, which is gone',
    })
    expect(campaignSpecText({ path: null, from: null, missing: null }).text).toBe('none found')
  })
})

describe('wiring', () => {
  it('the panel is on the Governance tab, its builders are wired once per page, and the campaign blocks carry the anchor a link opens', () => {
    expect(html).toContain('id="panelMissionHistory"')
    expect(html.indexOf('id="panelMissionHistory"')).toBeGreaterThan(html.indexOf('id="panelCampaign"'))
    expect(html.indexOf('id="panelMissionHistory"')).toBeLessThan(html.indexOf('<!-- /tab-governance -->'))
    expect(html).toMatch(/connectWS\(\);\s*\/\/[^\n]*\s*wireMissionHistory\(\);/)
    expect(html).toContain("fetch('/api/mission-history' + q)")
    expect(html).toContain("block.id = 'campaign-' + c.id;")
    // fetchSessionState runs on every reconnect: nothing of the Missions panel is wired inside it.
    expect(extractFunction(html, 'fetchSessionState')).not.toMatch(/wireMissionHistory\(|addEventListener\('change'/)
    expect(extractFunction(html, 'pollMission')).toContain('lastLiveMission = m;')
  })
})
