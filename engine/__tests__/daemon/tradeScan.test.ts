// engine/__tests__/daemon/tradeScan.test.ts
import { describe, expect, it } from 'bun:test'
import { parseCandidates, runTradeScan, type TradeScanDeps } from '../../daemon/tradeScan.js'
import type { TaskFileInput, TaskOutcome } from '../../daemon/types.js'

describe('parseCandidates', () => {
  it('parses the last fenced json block with a candidates array', () => {
    const text = [
      'reasoning...',
      '```json', '{"candidates": []}', '```',
      'wait, actually:',
      '```json',
      '{"candidates": [{"give": ["G. Pickens"], "get": ["B. Robinson"], "rationale": "RB need"}]}',
      '```',
    ].join('\n')
    const got = parseCandidates(text)
    expect(got).toEqual([{ give: ['G. Pickens'], get: ['B. Robinson'], rationale: 'RB need' }])
  })

  it('returns null when no block parses (pass failure, not empty result)', () => {
    expect(parseCandidates('no json here')).toBeNull()
    expect(parseCandidates('```json\n{"not": "candidates"}\n```')).toBeNull()
  })

  it('an empty candidates array is a SUCCESSFUL pass with no trades', () => {
    expect(parseCandidates('```json\n{"candidates": []}\n```')).toEqual([])
  })

  it('drops malformed entries and caps at 2 candidates', () => {
    const text = '```json\n' + JSON.stringify({
      candidates: [
        { give: 'not-an-array', get: ['x'], rationale: 'bad' },
        { give: ['a'], get: ['b'], rationale: 'ok1' },
        { give: ['c'], get: ['d'], rationale: 'ok2' },
        { give: ['e'], get: ['f'], rationale: 'ok3 — over the cap' },
      ],
    }) + '\n```'
    const got = parseCandidates(text)!
    expect(got.length).toBe(2)
    expect(got[0].rationale).toBe('ok1')
    expect(got[1].rationale).toBe('ok2')
  })
})

// ─── Orchestration ───────────────────────────────────────────────

const TASK: TaskFileInput = {
  missionId: 'mfl-dynasty', triggerId: 'trade-scan',
  prompt: 'Rank the candidate trades and report the top 2-3.',
  context: 'goal: Win the league',
  allowedTools: ['Mfl', 'WebSearch', 'WebFetch'], timeoutMs: 3600000, outcomePath: '/tmp/out.json',
  taskType: 'trade-scan',
  leagues: [{ leagueId: '65042', year: 2026, franchiseId: '0001' }],
}

/** 4-team league: my 0001 plus rivals 0002-0004. MFL-shaped JSON. */
function mflFixtures(): Record<string, any> {
  return {
    league: { league: { franchises: { franchise: [
      { id: '0001', name: 'Mine' }, { id: '0002', name: 'Rival Two' },
      { id: '0003', name: 'Rival Three' }, { id: '0004', name: 'Rival Four' },
    ] } } },
    rosters: { rosters: { franchise: [
      { id: '0001', player: [{ id: 'p1' }, { id: 'p2' }] },
      { id: '0002', player: [{ id: 'p3' }] },
      { id: '0003', player: [{ id: 'p4' }] },
      { id: '0004', player: { id: 'p5' } }, // MFL quirk: single element is an object, not array
    ] } },
    players: { players: { player: [
      { id: 'p1', name: 'Hurts, Jalen', position: 'QB', team: 'PHI' },
      { id: 'p2', name: 'Aiyuk, Brandon', position: 'WR', team: 'SFO' },
      { id: 'p3', name: 'Robinson, Bijan', position: 'RB', team: 'ATL' },
      { id: 'p4', name: 'Chase, Ja\'Marr', position: 'WR', team: 'CIN' },
      { id: 'p5', name: 'Allen, Josh', position: 'QB', team: 'BUF' },
    ] } },
    playerRanks: { playerRanks: { player: [
      { id: 'p1', rank: '3' }, { id: 'p2', rank: '40' }, { id: 'p3', rank: '5' },
      { id: 'p4', rank: '1' }, { id: 'p5', rank: '2' },
    ] } },
    leagueStandings: { leagueStandings: { franchise: [
      { id: '0001', h2hw: '0', h2hl: '0' }, { id: '0002', h2hw: '0', h2hl: '0' },
      { id: '0003', h2hw: '0', h2hl: '0' }, { id: '0004', h2hw: '0', h2hl: '0' },
    ] } },
    injuries: { injuries: { injury: [{ id: 'p3', status: 'Questionable' }] } },
  }
}

function makeDeps(overrides: Partial<TradeScanDeps> = {}) {
  const fixtures = mflFixtures()
  const completions: string[] = []
  const intermediates: Record<string, string> = {}
  const rankingCalls: { prompt: string; context: string }[] = []
  const deps: TradeScanDeps = {
    fetchMfl: async (query) => {
      if (!(query in fixtures)) throw new Error(`unexpected query ${query}`)
      return fixtures[query]
    },
    completeText: async (prompt) => {
      completions.push(prompt)
      return '```json\n{"candidates": [{"give": ["Aiyuk, Brandon"], "get": ["Robinson, Bijan"], "rationale": "they need WR"}]}\n```'
    },
    runRanking: async (prompt, context) => {
      rankingCalls.push({ prompt, context })
      return {
        ok: true, summary: 'ranked',
        recommendations: [{ id: 'rec-x', actionType: 'trade', summary: 'Trade Aiyuk for Bijan', detail: 'why' }],
      } satisfies TaskOutcome
    },
    writeIntermediate: (name, content) => { intermediates[name] = content },
    log: () => {},
    ...overrides,
  }
  return { deps, completions, intermediates, rankingCalls }
}

describe('runTradeScan', () => {
  it('runs one pass per rival, then the ranking loop, and returns its outcome', async () => {
    const { deps, completions, intermediates, rankingCalls } = makeDeps()
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(completions.length).toBe(3) // rivals 0002-0004, never my own 0001
    // Each rival prompt carries my roster and that rival's roster
    expect(completions[0]).toContain('Hurts, Jalen')
    expect(completions[0]).toContain('Robinson, Bijan')
    // Injury annotation made it into the roster text
    expect(completions[0]).toContain('Questionable')
    expect(Object.keys(intermediates).sort()).toEqual(['pass-0002', 'pass-0003', 'pass-0004'])
    // Ranking got the task prompt and all candidates (tagged with rivalId)
    expect(rankingCalls.length).toBe(1)
    expect(rankingCalls[0].prompt).toBe(TASK.prompt)
    expect(rankingCalls[0].context).toContain('"rivalId": "0002"')
    expect(rankingCalls[0].context).toContain('goal: Win the league')
    expect(outcome.ok).toBe(true)
    expect(outcome.recommendations[0].actionType).toBe('trade')
  })

  it('a failed pass is skipped; the scan continues with the rest', async () => {
    let call = 0
    const { deps, rankingCalls } = makeDeps({
      completeText: async () => {
        call++
        if (call === 2) throw new Error('llama-server HTTP 500')
        return '```json\n{"candidates": []}\n```'
      },
    })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    // 2 of 3 passes succeeded with zero candidates → success, nothing to rank
    expect(rankingCalls.length).toBe(0)
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toMatch(/no mutually beneficial trades/i)
  })

  it('unparsable model output counts as a failed pass', async () => {
    const { deps } = makeDeps({ completeText: async () => 'I refuse to emit JSON' })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/0\/3 rival passes/)
  })

  it('fewer than 2 successful passes fails the scan', async () => {
    let call = 0
    const { deps } = makeDeps({
      completeText: async () => {
        call++
        if (call <= 2) throw new Error('boom')
        return '```json\n{"candidates": []}\n```'
      },
    })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/1\/3 rival passes/)
  })

  it('a task without leagues fails fast', async () => {
    const { deps } = makeDeps()
    const outcome = await runTradeScan({ ...TASK, leagues: undefined }, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/leagues/)
  })

  it('MFL fetch failure in pass 0 fails the scan with the error', async () => {
    const { deps } = makeDeps({ fetchMfl: async () => { throw new Error('MFL HTTP 503') } })
    const outcome = await runTradeScan(TASK, null as any, null as any, deps)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('MFL HTTP 503')
  })
})
