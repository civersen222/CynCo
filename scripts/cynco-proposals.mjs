// scripts/cynco-proposals.mjs — the one proposal registry, and the per-seat
// retained-configuration store.
//
// Phase 4 ("autopoiesis for real"). The campaign may change exactly two kinds
// of thing about itself: a seat's earned authority (`ideation/brief`,
// `gate-author/gate`) and a campaign's tunable caps (`invariants/<cap>`).
// `gate/<id>` is a decision about code and changes only who decided. Every
// one of those changes goes through `applyProposalDecision` below, which is
// the only place that
//   - refuses a proposal whose name targets identity (`refusesIdentity`), and
//   - refuses an APPROVAL while the campaign's identity is violated.
// engine/__tests__/guards/proposalWriters.test.ts fails when any other script
// assigns `.ideationAuthority`, `.gateAuthorAuthority` or `.invariantOverrides`
// or writes the seats store (the one exception is CampaignState's merge of a
// decision this registry already made, in another process).
//
// The seats store (`~/.cynco/retained/seats.json`) is where a seat's authority
// lives independently of the campaign that earned it. Before Phase 4 a seat
// approved on c8 had to be read back by scanning every campaign's state.json
// (`gateAuthorAuthorityAcrossCampaigns`); the store is the seat's own home.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { refusesIdentity } from './cynco-identity.mjs'

export const PROPOSAL_FAMILIES = ['ideation/brief', 'gate-author/gate', 'invariants/', 'gate/']

// The only code allowed to assign a seat's authority or a cap override, or to
// write the seats store — file → the method it is confined to (null: the whole
// file). CampaignState's merge adopts a decision this registry already made in
// another process, and nothing else in that file may. Read by
// engine/__tests__/guards/proposalWriters.test.ts.
export const PROPOSAL_WRITERS = { 'cynco-proposals.mjs': null, 'cynco-campaign-state.mjs': 'adoptExternalDecisions' }

export const SEATS_PATH = (home) => join(home, 'retained', 'seats.json')

const SEATS_SCHEMA = 1
const SEATS_HISTORY_CAP = 20
const freshSeats = () => ({ schema: SEATS_SCHEMA, version: 0, seats: {}, history: [] })

// Which seat a promotion proposal raises. Caps and gates are not seats.
const SEAT_OF = { 'ideation/brief': 'ideation', 'gate-author/gate': 'gate-author' }

/**
 * The retained store, or a fresh one. A missing file is the normal state until
 * the first promotion is approved, so it is read as fresh without a word; a
 * file that exists but will not parse (or is not the store's shape) is read as
 * fresh WITH a warning, because every authority it held is being ignored.
 */
export function readSeats(home) {
  const path = SEATS_PATH(home)
  if (!existsSync(path)) return freshSeats()
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) }
  catch (e) { console.warn(`[proposals] ${path} is not readable JSON — reading the seats store as fresh (every retained authority is ignored until it is fixed): ${e?.message ?? e}`); return freshSeats() }
  const ok = raw && raw.schema === SEATS_SCHEMA && raw.seats && typeof raw.seats === 'object' && !Array.isArray(raw.seats)
  if (!ok) { console.warn(`[proposals] ${path} is not a schema-${SEATS_SCHEMA} seats store — reading it as fresh`); return freshSeats() }
  return { schema: SEATS_SCHEMA, version: Number.isInteger(raw.version) ? raw.version : 0, seats: { ...raw.seats }, history: Array.isArray(raw.history) ? raw.history : [] }
}

/**
 * Record `seat`'s authority. The version rises only when that seat's authority
 * CHANGED — an approval of the value the seat already holds is not a new
 * configuration, and writing nothing keeps the version a count of real
 * changes. History keeps the last 20. Written tmp + rename, like state.json.
 */
export function writeSeats(home, seats, { seat, authority, decidedAt, campaign }) {
  const next = { schema: SEATS_SCHEMA, version: seats?.version ?? 0, seats: { ...(seats?.seats ?? {}) }, history: [...(seats?.history ?? [])] }
  const prev = next.seats[seat]?.authority
  if (prev === authority) return next
  next.version += 1
  next.seats[seat] = { authority, decidedAt: decidedAt ?? null, campaign: campaign ?? null, version: next.version }
  next.history.push({ seat, from: prev ?? 0, to: authority, decidedAt: decidedAt ?? null, campaign: campaign ?? null, version: next.version })
  next.history = next.history.slice(-SEATS_HISTORY_CAP)
  const path = SEATS_PATH(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
  return next
}

/** A seat's retained authority; 0 when the store has none (or not a number). */
export function seatAuthority(home, seat) {
  const v = readSeats(home).seats?.[seat]?.authority
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * The operator's decision on a pending proposal, applied to state. Pure over
 * the state object except for one thing: an approved SEAT promotion is also
 * written to the retained store when `seatsHome` is given (the CLI passes
 * cyncoHome(); tests pass a temp dir; the merge-on-save path passes nothing).
 *
 * Refusals, in order, and none of them touches state. Every one of them
 * refuses an APPROVAL only: a rejection changes nothing about the campaign,
 * and refusing it would leave the proposal pending forever — which, under §E,
 * blocks every later proposal behind it.
 *   1. the name targets identity — no evidence buys that;
 *   2. no pending proposal of that name (this one refuses a rejection too:
 *      there is nothing to reject);
 *   3. an `invariants/<cap>` that is not one of the two tunable caps;
 *   4. `identity` says the campaign is not intact.
 */
export function applyProposalDecision(s, name, approve, { decidedBy = 'supervisor', identity = null, seatsHome = null } = {}) {
  if (approve && refusesIdentity(name)) return { ok: false, why: `proposal ${name} targets an identity invariant` }
  const p = (s.proposals ?? []).find(x => x.name === name && x.status === 'pending')
  if (!p) return { ok: false, why: `no pending proposal ${name}` }
  // Only editGapCap and commitGapCap are tunable (revertBan/codeIndexFirst are
  // identity invariants and refused above — capProposal never proposes them,
  // but a hand-edited or otherwise malformed proposal must be refused here
  // too, before any state is touched).
  if (approve && p.name.startsWith('invariants/')) {
    const cap = p.name.slice('invariants/'.length)
    if (cap !== 'editGapCap' && cap !== 'commitGapCap') return { ok: false, why: `proposal ${name} names a cap that is not tunable` }
  }
  if (approve && identity?.intact === false) return { ok: false, why: `identity violated: ${identity.violated.join(' ')}` }
  p.status = approve ? 'approved' : 'rejected'; p.decidedAt = new Date().toISOString()
  // A `gate/<id>` decision is a decision about CODE, not a parameter: the only
  // thing it changes in state is who said so. The seal itself — the copy into
  // the sealed tree, the campaign json, the identity check, the campaign-log
  // entry — is done by the CLI afterwards.
  // `decidedBy` is 'supervisor' for every operator verb and 'auto' only when
  // the gate-author seat sealed at earned authority (spec ruling 2). It is the
  // one field that says whether a human ever looked at this seal.
  if (p.name.startsWith('gate/')) { p.decidedBy = decidedBy; return { ok: true, status: p.status } }
  if (approve && p.name === 'ideation/brief') s.ideationAuthority = Math.min(p.newValue, p.bounds.max)
  if (approve && p.name === 'gate-author/gate') s.gateAuthorAuthority = Math.min(p.newValue, p.bounds.max)
  if (approve && p.name.startsWith('invariants/')) {
    const cap = p.name.slice('invariants/'.length)
    s.invariantOverrides = { ...(s.invariantOverrides ?? {}), [cap]: Math.min(p.newValue, p.bounds.max) }
  }
  const seat = SEAT_OF[p.name]
  if (approve && seat && seatsHome) {
    // The store only ever rises: a seat's authority is what it has earned
    // ANYWHERE, so an approval on one campaign of less than the seat already
    // holds is not a demotion (and, being no change, bumps no version).
    const approved = seat === 'ideation' ? s.ideationAuthority : s.gateAuthorAuthority
    const authority = Math.max(seatAuthority(seatsHome, seat), approved)
    writeSeats(seatsHome, readSeats(seatsHome), { seat, authority, decidedAt: p.decidedAt, campaign: s.id ?? null })
  }
  return { ok: true, status: p.status }
}
