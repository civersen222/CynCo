import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  campaignScoreboard, pooledScoreboard, scoreboardLines, campaignDecision, gpuHours,
  passRatePerGpuHour, wavesPerCampaign, gateLinesFixedPerLandedWave, humanInterventionsPerWave,
  perRulePrecision, supervisionDollarsPerWave, parseSupervisionDollars, ENTRY_LINE_MAX,
} from '../cynco-scoreboard.mjs'
import { main, scoreboardEconomics, ECONOMICS_TIMEOUT_MS, defaultIo } from '../cynco-campaign.mjs'

// C8, reproduced from docs/civkings-redesign-briefs/campaign-log.md "## C8 wave
// 1/2/3": calibration BASE MISS 14 (the real base log's ids,
// fixtures/gate_c8_base.log), then 6 → 3 → 0 FAIL lines (wave 1's terminator
// said "MISS (10 fails)" but its record lists the 6 lines it printed — the
// definition reads `gate.fails.length`), 28824 s / 24147 s / 2345 s, 5 / 5 / 2
// commits, PASS at wave 3.
const FIX = fileURLToPath(new URL('./fixtures/scoreboard/', import.meta.url))
const jsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const c8State = () => JSON.parse(readFileSync(join(FIX, 'c8', 'state.json'), 'utf8'))
const c8Waves = () => jsonl(join(FIX, 'c8', 'waves.jsonl'))
const rows = () => jsonl(join(FIX, 'rows.jsonl'))
const spec = { id: 'c8' }
const HOURS = (28824 + 24147 + 2345) / 3600

// The real 2026-09-25 rebuild's shape: eight rules, none PREDICTIVE.
const rule = (verdict, precision, ci, n) => ({ verdict, precision, ci, p: 0.5, n, pAdjusted: 1, lift: 0, firedTotal: n, failures: Math.round(precision * n) })
const ruleVerdicts = { schema: 1, version: 3, rules: {
  C2: rule('TOO FEW — cannot tell', 0.2, [0.036, 0.624], 5),
  C4: rule('TOO FEW — cannot tell', 0.75, [0.3, 0.95], 4),
  W6: rule('TOO FEW — cannot tell', 0.4, [0.1, 0.8], 5),
  I1: rule('NO EVIDENCE', 0.549, [0.414, 0.677], 51),
  I3: rule('NO EVIDENCE', 0.58, [0.45, 0.70], 60),
  W7: rule('NO EVIDENCE', 0.5, [0.3, 0.7], 20),
  W8: rule('NO EVIDENCE', 0.52, [0.35, 0.69], 30),
  I4: rule('CONSTANT — fires on everything, predicts nothing', 0.57, [0.47, 0.66], 107),
} }
const ECONOMICS = ['VERDICT: frontier spent $4295.55 SUPERVISING (development $1692.01 and', 'unattributed $2.71 are excluded — building LocalCode is not oversight).']

const board = (over = {}) => campaignScoreboard({ spec, state: c8State(), waves: c8Waves(), rows: rows(), ...over })

describe('passRatePerGpuHour — decided-PASS campaigns ÷ Σ durationS/3600', () => {
  it('C8: 1 PASS over 15.37 GPU-h', () => {
    const r = passRatePerGpuHour({ waves: c8Waves(), rows: rows() })
    expect(r.value).toBeCloseTo(1 / HOURS, 10)
    expect(r.value.toFixed(3)).toBe('0.065')
    expect(board().passRatePerGpuHour).toBeCloseTo(1 / HOURS, 10)
    expect(board().gpuHours).toBeCloseTo(HOURS, 10)
  })
  it('a wave record\'s own durationS wins over the ledger row\'s', () => {
    const ws = c8Waves(); ws[2].durationS = 3600
    expect(gpuHours({ waves: ws, rows: rows() }).hours).toBeCloseTo((28824 + 24147 + 3600) / 3600, 10)
  })
  it('an open campaign is null with the reason `open`, never 0', () => {
    const r = passRatePerGpuHour({ waves: c8Waves().slice(0, 2), rows: rows() })
    expect(r.value).toBeNull()
    expect(r.reason).toMatch(/^open/)
  })
})

// Final review I2: a fault's wall-clock `durationS` (faultWave's
// `durationFrom: 'wall-clock'`) is an UPPER bound on the hours. It is counted,
// but the rate over it is a floor: flagged, named in `unmeasured`, printed `≥`.
describe('a wall-clock upper bound in the hours makes the rate a floor', () => {
  const walled = () => { const ws = c8Waves(); ws[0].durationS = 28824; ws[0].durationFrom = 'wall-clock'; return ws }

  it('module: gpuHours names the wave; the board flags the rate and says why', () => {
    expect(gpuHours({ waves: walled(), rows: rows() }).upperBound).toEqual([1])
    // A row-measured duration, or the ledger row's own, is never an upper bound.
    const rowFrom = c8Waves(); rowFrom[0].durationS = 28824; rowFrom[0].durationFrom = 'row'
    expect(gpuHours({ waves: rowFrom, rows: rows() }).upperBound).toEqual([])
    const b = board({ waves: walled() })
    expect(b.passRatePerGpuHour).toBeCloseTo(1 / HOURS, 10)
    expect(b.passRatePerGpuHourIsLowerBound).toBe(true)
    expect(b.gpuHoursUpperBound).toEqual([1])
    expect(b.unmeasured).toContain('gpuHours: wave 1 hours are a wall-clock upper bound (fault) — the rate is a floor')
    // Without one, the flag is false and nothing is added.
    expect(board().passRatePerGpuHourIsLowerBound).toBe(false)
    expect(board().gpuHoursUpperBound).toEqual([])
  })

  it('an open campaign is never flagged — it has no rate to bound', () => {
    const b = board({ waves: walled().slice(0, 2) })
    expect(b.passRatePerGpuHour).toBeNull()
    expect(b.passRatePerGpuHourIsLowerBound).toBe(false)
  })

  it('verdict line and detail print ≥', () => {
    const b = board({ waves: walled(), ruleVerdicts })
    expect(scoreboardLines(b)[0]).toMatch(/^- Scoreboard: PASS\/GPU-h ≥ 0\.065 \| waves 3 \| /)
    const detail = scoreboardLines(b, { detail: true }).join('\n')
    expect(detail).toContain('passRatePerGpuHour ≥ 0.065 = 1 PASS ÷ 15.37 GPU-h, an upper bound (wave 1 hours are a fault\'s wall clock)')
    expect(detail).toContain('unmeasured: gpuHours: wave 1 hours are a wall-clock upper bound (fault) — the rate is a floor')
  })

  it('pooled: the bound is named by campaign, the rate flagged and printed ≥', () => {
    const p = pooledScoreboard([board({ waves: walled() })])
    expect(p.gpuHoursUpperBound).toEqual(['c8 wave 1'])
    expect(p.passRatePerGpuHourIsLowerBound).toBe(true)
    expect(p.unmeasured).toContain('gpuHours: c8 wave 1 hours are a wall-clock upper bound (fault) — the rate is a floor')
    expect(scoreboardLines(p)[0]).toMatch(/PASS\/GPU-h ≥ 0\.065 \| /)
    expect(pooledScoreboard([board()]).passRatePerGpuHourIsLowerBound).toBe(false)
  })
})

describe('wavesPerCampaign — waves to the decision', () => {
  it('C8 decided at wave 3', () => {
    expect(wavesPerCampaign({ waves: c8Waves() })).toEqual({ value: 3, reason: null })
    expect(board()).toMatchObject({ decided: true, decision: 'pass', waves: 3, wavesPerCampaign: 3 })
  })
  it('a STOP record (a refusal to dispatch) is not a spent wave and does not undo the decision', () => {
    const ws = [...c8Waves(), { wave: 4, missionId: null, decision: { kind: 'stop', why: 'no failing gate lines to work — grade says PASS' } }]
    expect(campaignDecision(ws)).toMatchObject({ decided: true, decision: 'pass', spent: 3 })
  })
  it('a budget stop the operator resumed is not a decision (the real C8 waves 1–2 read STOP (budget))', () => {
    const ws = c8Waves().map((w, i) => i < 2 ? { ...w, decision: { kind: 'budget', why: 'x' } } : w)
    expect(campaignDecision(ws).decided).toBe(true)
    expect(campaignDecision(ws.slice(0, 2))).toMatchObject({ decided: false, decision: 'budget' })
  })
})

describe('gateLinesFixedPerLandedWave — Σ max(0, before − after) over waves with ≥ 1 commit ÷ those waves', () => {
  it('C8: ((14−6) + (6−3) + (3−0)) / 3 = 4.667', () => {
    const r = gateLinesFixedPerLandedWave({ state: c8State(), waves: c8Waves() })
    expect(r).toMatchObject({ landedWaves: 3, fixed: 14 })
    expect(r.value).toBeCloseTo(14 / 3, 10)
    expect(r.value.toFixed(3)).toBe('4.667')
  })
  it('a wave that landed nothing is out of the denominator but still moves failsBefore', () => {
    const ws = c8Waves(); ws[1].outcome.commitsLanded = 0
    const r = gateLinesFixedPerLandedWave({ state: c8State(), waves: ws })
    // wave 1: 14→6 (8), wave 2 excluded, wave 3: 3→0 (3)
    expect(r).toMatchObject({ landedWaves: 2, fixed: 11, value: 5.5 })
  })
  it('a regression counts 0, never negative', () => {
    const ws = c8Waves(); ws[1].gate.fails = [...ws[1].gate.fails, ...Array.from({ length: 5 }, (_, i) => ({ id: `X${i}`, line: 'x' }))]
    const r = gateLinesFixedPerLandedWave({ state: c8State(), waves: ws })
    expect(r.fixed).toBe(8 + 0 + 8)
  })
  it('a graded wave with no commit count is excluded and named, never read as 0 commits', () => {
    const ws = c8Waves(); delete ws[0].outcome.commitsLanded
    const r = gateLinesFixedPerLandedWave({ state: c8State(), waves: ws })
    expect(r).toMatchObject({ landedWaves: 2, fixed: 6 })
    expect(r.excluded).toEqual([expect.stringMatching(/^wave 1 .*commitsLanded/)])
  })
  it('the last graded wave falls back to state.lastCommits (what --autopoiesis reads)', () => {
    const ws = c8Waves(); delete ws[2].outcome.commitsLanded
    const s = c8State(); s.lastRow = { missionId: ws[2].missionId }
    expect(gateLinesFixedPerLandedWave({ state: s, waves: ws })).toMatchObject({ landedWaves: 3, fixed: 14 })
  })
  it('no landed wave: null with a reason', () => {
    const ws = c8Waves().map(w => ({ ...w, outcome: { ...w.outcome, commitsLanded: 0 } }))
    const r = gateLinesFixedPerLandedWave({ state: c8State(), waves: ws })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('no wave landed a commit')
  })
  it('commit counts unknown is not "no wave landed a commit" (review M3)', () => {
    const ws = c8Waves().map(w => { const o = { ...w.outcome }; delete o.commitsLanded; return { ...w, outcome: o } })
    expect(gateLinesFixedPerLandedWave({ state: c8State(), waves: ws }).reason).toBe('commit counts unknown (see unmeasured)')
    const mixed = c8Waves().map((w, i) => i === 0 ? { ...w, outcome: { ...w.outcome, commitsLanded: 0 } } : { ...w, outcome: { exitReason: 'x' } })
    expect(gateLinesFixedPerLandedWave({ state: c8State(), waves: mixed }).reason).toBe('no known-count wave landed; 2 unknown (see unmeasured)')
    const faults = [{ wave: 1, missionId: null, decision: { kind: 'fault', why: 'x' } }]
    expect(gateLinesFixedPerLandedWave({ state: c8State(), waves: faults }).reason).toBe('every wave excluded — none graded a gate (see unmeasured)')
  })
})

describe('humanInterventionsPerWave — (notes + human decisions + refusals + reseals + adoptions) ÷ waves', () => {
  it('C8: one delivered operator note over three waves', () => {
    const r = humanInterventionsPerWave({ state: c8State(), waves: c8Waves(), rows: rows() })
    expect(r).toMatchObject({ notes: 1, humanDecisions: 0, refusals: 0, reseals: 0, adopted: 0 })
    expect(r.value).toBeCloseTo(1 / 3, 10)
  })
  it('the driver\'s re-injected probe is not a human act; an undelivered note is not delivered', () => {
    // rows.jsonl wave 2 carries both; neither counts.
    const onlyWave2 = rows().filter(r => r.missionId.startsWith('c8-wave2'))
    expect(humanInterventionsPerWave({ state: c8State(), waves: c8Waves(), rows: onlyWave2 }).notes).toBe(0)
  })
  it('counts each kind of human act, and only human ones', () => {
    const s = c8State()
    s.proposals = [
      { name: 'invariants/editGapCap', status: 'approved', decidedAt: 't' }, // an operator verb (no decidedBy is written for it)
      { name: 'gate/c9', status: 'rejected', decidedAt: 't', decidedBy: 'supervisor' },
      { name: 'gate/c10', status: 'approved', decidedAt: 't', decidedBy: 'auto' }, // the seat sealed at earned authority
      { name: 'ideation/brief', status: 'pending' },
    ]
    s.authoring = { c9: { refusals: [{ by: 'supervisor' }, { by: 'supervisor' }] }, c10: {} }
    s.reseals = [{ wave: 1 }]
    const ws = c8Waves(); ws[1].adopted = true
    const r = humanInterventionsPerWave({ state: s, waves: ws, rows: rows() })
    expect(r).toMatchObject({ notes: 1, humanDecisions: 2, refusals: 2, reseals: 1, adopted: 1 })
    expect(r.value).toBeCloseTo(7 / 3, 10)
  })
  // Phase 6 ruling 8 (F164's second WRONG): C9's two AUTHORING-phase supervisor
  // refusals read as 1.00 intervention per wave. With a seal record the count
  // starts at the seal; what it leaves out is named, never silently dropped.
  describe('counts from the seal when the campaign has one', () => {
    const SEAL = '2026-09-27T12:00:00.000Z'
    const sealedState = () => {
      const s = c8State()
      s.authoring = { c8: { sealedAt: SEAL, refusals: [
        { at: '2026-09-26T09:00:00.000Z', by: 'supervisor', notePath: 'a.md' }, // authoring phase
        { at: '2026-09-28T09:00:00.000Z', by: 'supervisor', notePath: 'b.md' }, // after the seal
      ] } }
      return s
    }
    it('a refusal dated before sealedAt is excluded and named; one after counts', () => {
      const r = humanInterventionsPerWave({ spec, state: sealedState(), waves: c8Waves(), rows: rows() })
      expect(r).toMatchObject({ notes: 1, refusals: 1, beforeSeal: 1, undated: 0, sealedAt: SEAL })
      expect(r.value).toBeCloseTo(2 / 3, 10)
      const b = board({ state: sealedState() })
      expect(b.humanInterventionsPerWave.refusals).toBe(1)
      expect(b.unmeasured).toContainEqual('humanInterventionsPerWave: 1 act(s) before the seal (2026-09-27T12:00:00.000Z) not counted — authoring-phase, not campaign, interventions')
    })
    it('decisions are filtered by decidedAt the same way', () => {
      const s = sealedState(); s.authoring.c8.refusals = []
      s.proposals = [
        { name: 'gate/c8', status: 'approved', decidedAt: '2026-09-27T11:59:59.000Z', decidedBy: 'supervisor' },
        { name: 'invariants/editGapCap', status: 'approved', decidedAt: '2026-09-28T00:00:00.000Z' },
      ]
      const r = humanInterventionsPerWave({ spec, state: s, waves: c8Waves(), rows: rows() })
      expect(r).toMatchObject({ humanDecisions: 1, beforeSeal: 1 })
    })
    it('an undated act still counts, and is named as undated', () => {
      const s = sealedState(); s.authoring.c8.refusals.push({ by: 'supervisor' })
      const r = humanInterventionsPerWave({ spec, state: s, waves: c8Waves(), rows: rows() })
      expect(r).toMatchObject({ refusals: 2, beforeSeal: 1, undated: 1 })
      expect(board({ state: s }).unmeasured).toContainEqual(expect.stringMatching(/^humanInterventionsPerWave: 1 act\(s\) carry no date — counted/))
    })
    it('a campaign with no seal record counts as before, and the other campaigns\' seal does not apply', () => {
      const s = sealedState(); s.authoring = { c9: s.authoring.c8 }
      const r = humanInterventionsPerWave({ spec, state: s, waves: c8Waves(), rows: rows() })
      expect(r).toMatchObject({ refusals: 2, beforeSeal: 0, undated: 0, sealedAt: null })
      // no spec at all: the old call shape, the old count
      expect(humanInterventionsPerWave({ state: sealedState(), waves: c8Waves(), rows: rows() }).refusals).toBe(2)
    })
    it('the pooled board carries the before-seal note, prefixed with the campaign', () => {
      const p = pooledScoreboard([board({ state: sealedState() })])
      expect(p.unmeasured).toContainEqual(expect.stringMatching(/^humanInterventionsPerWave: c8 1 act\(s\) before the seal/))
    })
  })
  it('a delivered note with no `source` is unknown, not counted, and named in unmeasured', () => {
    const rs = rows(); rs[2].operatorNotes = [{ text: 'x', source: null, deliveredAtIteration: 3, dropped: null }]
    const b = board({ rows: rs })
    expect(b.humanInterventionsPerWave.notes).toBe(1)
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^humanInterventionsPerWave: 1 delivered note\(s\) carry no source/))
  })
})

describe('perRulePrecision — predictive ÷ total, and the best rule', () => {
  it('0 of 8 predictive; the best is the most precise rule with enough evidence (a TOO FEW rule never wins)', () => {
    expect(perRulePrecision(ruleVerdicts)).toEqual({ predictive: 0, total: 8, best: { id: 'I3', precision: 0.58, ci: [0.45, 0.70], verdict: 'NO EVIDENCE' }, learner: null })
  })
  it('the learner\'s M1.* rows are not rules: neither counted nor ranked; the best of them is the `learner` field', () => {
    // A PREDICTIVE and more precise model row would win `best` and move the count if it were read as a rule.
    const rv = { rules: { ...ruleVerdicts.rules,
      'M1.gbt': { ...rule('PREDICTIVE', 0.9, [0.6, 0.98], 10), source: 'model', scope: 'holdout' },
      'M1.lr': { ...rule('NO EVIDENCE', 0.5, [0.2, 0.8], 8), source: 'model', scope: 'holdout' } } }
    expect(perRulePrecision(rv)).toEqual({ predictive: 0, total: 8, best: { id: 'I3', precision: 0.58, ci: [0.45, 0.70], verdict: 'NO EVIDENCE' },
      learner: { id: 'M1.gbt', precision: 0.9, ci: [0.6, 0.98], verdict: 'PREDICTIVE' } })
    const line = scoreboardLines(board({ ruleVerdicts: rv, economics: ECONOMICS }))[0]
    expect(line).toBe('- Scoreboard: PASS/GPU-h 0.065 | waves 3 | lines fixed per landed wave 4.67 | human interventions per wave 0.33 | rules predictive 0/8 (best I3 58% NO EVIDENCE) | learner M1.gbt 90% PREDICTIVE')
    const detail = scoreboardLines(board({ ruleVerdicts: rv }), { detail: true })
    expect(detail).toContain('  perRulePrecision 0/8 predictive; best I3 58% [45,70] NO EVIDENCE')
    expect(detail).toContain('  learner M1.gbt 90% [60,98] PREDICTIVE')
  })
  it('model rows only: 0/0 rules, no best rule, the learner still read', () => {
    const rv = { rules: { 'M1.lr': { ...rule('TOO FEW — cannot tell', 0.5, [0.2, 0.8], 4), source: 'model' } } }
    expect(perRulePrecision(rv)).toEqual({ predictive: 0, total: 0, best: null, learner: { id: 'M1.lr', precision: 0.5, ci: [0.2, 0.8], verdict: 'TOO FEW — cannot tell' } })
  })
  it('a PREDICTIVE rule outranks a more precise one', () => {
    const rv = { rules: { ...ruleVerdicts.rules, W7: rule('PREDICTIVE', 0.55, [0.5, 0.6], 40) } }
    expect(perRulePrecision(rv)).toMatchObject({ predictive: 1, total: 8, best: { id: 'W7', verdict: 'PREDICTIVE' } })
  })
  it('no verdict file: null, and the board says why', () => {
    expect(perRulePrecision(null)).toBeNull()
    expect(board().unmeasured).toContainEqual(expect.stringMatching(/^perRulePrecision: no rule-verdicts\.json/))
  })
})

describe('supervisionDollarsPerWave — the economics script\'s SUPERVISING dollars ÷ waves', () => {
  it('parses the VERDICT line as the economics script prints it, array or text', () => {
    expect(parseSupervisionDollars(ECONOMICS)).toBe(4295.55)
    expect(parseSupervisionDollars(ECONOMICS.join(' '))).toBe(4295.55)
    expect(parseSupervisionDollars('SUPERVISING $12.50')).toBe(12.5)
    expect(parseSupervisionDollars([])).toBeNull()
    expect(parseSupervisionDollars(null)).toBeNull()
  })
  it('is measured when the line is there', () => {
    expect(supervisionDollarsPerWave({ economics: ECONOMICS, waves: 3 }).value).toBeCloseTo(4295.55 / 3, 10)
    expect(board({ economics: ECONOMICS })).toMatchObject({ supervisionDollars: 4295.55 })
    expect(board({ economics: ECONOMICS }).unmeasured.some(u => u.startsWith('supervisionDollarsPerWave'))).toBe(false)
  })
  it('`unmeasured` names it when economics is null — null, never 0', () => {
    const b = board()
    expect(b.supervisionDollarsPerWave).toBeNull()
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^supervisionDollarsPerWave: /))
  })
})

describe('campaignScoreboard', () => {
  it('C8 in full', () => {
    const b = board({ ruleVerdicts, economics: ECONOMICS })
    expect(b).toMatchObject({
      id: 'c8', decided: true, decision: 'pass', waves: 3, wavesPerCampaign: 3,
      gateLinesFixedPerLandedWave: { landedWaves: 3, fixed: 14 },
      humanInterventionsPerWave: { notes: 1, humanDecisions: 0, refusals: 0, reseals: 0, adopted: 0 },
      perRulePrecision: { predictive: 0, total: 8, best: { id: 'I3' } },
      unmeasured: [],
    })
    expect(b.passRatePerGpuHour).toBeCloseTo(1 / HOURS, 10)
    expect(b.supervisionDollarsPerWave).toBeCloseTo(4295.55 / 3, 10)
  })

  it('an open campaign (wave 3 dropped): no pass rate, no waves-to-decision, decided false', () => {
    const b = board({ waves: c8Waves().slice(0, 2) })
    expect(b).toMatchObject({ decided: false, decision: 'next', waves: 2, passRatePerGpuHour: null, wavesPerCampaign: null })
    expect(b.gpuHours).toBeCloseTo((28824 + 24147) / 3600, 10)
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^passRatePerGpuHour: open/))
  })

  it('a fault wave (no gate) is excluded from lines-fixed and counted in unmeasured', () => {
    const ws = c8Waves()
    const fault = { wave: 3, missionId: null, briefFile: 'docs/civkings-redesign-briefs/c8-wave3.txt', base: ws[1].head, dispatchedAt: 't', decision: { kind: 'fault', why: 'driver is gone and wrote no ledger row' } }
    const b = board({ waves: [ws[0], ws[1], fault, { ...ws[2], wave: 4 }] })
    // wave 4's failsBefore is wave 2's 3 — the fault graded nothing.
    expect(b.gateLinesFixedPerLandedWave).toMatchObject({ landedWaves: 3, fixed: 14 })
    expect(b.waves).toBe(4)
    expect(b.wavesPerCampaign).toBe(4)
    expect(b.humanInterventionsPerWave.value).toBeCloseTo(1 / 4, 10)
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^gateLinesFixedPerLandedWave: wave 3 graded no gate \(fault\)/))
    // it spent a wave, but no ledger row says for how long: the hours are a floor and say so
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^gpuHours: wave 3 has no durationS/))
    // …and a floor is no denominator: the PASS rate is null with the reason, not an overstated number (review M1)
    expect(b.decided).toBe(true)
    expect(b.passRatePerGpuHour).toBeNull()
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^passRatePerGpuHour: hours unmeasured for wave 3 — an unmeasured hour cannot make a denominator$/))
    expect(scoreboardLines(b)[0]).toMatch(/^- Scoreboard: PASS\/GPU-h null \(hours unmeasured for wave 3\) \| waves 4 \| /)
  })

  it('no waves at all: every per-wave number is null with a reason', () => {
    const b = board({ waves: [] })
    expect(b).toMatchObject({ waves: 0, decided: false, passRatePerGpuHour: null, wavesPerCampaign: null, gpuHours: null })
    expect(b.humanInterventionsPerWave.value).toBeNull()
    expect(b.gateLinesFixedPerLandedWave.value).toBeNull()
  })
})

describe('pooledScoreboard — over runner-driven campaigns', () => {
  // A second campaign: open after two landed waves, 10 → 7 → 4 fails, 2 h + 1 h, one reseal.
  const c9 = () => campaignScoreboard({ spec: { id: 'c9' },
    state: { calibration: { baseFails: Array.from({ length: 10 }, (_, i) => ({ id: `C9.${i}`, line: 'x' })) }, reseals: [{ wave: 1 }], proposals: [] },
    waves: [
      { wave: 1, missionId: 'c9-w1', gradedAt: 't', gate: { terminator: 'MISS', fails: Array.from({ length: 7 }, (_, i) => ({ id: `C9.${i}` })) }, outcome: { commitsLanded: 3 }, durationS: 7200, decision: { kind: 'next' } },
      { wave: 2, missionId: 'c9-w2', gradedAt: 't', gate: { terminator: 'MISS', fails: Array.from({ length: 4 }, (_, i) => ({ id: `C9.${i}` })) }, outcome: { commitsLanded: 1 }, durationS: 3600, decision: { kind: 'next' } },
    ], rows: [] })

  it('pass rate over every runner-driven hour; waves over decided campaigns only; ratios pooled over waves', () => {
    const p = pooledScoreboard([board(), c9()])
    expect(p).toMatchObject({ campaigns: 2, decided: 1, excluded: [] })
    expect(p.passRatePerGpuHour).toBeCloseTo(1 / (HOURS + 3), 10)
    expect(p.wavesPerCampaign).toBe(3)
    expect(p.gateLinesFixedPerLandedWave).toMatchObject({ landedWaves: 5, fixed: 14 + 6 })
    expect(p.gateLinesFixedPerLandedWave.value).toBeCloseTo(20 / 5, 10)
    expect(p.humanInterventionsPerWave).toMatchObject({ notes: 1, reseals: 1 })
    expect(p.humanInterventionsPerWave.value).toBeCloseTo(2 / 5, 10)
  })

  it('a board that could not be computed, or has no waves, is excluded and named', () => {
    const p = pooledScoreboard([board(), { id: 'c7', error: 'boom' }, campaignScoreboard({ spec: { id: 'c10' }, state: {}, waves: [], rows: [] })], { excluded: ['12 ledger mission(s) outside any runner-driven campaign (hand-driven)'] })
    expect(p.campaigns).toBe(1)
    expect(p.excluded).toEqual(['c7: boom', 'c10: no waves spent', '12 ledger mission(s) outside any runner-driven campaign (hand-driven)'])
  })

  it('nothing decided yet: pass rate and waves are null, never 0', () => {
    const p = pooledScoreboard([c9()])
    expect(p.passRatePerGpuHour).toBeNull()
    expect(p.wavesPerCampaign).toBeNull()
    expect(p.unmeasured).toContainEqual(expect.stringMatching(/^passRatePerGpuHour: no runner-driven campaign has decided/))
  })

  it('an unmeasured hour in ANY campaign makes the pooled rate null, named by campaign (review M1)', () => {
    const open = campaignScoreboard({ spec: { id: 'c9' }, state: {}, rows: [],
      waves: [{ wave: 1, missionId: null, decision: { kind: 'fault', why: 'driver is gone' } }] })
    const p = pooledScoreboard([board(), open])
    expect(p.decided).toBe(1)
    expect(p.passRatePerGpuHour).toBeNull()
    expect(p.unmeasured).toContainEqual('passRatePerGpuHour: hours unmeasured for c9 wave 1 — an unmeasured hour cannot make a denominator')
  })

  it('every campaign\'s excluded waves reach the pooled board, prefixed by campaign (review M4)', () => {
    const ws = c8Waves(); delete ws[0].outcome.commitsLanded
    const rs = rows(); rs[2].operatorNotes = [{ source: null, deliveredAtIteration: 3 }]
    const p = pooledScoreboard([board({ waves: ws, rows: rs }), c9()])
    expect(p.unmeasured).toContainEqual(expect.stringMatching(/^gateLinesFixedPerLandedWave: c8 wave 1 has no commitsLanded/))
    expect(p.unmeasured).toContainEqual(expect.stringMatching(/^humanInterventionsPerWave: c8 1 delivered note\(s\) carry no source/))
    expect(p.gateLinesFixedPerLandedWave).toMatchObject({ landedWaves: 4, known: 4, unknown: 1 })
  })

  it('one spelling: the pooled board of one campaign reads that campaign\'s own numbers (review M2)', () => {
    const b = board({ ruleVerdicts, economics: ECONOMICS })
    const p = pooledScoreboard([b])
    expect(p.passRatePerGpuHour).toBe(b.passRatePerGpuHour)
    expect(p.gateLinesFixedPerLandedWave.value).toBe(b.gateLinesFixedPerLandedWave.value)
    expect(p.humanInterventionsPerWave.value).toBe(b.humanInterventionsPerWave.value)
    expect(p.supervisionDollarsPerWave).toBe(b.supervisionDollarsPerWave)
    // and an unmeasured supervision figure carries the campaign's own reason
    expect(pooledScoreboard([board()]).unmeasured).toContainEqual('supervisionDollarsPerWave: no economics line (the economics script did not run)')
  })
})

describe('scoreboardLines', () => {
  it('the verdict entry\'s one line', () => {
    expect(scoreboardLines(board({ ruleVerdicts, economics: ECONOMICS }))).toEqual([
      '- Scoreboard: PASS/GPU-h 0.065 | waves 3 | lines fixed per landed wave 4.67 | human interventions per wave 0.33 | rules predictive 0/8 (best I3 58% NO EVIDENCE)',
    ])
  })
  it(`the entry line never exceeds ${200} characters; the verdict prints its head only (review M5)`, () => {
    // the worst board a VERDICT can produce: decided with an unmeasured hour, commit counts unknown, a long best-rule verdict
    const ws = c8Waves().map(w => { const o = { ...w.outcome }; delete o.commitsLanded; return { ...w, outcome: o, durationS: undefined } })
    const worst = board({ waves: [...ws, { wave: 4, missionId: null, decision: { kind: 'fault', why: 'x' } }, { ...ws[2], wave: 5 }], rows: [],
      ruleVerdicts: { rules: { W7: rule('NOT AFTER CORRECTION — chance across this many rules', 0.61, [0.5, 0.7], 40),
        'M1.gbt': { ...rule('NOT AFTER CORRECTION — chance across this many rules', 0.62, [0.5, 0.7], 40), source: 'model' } } } })
    const line = scoreboardLines(worst)[0]
    expect(line.length).toBeLessThanOrEqual(ENTRY_LINE_MAX)
    expect(ENTRY_LINE_MAX).toBe(200)
    expect(line).toContain('(best W7 61% NOT AFTER CORRECTION)')
    // the last tier: bare nulls AND the learner's verdict gone (the verb's detail keeps it)
    expect(line.endsWith('| learner M1.gbt 62%')).toBe(true)
    // no verdicts, open, nothing measured: still under the cap
    const bare = scoreboardLines(campaignScoreboard({ spec: { id: 'c12345' }, state: {}, rows: [], waves: [{ wave: 1, decision: { kind: 'fault', why: 'x' } }] }))[0]
    expect(bare.length).toBeLessThanOrEqual(ENTRY_LINE_MAX)
  })
  it('an open campaign prints `open` and `N so far (open)`', () => {
    expect(scoreboardLines(board({ waves: c8Waves().slice(0, 2), ruleVerdicts }))[0])
      .toMatch(/^- Scoreboard: PASS\/GPU-h open \| waves 2 so far \(open\) \| lines fixed per landed wave 5\.50 \| /)
  })
  it('prints `null (reason)` for anything unmeasured', () => {
    const ws = c8Waves().map(w => ({ ...w, outcome: { ...w.outcome, commitsLanded: 0 } }))
    const line = scoreboardLines(board({ waves: ws }))[0]
    expect(line).toContain('lines fixed per landed wave null (no wave landed a commit)')
    expect(line).toContain('rules predictive null (no rule-verdicts.json')
  })
  it('a board that threw prints UNMEASURED with the message; nothing prints for no board', () => {
    expect(scoreboardLines({ error: 'boom' })).toEqual(['- Scoreboard: UNMEASURED — boom'])
    expect(scoreboardLines(null)).toEqual([])
  })
  it('detail: one line per definition, the supervision dollars and every unmeasured reason', () => {
    const lines = scoreboardLines(board({ ruleVerdicts }), { detail: true })
    expect(lines[0]).toMatch(/^- Scoreboard: /)
    expect(lines.join('\n')).toMatch(/gpuHours 15\.37 over 3 wave\(s\)/)
    expect(lines.join('\n')).toMatch(/humanInterventionsPerWave 0\.33 = \(notes 1 \+ human decisions 0 \+ refusals 0 \+ reseals 0 \+ adoptions 0\) ÷ 3/)
    expect(lines.join('\n')).toMatch(/supervisionDollarsPerWave null \(/)
    // the full best-rule detail (CI and whole verdict) lives here, not on the entry line
    expect(lines).toContain('  perRulePrecision 0/8 predictive; best I3 58% [45,70] NO EVIDENCE')
    expect(lines).toContain('  learner none (no M1.* row in rule-verdicts.json)')
  })
  it('the pooled board', () => {
    const lines = scoreboardLines(pooledScoreboard([board()], { excluded: ['c7: no waves.jsonl (not runner-driven)'] }))
    expect(lines[0]).toMatch(/^Pooled over 1 runner-driven campaign\(s\), 1 decided: PASS\/GPU-h 0\.065 \| waves per campaign 3\.00 \| lines fixed per landed wave 4\.67 \| human interventions per wave 0\.33$/)
    expect(lines).toContain('Excluded: c7: no waves.jsonl (not runner-driven)')
  })
})

describe('main --scoreboard', () => {
  const BASE = '1d03308edb7684b61319a55f8a122deb9840ab5a'
  const specFile = (home) => {
    const heldout = join(home, 'heldout', 'civkings-redesign', 'c8')
    mkdirSync(heldout, { recursive: true })
    for (const n of ['gate_c8.py', 'perturb_c8.py']) writeFileSync(join(heldout, n), '# instrument\n')
    const p = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json')
    writeFileSync(p, JSON.stringify({ id: 'c8', title: 't', repo: '.', base: BASE, marker: 'stage c8 complete', keepGreen: 'python -m pytest a.py -q',
      gate: join(heldout, 'gate_c8.py'), perturb: join(heldout, 'perturb_c8.py'), suiteBaseline: join(heldout, 'suite-baseline.json'),
      budget: { hoursPerWave: 8, iterations: 2000, bashTimeoutMs: 1000, waves: 3 }, invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
      posiwid: { sourceEditShare: 0.3, commitEvery: 60 }, allow: { newFiles: ['gilded/ui/portraits.py'], edit: ['gilded/ui/atlas_view.py'] },
      deny: [], measures: 'M', work: [{ id: 1, title: 'W', gateIds: ['C8.1a'], text: 't' }], rules: [], ideation: { enabled: false } }))
    return p
  }
  const withHome = async (home, fn) => {
    const prev = process.env.CYNCO_HOME
    process.env.CYNCO_HOME = home
    try { return await fn() } finally { if (prev === undefined) delete process.env.CYNCO_HOME; else process.env.CYNCO_HOME = prev }
  }
  const capture = async (fn) => {
    const out = [], err = []
    const [log, error] = [console.log, console.error]
    console.log = (...a) => { out.push(a.join(' ')) }
    console.error = (...a) => { err.push(a.join(' ')) }
    try { return { code: await fn(), out: out.join('\n'), err: err.join('\n') } } finally { console.log = log; console.error = error }
  }
  const noBash = () => { throw new Error('--scoreboard must not need bash') }

  it('prints the campaign board and the pooled board, writes nothing, exits 0', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const c8 = join(home, 'campaigns', 'c8'); mkdirSync(c8, { recursive: true })
    copyFileSync(join(FIX, 'c8', 'state.json'), join(c8, 'state.json'))
    copyFileSync(join(FIX, 'c8', 'waves.jsonl'), join(c8, 'waves.jsonl'))
    // a hand-driven campaign dir (no waves.jsonl) is excluded and named
    mkdirSync(join(home, 'campaigns', 'c7'), { recursive: true })
    writeFileSync(join(home, 'campaigns', 'c7', 'state.json'), '{}')
    mkdirSync(join(home, 'datasets'), { recursive: true })
    writeFileSync(join(home, 'datasets', 'rule-verdicts.json'), JSON.stringify(ruleVerdicts))
    const before = readFileSync(join(c8, 'state.json'), 'utf8')
    const ledger = [...rows(), { missionId: 'stage6b-hand-1', durationS: 100 }]
    const { code, out } = await withHome(home, () => capture(() => main([specFile(home), '--scoreboard'],
      { readLedgerRows: () => ledger, economics: () => ECONOMICS, bashExe: noBash, dispatch: () => { throw new Error('must not dispatch') } })))
    expect(code).toBe(0)
    expect(out).toContain('- Scoreboard: PASS/GPU-h 0.065 | waves 3 | lines fixed per landed wave 4.67 | human interventions per wave 0.33 | rules predictive 0/8 (best I3 58% NO EVIDENCE)')
    expect(out).toContain('  perRulePrecision 0/8 predictive; best I3 58% [45,70] NO EVIDENCE')
    expect(out).toMatch(/supervisionDollarsPerWave 1431\.85 /)
    expect(out).toMatch(/^Pooled over 1 runner-driven campaign\(s\), 1 decided: PASS\/GPU-h 0\.065/m)
    expect(out).toMatch(/Excluded: c7: no waves\.jsonl \(not runner-driven\)/)
    expect(out).toMatch(/Excluded: 1 ledger mission\(s\) outside any runner-driven campaign \(hand-driven\)/)
    expect(readFileSync(join(c8, 'state.json'), 'utf8')).toBe(before)
    expect(existsSync(join(c8, 'runner.lock'))).toBe(false)
  })

  it('refuses a campaign that has no state, and creates nothing', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const { code, err } = await withHome(home, () => capture(() => main([specFile(home), '--scoreboard'], { readLedgerRows: () => [], economics: () => [], bashExe: noBash })))
    expect(code).toBe(2)
    expect(err).toMatch(/--scoreboard: no campaign state at .*state\.json/)
    expect(existsSync(join(home, 'campaigns'))).toBe(false)
  })
  it('prints the latest hindcast on the record in full — the dropped dead columns named', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.cynco')
    const c8 = join(home, 'campaigns', 'c8'); mkdirSync(c8, { recursive: true })
    copyFileSync(join(FIX, 'c8', 'state.json'), join(c8, 'state.json'))
    const hc = { version: 2, prefixTurns: 16, nHoldout: 21, baseRate: 0.5, lengthFeature: null, ladder: {}, leakCheck: null, secondary: null, droppedFeatures: ['stuckTurns.mean', 'zero.max'] }
    const ws = c8Waves(); ws[1] = { ...ws[1], hindcast: { ...hc, droppedFeatures: ['older.one'] } }; ws[2] = { ...ws[2], hindcast: hc }
    writeFileSync(join(c8, 'waves.jsonl'), ws.map(w => JSON.stringify(w)).join('\n') + '\n')
    const { code, out } = await withHome(home, () => capture(() => main([specFile(home), '--scoreboard'], { readLedgerRows: () => rows(), economics: () => ECONOMICS, bashExe: noBash })))
    expect(code).toBe(0)
    expect(out).toContain('- Outcome hindcast: v2 at K = 16 turns on 21 held-out missions (base 50%): no ladder reading; leak check not run; dropped 2 dead column(s): stuckTurns.mean, zero.max')
    expect(out).not.toContain('older.one')
  })
})

// Review I1 / M6 (F142): the economics spawn's cap is tested where the spawn
// happens — runSync's own seam, stubbed. Both readers use this function: the
// `--scoreboard` verb and every VERDICT (`defaultIo.economics`).
describe('scoreboardEconomics — the capped economics spawn', () => {
  const OUT = ['some table', 'VERDICT: frontier spent $4295.55 SUPERVISING (development $1692.01 and', 'unattributed $2.71 are excluded.'].join('\n')
  const hooks = (result, elapsedMs = 5) => {
    const seen = { calls: [] }
    let t = 0
    return {
      seen,
      spawn: (cmd, args, opts) => { seen.calls.push({ cmd, args, timeout: opts.timeout }); t += elapsedMs; return result },
      now: () => t,
    }
  }
  const quiet = async (fn) => { const e = console.error; const err = []; console.error = (...a) => { err.push(a.join(' ')) }; try { return { r: await fn(), err: err.join('\n') } } finally { console.error = e } }

  it('a clean run returns the VERDICT lines, and the spawn carried the cap', async () => {
    const h = hooks({ status: 0, stdout: OUT, stderr: '' })
    const lines = scoreboardEconomics(h)
    expect(lines).toEqual(['VERDICT: frontier spent $4295.55 SUPERVISING (development $1692.01 and', 'unattributed $2.71 are excluded.'])
    expect(parseSupervisionDollars(lines)).toBe(4295.55)
    expect(h.seen.calls).toEqual([{ cmd: 'node', args: ['scripts/supervision-economics.mjs'], timeout: ECONOMICS_TIMEOUT_MS }])
    expect(ECONOMICS_TIMEOUT_MS).toBe(120_000)
  })

  it('a timeout that spent the cap is null — "did not run", not an empty reading', async () => {
    const h = hooks({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, ECONOMICS_TIMEOUT_MS)
    const { r, err } = await quiet(() => scoreboardEconomics(h))
    expect(r).toBeNull()
    expect(err).toMatch(/timed out after 120000 ms/)
    expect(h.seen.calls[0].timeout).toBe(ECONOMICS_TIMEOUT_MS)
    // the board then names the right reason
    expect(board({ economics: r }).unmeasured).toContainEqual('supervisionDollarsPerWave: no economics line (the economics script did not run)')
  })

  it('a non-zero exit is null', async () => {
    const { r, err } = await quiet(() => scoreboardEconomics(hooks({ status: 1, stdout: OUT, stderr: 'boom' })))
    expect(r).toBeNull()
    expect(err).toMatch(/exit 1/)
  })

  it('a harness fault (spawn error, not a spent timeout) is null and named', async () => {
    const { r, err } = await quiet(() => scoreboardEconomics(hooks({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) })))
    expect(r).toBeNull()
    expect(err).toMatch(/code ENOENT/)
  })

  it('the VERDICT reader (defaultIo.economics) is the same capped spawn (review M6)', async () => {
    const h = hooks({ status: 0, stdout: OUT, stderr: '' })
    expect(defaultIo.economics(h)).toEqual(scoreboardEconomics(hooks({ status: 0, stdout: OUT, stderr: '' })))
    expect(h.seen.calls[0].timeout).toBe(ECONOMICS_TIMEOUT_MS)
    const t = hooks({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }, ECONOMICS_TIMEOUT_MS)
    const { r } = await quiet(() => defaultIo.economics(t))
    expect(r).toBeNull()
  })
})
