import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resealRecord, linesOf, gateLineRows, summarize, exportGateLines, GATE_LINES_PATH,
  gateOutcomeRows, exportGateOutcomes, GATE_OUTCOMES_PATH,
} from '../cynco-gate-lines.mjs'
import { wilson, fisherExact, gateLineVerdict, gateLineTable } from '../cynco-signal-validation.mjs'

// The evidence unit of Phase 3 is the GRADED GATE LINE, not the campaign: a
// campaign is one draw, a gate line is one falsifiable claim that survived (or
// did not survive) the campaign it was written for. Everything below is about
// keeping that unit honest — a line the author quietly rewrote mid-campaign is
// not a line that held.

const cal = (fails, passes = []) => ({
  gateSha256: 'aaaa', perturbSha256: 'bbbb', positiveSha256: 'cccc',
  baseFails: fails.map(id => ({ id, line: `${id}: FAIL nothing drawn` })),
  basePasses: passes.map(id => ({ id, line: `${id}: PASS already there` })),
  perturbFails: [], calibratedAt: '2026-09-01T00:00:00.000Z',
})

describe('linesOf', () => {
  it('is every graded line the calibration saw, failing and passing alike', () => {
    expect(linesOf(cal(['C9.1a', 'C9.2a'], ['C9.9']))).toEqual({
      'C9.1a': 'C9.1a: FAIL nothing drawn',
      'C9.2a': 'C9.2a: FAIL nothing drawn',
      'C9.9': 'C9.9: PASS already there',
    })
  })

  it('a missing or empty calibration is no lines, not a throw', () => {
    expect(linesOf(null)).toEqual({})
    expect(linesOf({})).toEqual({})
  })
})

describe('resealRecord', () => {
  const from = { gateSha256: 'aaaa', lines: { a: 'a: FAIL one', b: 'b: FAIL two', c: 'c: PASS three' } }

  it('marks a line whose printed text changed', () => {
    const r = resealRecord({ at: 't', wave: 2, from, to: { gateSha256: 'dddd', lines: { ...from.lines, b: 'b: FAIL two, harder' } } })
    expect(r).toEqual({ at: 't', wave: 2, from: { gateSha256: 'aaaa' }, to: { gateSha256: 'dddd' }, changedLineIds: ['b'] })
  })

  it('marks an added line and a removed line', () => {
    const to = { gateSha256: 'dddd', lines: { a: from.lines.a, c: from.lines.c, d: 'd: FAIL new' } }
    expect(resealRecord({ at: 't', wave: 1, from, to }).changedLineIds).toEqual(['b', 'd'])
  })

  it('an identical line set changes nothing, even when the gate sha moved', () => {
    // Only the perturb or the positive shim moved: the BAR is the same bar.
    const r = resealRecord({ at: 't', wave: 3, from, to: { gateSha256: 'aaaa', lines: { ...from.lines } } })
    expect(r.changedLineIds).toEqual([])
  })

  it('carries only the shas across, never the line text', () => {
    const r = resealRecord({ at: 't', wave: 0, from, to: { gateSha256: 'dddd', lines: {} } })
    expect(r.from).toEqual({ gateSha256: 'aaaa' })
    expect(r.to).toEqual({ gateSha256: 'dddd' })
    expect(JSON.stringify(r)).not.toContain('FAIL one')
  })
})

describe('gateLineRows', () => {
  const waves = (kinds) => kinds.map((kind, i) => ({ wave: i + 1, gate: { passes: [{ id: 'C9.9', line: 'C9.9: PASS 0 prior-campaign regressions' }], fails: [], author: 'cynco' }, decision: { kind } }))

  it('a decided CynCo campaign with one reseal holds the untouched lines and marks the rest', () => {
    const rows = gateLineRows({ states: [{
      id: 'c9', author: 'cynco', decided: true, calibration: cal(['C9.1a', 'C9.2a'], ['C9.9']),
      reseals: [{ at: 't', wave: 2, from: { gateSha256: 'aaaa' }, to: { gateSha256: 'dddd' }, changedLineIds: ['C9.2a'] }],
      waves: waves(['next', 'next', 'pass']),
    }], history: null })
    expect(rows.map(r => [r.lineId, r.outcome, r.resealedAtWave])).toEqual([
      ['C9.1a', 'held', null],
      ['C9.2a', 'resealed', 2],
      ['C9.9', 'held', null],
    ])
    expect(rows.every(r => r.campaign === 'c9' && r.author === 'cynco' && r.decided === true)).toBe(true)
    // firstPassWave is the first wave whose gate.passes carried the id.
    expect(rows.find(r => r.lineId === 'C9.9').firstPassWave).toBe(1)
    expect(rows.find(r => r.lineId === 'C9.1a').firstPassWave).toBeNull()
  })

  it('an undecided campaign is open, and a reseal inside it is still a reseal', () => {
    const rows = gateLineRows({ states: [{
      id: 'c9', author: 'cynco', decided: false, calibration: cal(['C9.1a', 'C9.2a']),
      reseals: [{ at: 't', wave: 1, from: { gateSha256: 'aaaa' }, to: { gateSha256: 'dddd' }, changedLineIds: ['C9.2a'] }],
      waves: waves(['next']),
    }], history: null })
    expect(rows.map(r => r.outcome)).toEqual(['open', 'resealed'])
  })

  it('a campaign with a calibration and no waves at all is open', () => {
    const rows = gateLineRows({ states: [{ id: 'c9', author: 'cynco', decided: false, calibration: cal(['C9.1a']), reseals: [], waves: [] }], history: null })
    expect(rows).toEqual([{ campaign: 'c9', author: 'cynco', sealedAt: null, lineId: 'C9.1a', outcome: 'open', resealedAtWave: null, firstPassWave: null, decided: false, source: 'runner' }])
  })

  it('history campaigns arrive as their own rows, with the reseals the log recorded', () => {
    const rows = gateLineRows({ states: [], history: { campaigns: [
      { id: 'c7', author: 'human', lineIds: ['C7.1', 'C7.3', 'C7.9'], resealed: ['C7.3'], decided: true },
    ] } })
    expect(rows).toEqual([
      { campaign: 'c7', author: 'human', sealedAt: null, lineId: 'C7.1', outcome: 'held', resealedAtWave: null, firstPassWave: null, decided: true, source: 'history' },
      { campaign: 'c7', author: 'human', sealedAt: null, lineId: 'C7.3', outcome: 'resealed', resealedAtWave: null, firstPassWave: null, decided: true, source: 'history' },
      { campaign: 'c7', author: 'human', sealedAt: null, lineId: 'C7.9', outcome: 'held', resealedAtWave: null, firstPassWave: null, decided: true, source: 'history' },
    ])
  })

  it('a history entry that states its seal date carries it', () => {
    const rows = gateLineRows({ states: [], history: { campaigns: [
      { id: 'c7', author: 'human', sealedAt: '2026-08-14T00:00:00.000Z', lineIds: ['C7.1'], resealed: [], decided: true },
    ] } })
    expect(rows[0].sealedAt).toBe('2026-08-14T00:00:00.000Z')
  })

  it('carries the campaign seal date onto every one of its rows', () => {
    const rows = gateLineRows({ states: [{
      id: 'c9', author: 'cynco', sealedAt: '2026-09-23T10:00:00.000Z', decided: true,
      calibration: cal(['C9.1a', 'C9.2a']), reseals: [], waves: waves(['pass']),
    }] })
    expect(rows.map(r => r.sealedAt)).toEqual(['2026-09-23T10:00:00.000Z', '2026-09-23T10:00:00.000Z'])
  })

  // A record with no wave number is not wave 0: a faulted or hand-written
  // record can reach here without one, and 0 is an index nothing ever had.
  it('a passing wave record with no wave number reads as no firstPassWave', () => {
    const rows = gateLineRows({ states: [{
      id: 'c9', author: 'cynco', decided: true, calibration: cal([], ['C9.9']), reseals: [],
      waves: [{ gate: { passes: [{ id: 'C9.9', line: 'C9.9: PASS' }], fails: [] }, decision: { kind: 'pass' } }],
    }] })
    expect(rows[0].firstPassWave).toBeNull()
  })

  // The runner's own state is the authority: the history file is the record for
  // campaigns that ran before there WAS a runner record, and counting a
  // campaign from both would double its lines in the denominator.
  it('the runner state wins over a history entry for the same campaign', () => {
    const rows = gateLineRows({
      states: [{ id: 'c7', author: 'human', decided: true, calibration: cal(['C7.1']), reseals: [], waves: waves(['pass']) }],
      history: { campaigns: [{ id: 'c7', author: 'human', lineIds: ['C7.1', 'C7.3'], resealed: [], decided: true }] },
    })
    expect(rows.map(r => r.lineId)).toEqual(['C7.1'])
    expect(rows[0].source).toBe('runner')
  })

  it('a campaign with no calibration contributes nothing', () => {
    expect(gateLineRows({ states: [{ id: 'c9', author: 'cynco', decided: false, calibration: null, reseals: [], waves: [] }] })).toEqual([])
  })
})

// Phase 4 residual: the line is the evidence unit for "did the bar hold", but
// the SEAL is a campaign-level event — a gate the supervisor refused has no
// graded lines at all, so the line dataset cannot see it. One row per campaign.
describe('gateOutcomeRows', () => {
  const st = (over) => ({ id: 'c9', author: 'cynco', sealedAt: null, decided: false, refusals: [], attempts: null, reseals: [], ...over })
  const refusal = { at: 't', by: 'supervisor', notePath: 'C:/notes/c9-refusal.md' }

  it('refused: a CynCo gate with one refusal and no seal', () => {
    expect(gateOutcomeRows({ states: [st({ refusals: [refusal], attempts: 2 })] })).toEqual([
      { campaign: 'c9', author: 'cynco', outcome: 'refused', refusals: 1, attempts: 2, sealedAt: null },
    ])
  })

  it('held: sealed, decided, never resealed', () => {
    expect(gateOutcomeRows({ states: [st({ id: 'c8', author: 'human', sealedAt: '2026-09-05T00:00:00.000Z', decided: true })] })).toEqual([
      { campaign: 'c8', author: 'human', outcome: 'held', refusals: 0, attempts: null, sealedAt: '2026-09-05T00:00:00.000Z' },
    ])
  })

  it('resealed: sealed with at least one reseal, decided or not', () => {
    const reseal = { at: 't', wave: 2, from: { gateSha256: 'a' }, to: { gateSha256: 'b' }, changedLineIds: ['C9.2a'] }
    expect(gateOutcomeRows({ states: [st({ sealedAt: 'S', decided: true, reseals: [reseal] })] })[0].outcome).toBe('resealed')
    expect(gateOutcomeRows({ states: [st({ sealedAt: 'S', decided: false, reseals: [reseal] })] })[0].outcome).toBe('resealed')
  })

  it('sealed: sealed, the campaign still undecided, nothing resealed', () => {
    expect(gateOutcomeRows({ states: [st({ sealedAt: 'S', refusals: [refusal], attempts: 3 })] })).toEqual([
      { campaign: 'c9', author: 'cynco', outcome: 'sealed', refusals: 1, attempts: 3, sealedAt: 'S' },
    ])
  })

  it('a gate neither sealed nor refused is not an outcome yet', () => {
    expect(gateOutcomeRows({ states: [st({ attempts: 1 })] })).toEqual([])
  })

  it('history campaigns arrive with their author; the runner state wins a collision', () => {
    const history = { campaigns: [
      { id: 'c7', author: 'human', lineIds: ['C7.1'], resealed: ['C7.1'], decided: true },
      { id: 'c6', author: 'human', sealedAt: 'H', lineIds: ['C6.1'], resealed: [], decided: true },
      { id: 'c9', author: 'human', lineIds: ['C9.1'], resealed: [], decided: true },
    ] }
    expect(gateOutcomeRows({ states: [st({ sealedAt: 'S' })], history })).toEqual([
      { campaign: 'c9', author: 'cynco', outcome: 'sealed', refusals: 0, attempts: null, sealedAt: 'S' },
      { campaign: 'c7', author: 'human', outcome: 'resealed', refusals: 0, attempts: null, sealedAt: null },
      { campaign: 'c6', author: 'human', outcome: 'held', refusals: 0, attempts: null, sealedAt: 'H' },
    ])
  })
})

describe('summarize', () => {
  const row = (author, outcome, i) => ({ campaign: 'x', author, sealedAt: null, lineId: `L${author}${i}`, outcome, resealedAtWave: null, firstPassWave: null, decided: true, source: 'runner' })
  const many = (author, outcome, n, from = 0) => Array.from({ length: n }, (_, i) => row(author, outcome, from + i))

  it('counts terminal outcomes only — an open line is not evidence either way', () => {
    const s = summarize([...many('cynco', 'held', 28), ...many('cynco', 'resealed', 2, 28), ...many('cynco', 'open', 50, 30), ...many('human', 'held', 17)])
    expect(s.byAuthor.cynco).toEqual({ n: 30, held: 28, rate: 28 / 30, ci: wilson(28, 30) })
    expect(s.byAuthor.human).toEqual({ n: 17, held: 17, rate: 1, ci: wilson(17, 17) })
  })

  it('the Fisher table is held vs not-held, cynco row first', () => {
    const s = summarize([...many('cynco', 'held', 30), ...many('human', 'held', 17)])
    expect(s.fisher.table).toEqual([[30, 0], [17, 0]])
    expect(s.fisher.p).toBeCloseTo(fisherExact(30, 0, 17, 0), 10)
  })

  it('no rows at all reads as n 0, rate null, and the whole interval', () => {
    const s = summarize([])
    expect(s.byAuthor.cynco).toEqual({ n: 0, held: 0, rate: null, ci: [0, 1] })
    expect(s.fisher.table).toEqual([[0, 0], [0, 0]])
  })
})

describe('gateLineVerdict', () => {
  const summaryOf = (cynco, human) => summarize([
    ...Array.from({ length: cynco[0] }, (_, i) => ({ author: 'cynco', outcome: 'held', lineId: `h${i}` })),
    ...Array.from({ length: cynco[1] - cynco[0] }, (_, i) => ({ author: 'cynco', outcome: 'resealed', lineId: `r${i}` })),
    ...Array.from({ length: human[0] }, (_, i) => ({ author: 'human', outcome: 'held', lineId: `H${i}` })),
    ...Array.from({ length: human[1] - human[0] }, (_, i) => ({ author: 'human', outcome: 'resealed', lineId: `R${i}` })),
  ])

  it('TOO FEW below the minimum line count', () => { expect(gateLineVerdict(summaryOf([29, 29], [17, 17]))).toBe('TOO FEW') })
  it('PARITY at the floor with no significant shortfall', () => { expect(gateLineVerdict(summaryOf([30, 30], [17, 17]))).toBe('PARITY') })
  it('BELOW FLOOR when the Wilson lower bound is under 0.8', () => { expect(gateLineVerdict(summaryOf([22, 30], [17, 17]))).toBe('BELOW FLOOR') })
  it('BELOW FLOOR when CynCo is significantly worse than the human, floor or no floor', () => {
    expect(gateLineVerdict(summaryOf([92, 100], [200, 200]))).toBe('BELOW FLOOR')
  })

  it('the table header is the pinned one', () => {
    expect(gateLineTable(summaryOf([30, 30], [17, 17]))[0]).toBe('author  lines   held  rate     95% CI')
    expect(gateLineTable(summaryOf([30, 30], [17, 17])).join('\n')).toMatch(/PARITY/)
  })
})

describe('exportGateLines', () => {
  const write = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text, 'utf8') }

  function world() {
    const root = mkdtempSync(join(tmpdir(), 'gate-lines-'))
    const campaignsDir = join(root, 'campaigns')
    mkdirSync(join(campaignsDir, 'c9'), { recursive: true })
    writeFileSync(join(campaignsDir, 'c9', 'state.json'), JSON.stringify({
      id: 'c9', calibration: cal(['C9.1a', 'C9.2a'], ['C9.9']), waveCount: 2,
      reseals: [{ at: 't', wave: 1, from: { gateSha256: 'aaaa' }, to: { gateSha256: 'dddd' }, changedLineIds: ['C9.2a'] }],
      authoring: { c9: { sealedAt: '2026-09-20T00:00:00.000Z' } },
    }, null, 2))
    writeFileSync(join(campaignsDir, 'c9', 'waves.jsonl'),
      [{ wave: 1, gate: { author: 'cynco', passes: [], fails: [] }, decision: { kind: 'next' } },
       { wave: 2, gate: { author: 'cynco', passes: [{ id: 'C9.9', line: 'C9.9: PASS' }], fails: [] }, decision: { kind: 'pass' } }]
        .map(r => JSON.stringify(r)).join('\n') + '\n')
    const historyPath = join(root, 'gate-lines.history.json')
    write(historyPath, JSON.stringify({ note: 'n', campaigns: [{ id: 'c7', author: 'human', lineIds: ['C7.1', 'C7.3'], resealed: ['C7.3'], decided: true }] }, null, 2))
    return { root, campaignsDir, historyPath, outPath: join(root, 'datasets', 'gate-lines.jsonl') }
  }

  it('reads every campaign state plus the history and writes one row per graded line', () => {
    const w = world()
    const r = exportGateLines(w)
    expect(r.rows.map(x => [x.campaign, x.lineId, x.outcome, x.author])).toEqual([
      ['c9', 'C9.1a', 'held', 'cynco'],
      ['c9', 'C9.2a', 'resealed', 'cynco'],
      ['c9', 'C9.9', 'held', 'cynco'],
      ['c7', 'C7.1', 'held', 'human'],
      ['c7', 'C7.3', 'resealed', 'human'],
    ])
    expect(r.summary.byAuthor.cynco).toMatchObject({ n: 3, held: 2 })
    expect(r.summary.byAuthor.human).toMatchObject({ n: 2, held: 1 })
    // Every field of the row shape, spelled out once so a field that quietly
    // stops being written cannot pass on the projections above.
    expect(r.rows[1]).toEqual({
      campaign: 'c9', author: 'cynco', sealedAt: '2026-09-20T00:00:00.000Z', lineId: 'C9.2a',
      outcome: 'resealed', resealedAtWave: 1, firstPassWave: null, decided: true, source: 'runner',
    })
    const written = readFileSync(w.outPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(written).toEqual(r.rows)
    expect(existsSync(w.outPath + '.tmp')).toBe(false)
  })

  it('dates the seal from the authoring record, and from the calibration when a human sealed by hand', () => {
    const w = world()
    expect(exportGateLines(w).rows.find(r => r.campaign === 'c9').sealedAt).toBe('2026-09-20T00:00:00.000Z')

    // A human seals by writing the triple into the sealed tree by hand, so
    // there is no authoring record: the campaign's own first calibration is the
    // only stamp there has ever been.
    const s = JSON.parse(readFileSync(join(w.campaignsDir, 'c9', 'state.json'), 'utf8'))
    delete s.authoring
    writeFileSync(join(w.campaignsDir, 'c9', 'state.json'), JSON.stringify(s, null, 2))
    expect(exportGateLines(w).rows.find(r => r.campaign === 'c9').sealedAt).toBe('2026-09-01T00:00:00.000Z')

    // And a campaign that has never calibrated has no seal date to claim.
    s.calibration = null
    writeFileSync(join(w.campaignsDir, 'c9', 'state.json'), JSON.stringify(s, null, 2))
    expect(exportGateLines(w).rows.every(r => r.campaign !== 'c9')).toBe(true)
  })

  it('takes the author from the wave record, falling back to the authoring record', () => {
    const w = world()
    // No wave record carries an author (a campaign graded before Phase 3), but
    // the state dir holds the authoring record the gate-author seat wrote.
    writeFileSync(join(w.campaignsDir, 'c9', 'waves.jsonl'), JSON.stringify({ wave: 1, gate: { passes: [], fails: [] }, decision: { kind: 'pass' } }) + '\n')
    expect(exportGateLines(w).rows.every(r => r.campaign !== 'c9' || r.author === 'cynco')).toBe(true)

    // And with neither, a campaign is the human's until a record says otherwise.
    const s = JSON.parse(readFileSync(join(w.campaignsDir, 'c9', 'state.json'), 'utf8'))
    delete s.authoring
    writeFileSync(join(w.campaignsDir, 'c9', 'state.json'), JSON.stringify(s, null, 2))
    expect(exportGateLines(w).rows.every(r => r.campaign !== 'c9' || r.author === 'human')).toBe(true)
  })

  it('an absent history file is no history, not a throw', () => {
    const w = world()
    const r = exportGateLines({ ...w, historyPath: join(w.root, 'nope.json') })
    expect(r.rows.every(x => x.campaign === 'c9')).toBe(true)
  })

  it('an absent campaigns dir is no campaigns, not a throw', () => {
    const w = world()
    const r = exportGateLines({ ...w, campaignsDir: join(w.root, 'nope') })
    expect(r.rows.map(x => x.campaign)).toEqual(['c7', 'c7'])
  })

  it('exportGateOutcomes writes one row per campaign — a refused gate included, which has no lines to count', () => {
    const w = world()
    // c10: the seat staged a triple twice and the supervisor refused the seal once.
    mkdirSync(join(w.campaignsDir, 'c10'), { recursive: true })
    writeFileSync(join(w.campaignsDir, 'c10', 'state.json'), JSON.stringify({
      id: 'c10', authoring: { c10: { attempts: 2, refusals: [{ at: 't', by: 'supervisor', notePath: 'C:/n.md' }] } },
    }, null, 2))
    const outPath = join(w.root, 'datasets', 'gate-outcomes.jsonl')
    const r = exportGateOutcomes({ campaignsDir: w.campaignsDir, historyPath: w.historyPath, outPath })
    expect(r.rows).toEqual([
      { campaign: 'c10', author: 'cynco', outcome: 'refused', refusals: 1, attempts: 2, sealedAt: null },
      { campaign: 'c9', author: 'cynco', outcome: 'resealed', refusals: 0, attempts: null, sealedAt: '2026-09-20T00:00:00.000Z' },
      { campaign: 'c7', author: 'human', outcome: 'resealed', refusals: 0, attempts: null, sealedAt: null },
    ])
    expect(readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))).toEqual(r.rows)
    expect(existsSync(outPath + '.tmp')).toBe(false)
    // The line dataset still cannot see c10: it has no calibration, so no lines.
    expect(exportGateLines(w).rows.some(x => x.campaign === 'c10')).toBe(false)
  })

  it('the default outcomes path sits under the CynCo home of the moment', () => {
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = 'C:/tmp/some-home'
    try { expect(GATE_OUTCOMES_PATH().replace(/\\/g, '/')).toBe('C:/tmp/some-home/datasets/gate-outcomes.jsonl') }
    finally { if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev }
  })

  it('the default dataset path sits under the CynCo home of the moment', () => {
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = 'C:/tmp/some-home'
    try { expect(GATE_LINES_PATH().replace(/\\/g, '/')).toBe('C:/tmp/some-home/datasets/gate-lines.jsonl') }
    finally { if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev }
  })
})
