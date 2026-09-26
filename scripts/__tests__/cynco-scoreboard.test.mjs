import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  campaignScoreboard, pooledScoreboard, scoreboardLines, campaignDecision, gpuHours,
  passRatePerGpuHour, wavesPerCampaign, gateLinesFixedPerLandedWave, humanInterventionsPerWave,
  perRulePrecision, supervisionDollarsPerWave, parseSupervisionDollars,
} from '../cynco-scoreboard.mjs'
import { main } from '../cynco-campaign.mjs'

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
    expect(r.reason).toMatch(/no wave landed a commit/)
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
  it('a delivered note with no `source` is unknown, not counted, and named in unmeasured', () => {
    const rs = rows(); rs[2].operatorNotes = [{ text: 'x', source: null, deliveredAtIteration: 3, dropped: null }]
    const b = board({ rows: rs })
    expect(b.humanInterventionsPerWave.notes).toBe(1)
    expect(b.unmeasured).toContainEqual(expect.stringMatching(/^humanInterventionsPerWave: 1 delivered note\(s\) carry no source/))
  })
})

describe('perRulePrecision — predictive ÷ total, and the best rule', () => {
  it('0 of 8 predictive; the best is the most precise rule with enough evidence (a TOO FEW rule never wins)', () => {
    expect(perRulePrecision(ruleVerdicts)).toEqual({ predictive: 0, total: 8, best: { id: 'I3', precision: 0.58, ci: [0.45, 0.70], verdict: 'NO EVIDENCE' } })
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
})

describe('scoreboardLines', () => {
  it('the verdict entry\'s one line', () => {
    expect(scoreboardLines(board({ ruleVerdicts, economics: ECONOMICS }))).toEqual([
      '- Scoreboard: PASS/GPU-h 0.065 | waves 3 | lines fixed per landed wave 4.67 | human interventions per wave 0.33 | rules predictive 0/8 (best I3 58% [45,70] NO EVIDENCE)',
    ])
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
    expect(out).toContain('- Scoreboard: PASS/GPU-h 0.065 | waves 3 | lines fixed per landed wave 4.67 | human interventions per wave 0.33 | rules predictive 0/8 (best I3 58% [45,70] NO EVIDENCE)')
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
})
