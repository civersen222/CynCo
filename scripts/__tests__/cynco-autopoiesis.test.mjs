import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { campaignNetwork, campaignAssessment, autopoiesisLine, campaignRows, COMPONENTS, CRITERIA } from '../cynco-autopoiesis.mjs'

// Every production the network can carry, as the facts that make each one hold.
const closedFacts = {
  gateAuthor: 'cynco', waves: 3, rows: 3, denialAnalysis: true, proposalRaised: true,
  proposalApproved: true, configurationApplied: true, seatEvidence: true, seatAuthority: 0.5,
}
// Today's shape: a human wrote the gate, nothing was ever approved.
const humanFacts = { ...closedFacts, gateAuthor: 'human' }

describe('campaignNetwork', () => {
  it('names the eight components in order', () => {
    const n = campaignNetwork(closedFacts)
    expect(n.components).toEqual(['gate', 'brief', 'wave', 'ledger', 'validation', 'proposal', 'configuration', 'seat'])
    expect(COMPONENTS).toEqual(n.components)
  })

  it('a fully self-producing fact set is organizationally closed', () => {
    const n = campaignNetwork(closedFacts)
    expect(n.network.isClosed()).toBe(true)
    expect(n.unproduced).toEqual([])
    expect(n.productions).toEqual([
      ['seat', 'gate'], ['brief', 'wave'], ['wave', 'ledger'], ['ledger', 'validation'], ['validation', 'proposal'],
      ['proposal', 'configuration'], ['configuration', 'brief'], ['ledger', 'seat'], ['configuration', 'seat'],
    ])
  })

  it('a human-written gate leaves `gate` unproduced and the network open', () => {
    const n = campaignNetwork(humanFacts)
    expect(n.network.isClosed()).toBe(false)
    expect(n.unproduced).toEqual(['gate'])
  })

  it('each production is present only when its fact holds', () => {
    const cases = [
      ['waves', 0, 'wave'], ['rows', 0, 'ledger'], ['denialAnalysis', false, 'validation'],
      ['proposalRaised', false, 'proposal'], ['proposalApproved', false, 'configuration'],
      ['configurationApplied', false, 'brief'],
    ]
    for (const [key, value, product] of cases) {
      expect(campaignNetwork({ ...closedFacts, [key]: value }).unproduced, key).toEqual([product])
    }
    // `seat` has two producers: either one keeps it produced.
    expect(campaignNetwork({ ...closedFacts, seatEvidence: false }).unproduced).toEqual([])
    expect(campaignNetwork({ ...closedFacts, seatAuthority: 0 }).unproduced).toEqual([])
    expect(campaignNetwork({ ...closedFacts, seatEvidence: false, seatAuthority: 0 }).unproduced).toEqual(['seat'])
  })

  it('no facts at all: nothing is produced', () => {
    expect(campaignNetwork({}).unproduced).toEqual(COMPONENTS)
    expect(campaignNetwork(undefined).productions).toEqual([])
  })
})

// A minimal VERDICT-time input where every criterion holds; each test below
// breaks exactly one fact and checks exactly one criterion moves.
const row = { missionId: 'c9-wave2', identityGuard: { passed: true } }
const prior = { wave: 1, missionId: 'c9-wave1', gradedAt: 't1', identity: { intact: true }, s4: { workOrder: { applied: false } } }
const current = { wave: 2, missionId: 'c9-wave2', gradedAt: 't2', s4: { ideation: { hypotheses: [] }, workOrder: { applied: true } } }
const full = () => ({
  spec: { id: 'c9', author: 'cynco' },
  state: { proposals: [{ name: 'invariants/editGapCap', status: 'approved' }], invariantOverrides: { editGapCap: 60 }, ideationAuthority: 0.5, gateAuthorAuthority: 0 },
  waves: [prior, current],
  row,
  rows: [{ missionId: 'c9-wave1', identityGuard: { passed: true } }, row],
  gateLines: { byAuthor: { cynco: { n: 9, held: 9 }, human: { n: 17, held: 17 } } },
  denialAnalysis: { invariants: [] },
  identity: { intact: true, violated: [] },
  commitsLanded: 2,
})

describe('campaignAssessment — each criterion on minimal inputs', () => {
  it('every fact holding reads autopoietic with nothing missing', () => {
    const a = campaignAssessment(full())
    expect(Object.keys(a.criteria)).toEqual(CRITERIA)
    expect(Object.values(a.criteria).every(Boolean)).toBe(true)
    expect(a.isAutopoietic).toBe(true)
    expect(a.missing).toEqual([])
    expect(a.network.unproduced).toEqual([])
  })

  it('hasBoundary follows this wave\'s identity reading (and a missing reading is not intact)', () => {
    expect(campaignAssessment({ ...full(), identity: { intact: false, violated: ['rule-11'] } }).criteria.hasBoundary).toBe(false)
    expect(campaignAssessment({ ...full(), identity: null }).criteria.hasBoundary).toBe(false)
  })

  it('boundarySelfProduced is spec.author === "cynco" (human and absent read false)', () => {
    const human = campaignAssessment({ ...full(), spec: { id: 'c9', author: 'human' } })
    expect(human.criteria.boundarySelfProduced).toBe(false)
    expect(human.missing).toEqual(['boundarySelfProduced', 'organizationallyClosed'])
    expect(human.network.unproduced).toEqual(['gate'])
    expect(campaignAssessment({ ...full(), spec: { id: 'c9' } }).criteria.boundarySelfProduced).toBe(false)
  })

  it('internalProduction needs at least one commit landed this wave', () => {
    expect(campaignAssessment({ ...full(), commitsLanded: 0 }).criteria.internalProduction).toBe(false)
    expect(campaignAssessment({ ...full(), commitsLanded: 1 }).criteria.internalProduction).toBe(true)
  })

  it('circularProduction: a denial analysis AND a proposal raised, or a PACING digest that reached a brief', () => {
    const f = full()
    const noProposal = { ...f, state: { ...f.state, proposals: [] } }
    expect(campaignAssessment(noProposal).criteria.circularProduction).toBe(false)
    expect(campaignAssessment({ ...f, denialAnalysis: null, state: { ...f.state, denialAnalysis: null } }).criteria.circularProduction).toBe(false)
    // A denial analysis that ran on an EARLIER wave still counts (state keeps it).
    expect(campaignAssessment({ ...f, denialAnalysis: null, state: { ...f.state, denialAnalysis: { invariants: [] } } }).criteria.circularProduction).toBe(true)
    // The digest this wave's brief carried closes the loop on its own.
    expect(campaignAssessment({ ...noProposal, pacingDigest: true }).criteria.circularProduction).toBe(true)
    // ...and so does one an earlier wave's brief carried.
    const priorDigest = { ...prior, autopoiesis: { facts: { pacingDigest: true } } }
    expect(campaignAssessment({ ...noProposal, waves: [priorDigest, current] }).criteria.circularProduction).toBe(true)
  })

  it('organizationallyClosed is the network\'s closure over the facts that occurred', () => {
    const f = full()
    const a = campaignAssessment({ ...f, state: { ...f.state, proposals: [{ name: 'ideation/brief', status: 'pending' }] } })
    // Raised but never approved: nothing produces configuration.
    expect(a.network.unproduced).toEqual(['configuration'])
    expect(a.criteria.organizationallyClosed).toBe(false)
    expect(a.criteria.circularProduction).toBe(true)
  })

  it('organizationMaintained: identity intact on every graded wave so far and the guard passed on every row', () => {
    const f = full()
    expect(campaignAssessment({ ...f, waves: [{ ...prior, identity: { intact: false } }, current] }).criteria.organizationMaintained).toBe(false)
    // A graded wave with no identity reading is not evidence of maintenance.
    expect(campaignAssessment({ ...f, waves: [{ ...prior, identity: undefined }, current] }).criteria.organizationMaintained).toBe(false)
    // A stop/fault record (never graded) is not a reading and does not count.
    expect(campaignAssessment({ ...f, waves: [{ wave: 1, missionId: null, decision: { kind: 'stop' } }, prior, current] }).criteria.organizationMaintained).toBe(true)
    expect(campaignAssessment({ ...f, rows: [{ missionId: 'c9-wave1', identityGuard: { passed: false } }, row] }).criteria.organizationMaintained).toBe(false)
    expect(campaignAssessment({ ...f, rows: [{ missionId: 'c9-wave1', identityGuard: null }, row] }).criteria.organizationMaintained).toBe(false)
    expect(campaignAssessment({ ...f, identity: { intact: false, violated: ['gate-sealed'] } }).criteria.organizationMaintained).toBe(false)
  })

  it('an explicit identityHistory is used as given', () => {
    const f = full()
    expect(campaignAssessment({ ...f, identityHistory: { waves: [true], rows: [true, false] } }).criteria.organizationMaintained).toBe(false)
    expect(campaignAssessment({ ...f, identityHistory: { waves: [], rows: [] } }).criteria.organizationMaintained).toBe(true)
  })

  it('records the facts it read, so a reading can be re-run', () => {
    const a = campaignAssessment({ ...full(), spec: { id: 'c9', author: 'human' } })
    expect(a.facts).toMatchObject({ gateAuthor: 'human', waves: 2, rows: 2, denialAnalysis: true, proposalRaised: true, proposalApproved: true,
      configurationApplied: true, seatEvidence: true, seatAuthority: 0.5, commitsLanded: 2, pacingDigest: false,
      identityHistory: { waves: 1, intact: 1, rows: 2, passed: 2 } })
  })

  it('seatAuthority given explicitly (the retained store) outranks the state values', () => {
    const f = full()
    const noSeat = { ...f, state: { ...f.state, ideationAuthority: 0, gateAuthorAuthority: 0 }, gateLines: null, waves: [prior, { ...current, s4: { workOrder: { applied: true } } }] }
    expect(campaignAssessment(noSeat).network.unproduced).toEqual(['seat'])
    expect(campaignAssessment({ ...noSeat, seatAuthority: 0.5 }).network.unproduced).toEqual([])
  })
})

describe('campaignRows', () => {
  it('keeps this campaign\'s rows by missionId, the current row once, the current object winning', () => {
    const waves = [{ missionId: 'a' }, { missionId: null }, { missionId: 'b' }]
    const ledger = [{ missionId: 'a', n: 1 }, { missionId: 'z' }, { missionId: 'b', n: 1 }]
    const cur = { missionId: 'b', n: 2 }
    expect(campaignRows({ waves, ledgerRows: ledger, row: cur })).toEqual([{ missionId: 'a', n: 1 }, { missionId: 'b', n: 2 }])
    expect(campaignRows({ waves, ledgerRows: null, row: cur })).toEqual([cur])
  })
})

describe('autopoiesisLine', () => {
  it('prints met/6 and the missing criteria by name', () => {
    const a = campaignAssessment({ ...full(), spec: { id: 'c9', author: 'human' } })
    expect(autopoiesisLine(a)).toBe('- Autopoiesis: 4/6 — missing boundarySelfProduced, organizationallyClosed')
  })
  it('prints 6/6 with nothing missing', () => {
    expect(autopoiesisLine(campaignAssessment(full()))).toBe('- Autopoiesis: 6/6')
  })
  it('names an assessment that threw, and prints nothing for no reading', () => {
    expect(autopoiesisLine({ assessError: 'boom' })).toBe('- Autopoiesis: UNASSESSED — boom')
    expect(autopoiesisLine(null)).toBeNull()
    expect(autopoiesisLine(undefined)).toBeNull()
  })
})

// F149: the README's example block must be a reading the module can produce.
describe('ledger README: the wave record\'s autopoiesis block is a real reading', () => {
  const text = readFileSync(join(process.cwd(), 'benchmark', 'cynco-ledger', 'README.md'), 'utf8')
  const start = text.indexOf('"autopoiesis": {')
  it('exists', () => { expect(start).toBeGreaterThan(-1) })
  it('re-running the network on its facts gives its unproduced, and its criteria give its missing', () => {
    let depth = 0, end = -1
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    const block = JSON.parse(text.slice(text.indexOf('{', start), end).replace(/\/\/.*$/gm, ''))
    expect(campaignNetwork(block.facts).unproduced).toEqual(block.network.unproduced)
    expect(CRITERIA.filter(k => !block.criteria[k])).toEqual(block.missing)
    expect(block.isAutopoietic).toBe(block.missing.length === 0)
    expect(block.criteria.organizationallyClosed).toBe(block.network.unproduced.length === 0)
    expect(block.criteria.boundarySelfProduced).toBe(block.facts.gateAuthor === 'cynco')
    expect(block.criteria.internalProduction).toBe(block.facts.commitsLanded >= 1)
  })
})
