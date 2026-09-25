import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { campaignNetwork, campaignAssessment, autopoiesisLine, campaignRows, criteriaFromFacts, effectiveSeatAuthority, storedAssessment, COMPONENTS, CRITERIA } from '../cynco-autopoiesis.mjs'

// Every production the network can carry, as the facts that make each one hold.
const closedFacts = {
  gateAuthor: 'cynco', waves: 3, rows: 3, denialAnalysis: true, proposalRaised: true, proposalFromDenials: true,
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
      ['proposalFromDenials', false, 'proposal'], ['proposalApproved', false, 'configuration'],
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

  it('circularProduction: a denial analysis AND a cap proposal raised from it, or a PACING digest that reached a brief', () => {
    const f = full()
    const noProposal = { ...f, state: { ...f.state, proposals: [] } }
    expect(campaignAssessment(noProposal).criteria.circularProduction).toBe(false)
    expect(campaignAssessment({ ...f, denialAnalysis: null, state: { ...f.state, denialAnalysis: null } }).criteria.circularProduction).toBe(false)
    // A denial analysis that ran on an EARLIER wave still counts (state keeps it).
    expect(campaignAssessment({ ...f, denialAnalysis: null, state: { ...f.state, denialAnalysis: { invariants: [] } } }).criteria.circularProduction).toBe(true)
    // A promotion proposal is not raised from the denial analysis: it does not close the loop.
    const ideationOnly = campaignAssessment({ ...f, state: { ...f.state, proposals: [{ name: 'ideation/brief', status: 'pending' }] } })
    expect(ideationOnly.facts).toMatchObject({ proposalRaised: true, proposalFromDenials: false })
    expect(ideationOnly.criteria.circularProduction).toBe(false)
    // The cap proposal is, even while pending.
    const cap = campaignAssessment({ ...f, state: { ...f.state, proposals: [{ name: 'invariants/editGapCap', status: 'pending' }] } })
    expect(cap.facts.proposalFromDenials).toBe(true)
    expect(cap.criteria.circularProduction).toBe(true)
    // A brief that carried the digest (the runner's s4.pacingFromDenials) closes the loop on its own —
    // this wave's or an earlier one's.
    expect(campaignAssessment({ ...noProposal, waves: [prior, { ...current, s4: { ...current.s4, pacingFromDenials: true } }] }).criteria.circularProduction).toBe(true)
    expect(campaignAssessment({ ...noProposal, waves: [{ ...prior, s4: { pacingFromDenials: true } }, current] }).criteria.circularProduction).toBe(true)
    // Never read off anything but the flag.
    expect(campaignAssessment({ ...noProposal, waves: [{ ...prior, autopoiesis: { facts: { pacingDigest: true } } }, current] }).criteria.circularProduction).toBe(false)
  })

  it('organizationallyClosed is the network\'s closure over the facts that occurred', () => {
    const f = full()
    // A promotion proposal raised and pending: nothing produces proposal (validation's product
    // is the cap proposal) nor configuration.
    const a = campaignAssessment({ ...f, state: { ...f.state, proposals: [{ name: 'ideation/brief', status: 'pending' }] } })
    expect(a.network.unproduced).toEqual(['proposal', 'configuration'])
    expect(a.criteria.organizationallyClosed).toBe(false)
    // A cap proposal raised but never approved: only configuration is unproduced.
    const b = campaignAssessment({ ...f, state: { ...f.state, proposals: [{ name: 'invariants/editGapCap', status: 'pending' }] } })
    expect(b.network.unproduced).toEqual(['configuration'])
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
    expect(a.facts).toMatchObject({ gateAuthor: 'human', waves: 2, rows: 2, denialAnalysis: true, proposalRaised: true, proposalFromDenials: true, proposalApproved: true,
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

describe('criteriaFromFacts — re-running a stored reading', () => {
  it('re-deriving from a stored record\'s facts and identity reproduces its criteria', () => {
    const variants = [
      full(),
      { ...full(), spec: { id: 'c9', author: 'human' } },
      { ...full(), commitsLanded: 0, identity: { intact: false, violated: ['rule-11'] } },
      { ...full(), state: { ...full().state, proposals: [{ name: 'ideation/brief', status: 'pending' }] } },
      { ...full(), rows: [{ missionId: 'c9-wave1', identityGuard: null }, row] },
    ]
    for (const input of variants) {
      // Stored = what the wave record holds after a JSON round trip.
      const stored = JSON.parse(JSON.stringify({ ...campaignAssessment(input), identity: input.identity }))
      expect(criteriaFromFacts(stored.facts, stored.identity)).toEqual(stored.criteria)
    }
  })
  it('a re-run with a CURRENT identity moves only the identity-bound criteria', () => {
    const stored = JSON.parse(JSON.stringify(campaignAssessment(full())))
    expect(criteriaFromFacts(stored.facts, { intact: false })).toEqual({ ...stored.criteria, hasBoundary: false, organizationMaintained: false })
  })
})

describe('effectiveSeatAuthority / storedAssessment', () => {
  it('reads the state values and, given a home, the retained seats store', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { readSeats, writeSeats } = await import('../cynco-proposals.mjs')
    const home = mkdtempSync(join(tmpdir(), 'seats-'))
    expect(effectiveSeatAuthority({ ideationAuthority: 0.2 }, null)).toBe(0.2)
    expect(effectiveSeatAuthority({ ideationAuthority: 0.2 }, home)).toBe(0.2)
    writeSeats(home, readSeats(home), { seat: 'gate-author', authority: 0.5, decidedAt: 't', campaign: 'c7' })
    expect(effectiveSeatAuthority({ ideationAuthority: 0.2 }, home)).toBe(0.5)
  })
  it('storedAssessment passes the seat authority it is given through to the network', () => {
    const f = full()
    const state = { ...f.state, ideationAuthority: 0, gateAuthorAuthority: 0 }
    const waves = [prior, { ...current, s4: { workOrder: { applied: true } }, identity: { intact: true } }]
    const bare = storedAssessment({ spec: f.spec, state, waves, ledgerRows: f.rows, gateLines: null })
    expect(bare.network.productions).not.toContainEqual(['configuration', 'seat'])
    const seated = storedAssessment({ spec: f.spec, state, waves, ledgerRows: f.rows, gateLines: null, seatAuthority: 0.5 })
    expect(seated.network.productions).toContainEqual(['configuration', 'seat'])
    expect(seated.facts.seatAuthority).toBe(0.5)
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
    expect(campaignNetwork(block.facts).productions).toEqual(block.network.productions)
    // The whole criteria block re-derives from its facts (hasBoundary is the wave's identity reading).
    expect(criteriaFromFacts(block.facts, { intact: block.criteria.hasBoundary })).toEqual(block.criteria)
  })
})
