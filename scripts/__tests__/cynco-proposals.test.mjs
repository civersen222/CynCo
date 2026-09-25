import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROPOSAL_FAMILIES, SEATS_PATH, readSeats, writeSeats, applyProposalDecision, seatAuthority } from '../cynco-proposals.mjs'
import { applyProposalDecision as fromRunner } from '../cynco-campaign.mjs'

const home = () => mkdtempSync(join(tmpdir(), 'seats-'))
const intact = { intact: true, violated: [], evidence: {} }
const violated = { intact: false, violated: ['rule-11', 'marker-recorded'], evidence: {} }
const pending = (over = {}) => ({ type: 'Parameter', name: 'ideation/brief', proposedAt: 't1', status: 'pending', newValue: 0.5, bounds: { min: 0, max: 0.5 }, ...over })

afterEach(() => { vi.restoreAllMocks() })

describe('the registry surface', () => {
  it('names the proposal families and where the seats live', () => {
    expect(PROPOSAL_FAMILIES).toEqual(['ideation/brief', 'gate-author/gate', 'invariants/', 'gate/'])
    expect(SEATS_PATH('H').replace(/\\/g, '/')).toBe('H/retained/seats.json')
  })
  it('the runner re-exports the one applyProposalDecision', () => {
    expect(fromRunner).toBe(applyProposalDecision)
  })
})

describe('applyProposalDecision refuses identity', () => {
  it.each(['invariants/revertBan', 'invariants/codeIndexFirst', 'identity/gate-sealed', 'spec/marker', 'calibration/gateSha256'])('%s is refused and state is untouched', (name) => {
    const s = { proposals: [pending({ name })], invariantOverrides: {} }
    expect(applyProposalDecision(s, name, true)).toEqual({ ok: false, why: `proposal ${name} targets an identity invariant` })
    expect(s.proposals[0].status).toBe('pending')
    expect(s.invariantOverrides).toEqual({})
  })

  // A rejection changes nothing, and a proposal left pending blocks every later
  // one under §E — so an identity-named proposal can always be said no to.
  it.each(['invariants/revertBan', 'invariants/codeIndexFirst', 'identity/gate-sealed', 'spec/marker'])('%s may be rejected, which clears it and changes nothing else', (name) => {
    const s = { proposals: [pending({ name })], invariantOverrides: {}, ideationAuthority: 0 }
    expect(applyProposalDecision(s, name, false)).toEqual({ ok: true, status: 'rejected' })
    expect(s.proposals[0].status).toBe('rejected')
    expect(s.invariantOverrides).toEqual({})
    expect(s.ideationAuthority).toBe(0)
  })

  it('refuses an approval while identity is violated, naming what broke', () => {
    const h = home()
    const s = { id: 'c8', proposals: [pending()], ideationAuthority: 0 }
    expect(applyProposalDecision(s, 'ideation/brief', true, { identity: violated, seatsHome: h })).toEqual({ ok: false, why: 'identity violated: rule-11 marker-recorded' })
    expect(s.proposals[0].status).toBe('pending')
    expect(s.ideationAuthority).toBe(0)
    expect(existsSync(SEATS_PATH(h))).toBe(false)
  })

  it('a non-tunable cap cannot be approved but can be rejected', () => {
    const s = { proposals: [pending({ name: 'invariants/somethingElse' })], invariantOverrides: {} }
    expect(applyProposalDecision(s, 'invariants/somethingElse', true)).toEqual({ ok: false, why: 'proposal invariants/somethingElse names a cap that is not tunable' })
    expect(applyProposalDecision(s, 'invariants/somethingElse', false)).toEqual({ ok: true, status: 'rejected' })
    expect(s.invariantOverrides).toEqual({})
  })

  it('a rejection still goes through while identity is violated — saying no never changes identity', () => {
    const s = { proposals: [pending()], ideationAuthority: 0 }
    expect(applyProposalDecision(s, 'ideation/brief', false, { identity: violated })).toEqual({ ok: true, status: 'rejected' })
  })
})

describe('applyProposalDecision writes the seats store', () => {
  it('an approved ideation/brief writes seats.json at version 1, and the same authority again leaves it at 1', () => {
    const h = home()
    const s = { id: 'c8', proposals: [pending()], ideationAuthority: 0 }
    expect(applyProposalDecision(s, 'ideation/brief', true, { identity: intact, seatsHome: h })).toEqual({ ok: true, status: 'approved' })
    expect(s.ideationAuthority).toBe(0.5)
    const first = JSON.parse(readFileSync(SEATS_PATH(h), 'utf8'))
    expect(first).toMatchObject({ schema: 1, version: 1, seats: { ideation: { authority: 0.5, campaign: 'c8' } } })
    expect(first.history).toHaveLength(1)

    const again = { id: 'c9', proposals: [pending({ proposedAt: 't2' })], ideationAuthority: 0 }
    expect(applyProposalDecision(again, 'ideation/brief', true, { identity: intact, seatsHome: h }).ok).toBe(true)
    const second = JSON.parse(readFileSync(SEATS_PATH(h), 'utf8'))
    expect(second.version).toBe(1)
    expect(second.history).toHaveLength(1)
    expect(seatAuthority(h, 'ideation')).toBe(0.5)
  })

  it('the store only rises: approving 0.3 after a stored 0.5 leaves 0.5 at the same version', () => {
    const h = home()
    writeSeats(h, readSeats(h), { seat: 'ideation', authority: 0.5, decidedAt: 't0', campaign: 'c7' })
    const s = { id: 'c8', proposals: [pending({ newValue: 0.3 })], ideationAuthority: 0 }
    expect(applyProposalDecision(s, 'ideation/brief', true, { identity: intact, seatsHome: h }).ok).toBe(true)
    expect(s.ideationAuthority).toBe(0.3)
    const disk = JSON.parse(readFileSync(SEATS_PATH(h), 'utf8'))
    expect(disk.seats.ideation).toMatchObject({ authority: 0.5, campaign: 'c7' })
    expect(disk.version).toBe(1)
  })

  it('an approved gate-author/gate writes the gate-author seat', () => {
    const h = home()
    const s = { id: 'c8', proposals: [pending({ name: 'gate-author/gate' })], gateAuthorAuthority: 0 }
    applyProposalDecision(s, 'gate-author/gate', true, { seatsHome: h })
    expect(seatAuthority(h, 'gate-author')).toBe(0.5)
    expect(seatAuthority(h, 'ideation')).toBe(0)
  })

  it('writes nothing without a seatsHome, on a rejection, or for a cap or a gate', () => {
    const h = home()
    applyProposalDecision({ proposals: [pending()] }, 'ideation/brief', true)
    applyProposalDecision({ proposals: [pending()] }, 'ideation/brief', false, { seatsHome: h })
    applyProposalDecision({ proposals: [pending({ name: 'invariants/editGapCap', newValue: 60, bounds: { min: 40, max: 80 } })] }, 'invariants/editGapCap', true, { seatsHome: h })
    applyProposalDecision({ proposals: [{ type: 'Code', name: 'gate/c9', proposedAt: 't', status: 'pending' }] }, 'gate/c9', true, { seatsHome: h })
    expect(existsSync(SEATS_PATH(h))).toBe(false)
  })

  it('keeps the old contract: caps clamp, unknown names refuse, gate/<id> records who decided', () => {
    const s = { proposals: [pending({ name: 'invariants/editGapCap', newValue: 999, bounds: { min: 40, max: 80 } }), { type: 'Code', name: 'gate/c9', proposedAt: 't', status: 'pending' }] }
    expect(applyProposalDecision(s, 'invariants/editGapCap', true)).toEqual({ ok: true, status: 'approved' })
    expect(s.invariantOverrides).toEqual({ editGapCap: 80 })
    expect(applyProposalDecision(s, 'nope', true)).toEqual({ ok: false, why: 'no pending proposal nope' })
    expect(applyProposalDecision(s, 'gate/c9', true, { decidedBy: 'auto' })).toEqual({ ok: true, status: 'approved' })
    expect(s.proposals[1].decidedBy).toBe('auto')
  })
})

describe('readSeats / writeSeats / seatAuthority', () => {
  it('a missing store reads fresh and seatAuthority is 0', () => {
    const h = home()
    expect(readSeats(h)).toEqual({ schema: 1, version: 0, seats: {}, history: [] })
    expect(seatAuthority(h, 'ideation')).toBe(0)
  })

  it('a corrupt store reads fresh, with a warning', () => {
    const h = home()
    mkdirSync(join(h, 'retained'), { recursive: true })
    writeFileSync(SEATS_PATH(h), '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readSeats(h)).toEqual({ schema: 1, version: 0, seats: {}, history: [] })
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toMatch(/seats\.json/)
  })

  it('a store of the wrong shape reads fresh, with a warning', () => {
    const h = home()
    mkdirSync(join(h, 'retained'), { recursive: true })
    writeFileSync(SEATS_PATH(h), JSON.stringify({ schema: 7, seats: [] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readSeats(h).version).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it('version rises only when a seat\'s authority changes; history is capped at 20', () => {
    const h = home()
    let seats = readSeats(h)
    for (let i = 1; i <= 25; i++) seats = writeSeats(h, seats, { seat: 'ideation', authority: i / 100, decidedAt: `t${i}`, campaign: 'c8' })
    const disk = JSON.parse(readFileSync(SEATS_PATH(h), 'utf8'))
    expect(disk.version).toBe(25)
    expect(disk.history).toHaveLength(20)
    expect(disk.history.at(-1)).toMatchObject({ seat: 'ideation', to: 0.25, decidedAt: 't25', campaign: 'c8', version: 25 })
    const same = writeSeats(h, disk, { seat: 'ideation', authority: 0.25, decidedAt: 't26', campaign: 'c9' })
    expect(same.version).toBe(25)
    expect(JSON.parse(readFileSync(SEATS_PATH(h), 'utf8')).version).toBe(25)
    expect(existsSync(SEATS_PATH(h) + '.tmp')).toBe(false)
  })

  it('seatAuthority ignores a seat whose authority is not a finite number', () => {
    const h = home()
    mkdirSync(join(h, 'retained'), { recursive: true })
    writeFileSync(SEATS_PATH(h), JSON.stringify({ schema: 1, version: 1, seats: { ideation: { authority: 'lots' } }, history: [] }))
    expect(seatAuthority(h, 'ideation')).toBe(0)
  })
})
