// scripts/cynco-autopoiesis.mjs — Phase 4 ruling 4: the campaign checklist.
//
// Maturana/Varela's six criteria, each mapped to a fact the campaign runner
// already measures at VERDICT — never to a claim. The vendored core supplies
// the criteria, the closure test and the verdict (engine/cybernetics-core
// autopoiesis: ProductionNetwork, isAutopoietic, missingCriteria); this module
// only decides which productions actually occurred in THIS campaign.
//
// The reading is stored on every wave record as `autopoiesis` together with the
// facts it was computed from, so a wrong mapping can be re-run over the stored
// facts rather than re-measured. It is expected to be non-empty-missing for a
// long time: a human-written gate alone leaves `gate` unproduced.
import { autopoiesis } from '../engine/cybernetics-core/src/index.js'
import { seatAuthority as storedSeatAuthority } from './cynco-proposals.mjs'

/** The campaign's components, in the order the network adds them. */
export const COMPONENTS = ['gate', 'brief', 'wave', 'ledger', 'validation', 'proposal', 'configuration', 'seat']

/** The six criteria, by the core's AutopoiesisAssessment field names. */
export const CRITERIA = ['hasBoundary', 'boundarySelfProduced', 'internalProduction', 'circularProduction', 'organizationallyClosed', 'organizationMaintained']

// The core's missingCriteria speaks prose; the wave record speaks field names.
// This table is the one translation, and campaignAssessment asserts it still
// covers everything the core reports — a renamed criterion upstream fails loud.
const CORE_NAME = {
  hasBoundary: 'distinguishable boundary',
  boundarySelfProduced: 'self-produced boundary',
  internalProduction: 'internal component production',
  circularProduction: 'circular production',
  organizationallyClosed: 'organizational closure',
  organizationMaintained: 'organization maintenance',
}

/**
 * [producer, product, holds(facts)] — a production is in the network only when
 * its fact holds. The facts are what campaignAssessment derives below.
 */
const PRODUCTIONS = [
  ['seat', 'gate', f => f.gateAuthor === 'cynco'],
  ['brief', 'wave', f => (f.waves ?? 0) >= 1],
  ['wave', 'ledger', f => (f.rows ?? 0) >= 1],
  ['ledger', 'validation', f => f.denialAnalysis === true],
  // The validation's own product is the cap proposal (`invariants/<cap>`,
  // capProposal over the denial analysis). A promotion proposal is raised from
  // other evidence (followed × landed, gate lines), so it does not close this edge.
  ['validation', 'proposal', f => f.proposalFromDenials === true],
  ['proposal', 'configuration', f => f.proposalApproved === true],
  ['configuration', 'brief', f => f.configurationApplied === true],
  ['ledger', 'seat', f => f.seatEvidence === true],
  ['configuration', 'seat', f => (f.seatAuthority ?? 0) > 0],
]

/** The campaign's production network given which productions occurred. */
export function campaignNetwork(facts) {
  const f = facts ?? {}
  const network = new autopoiesis.ProductionNetwork()
  const idx = Object.fromEntries(COMPONENTS.map(c => [c, network.addComponent(c)]))
  const productions = []
  for (const [producer, product, holds] of PRODUCTIONS) {
    if (!holds(f)) continue
    network.addProduction(idx[producer], idx[product])
    productions.push([producer, product])
  }
  return { network, components: [...COMPONENTS], productions, unproduced: network.unproducedComponents() }
}

/**
 * This campaign's ledger rows: the rows whose missionId a wave record names,
 * plus the current row (the object handed in wins over the ledger's copy of it).
 */
export function campaignRows({ waves, ledgerRows, row }) {
  const ids = new Set((waves ?? []).map(w => w?.missionId).filter(Boolean))
  if (row?.missionId) ids.add(row.missionId)
  const byId = new Map()
  for (const r of ledgerRows ?? []) if (r?.missionId && ids.has(r.missionId) && !byId.has(r.missionId)) byId.set(r.missionId, r)
  if (row?.missionId) byId.set(row.missionId, row)
  return [...byId.values()]
}

/**
 * The identity history the maintenance criterion reads: every PRIOR graded
 * wave's `identity.intact` and every campaign row's `identityGuard.passed`.
 * A stop or fault record was never graded, so it is not a reading. A graded
 * wave that predates the identity assertion, or a row whose engine never
 * emitted the guard, is carried as `undefined` — unread, and unread is not
 * evidence of maintenance.
 */
function identityHistoryOf({ waves, rows, row }) {
  const graded = (waves ?? []).filter(w => w?.gradedAt && w.missionId !== row?.missionId)
  return { waves: graded.map(w => w.identity?.intact), rows: (rows ?? []).map(r => r?.identityGuard?.passed) }
}

/**
 * The six criteria over measurable facts (spec ruling 4).
 *
 * `state` is the campaign state object (not the CampaignState wrapper); `waves`
 * is every wave record so far, the current one included; `rows` this campaign's
 * ledger rows (campaignRows). `commitsLanded` is this wave's commit count and
 * `seatAuthority` the effective seat authority (effectiveSeatAuthority: the
 * retained store included) when the caller has it — otherwise the state's own
 * values are used. Whether a brief carried the campaign-to-date denial digest
 * is read off the wave records' `s4.pacingFromDenials` (the runner records the
 * brief generator's own predicate), never off a brief's text.
 */
export function campaignAssessment({ spec, state, waves, row, rows, gateLines, denialAnalysis, identity, identityHistory, commitsLanded = 0, seatAuthority }) {
  const s = state ?? {}
  const ws = waves ?? []
  const campRows = rows ?? (row ? [row] : [])
  const proposals = Array.isArray(s.proposals) ? s.proposals : []
  const history = identityHistory ?? identityHistoryOf({ waves: ws, rows: campRows, row })
  const gl = gateLines?.byAuthor
  const facts = {
    gateAuthor: spec?.author ?? 'human',
    waves: ws.filter(w => w?.gradedAt).length,
    rows: campRows.length,
    // "ran at least once in this campaign": the runner keeps the last analysis
    // on state, so an analysis from an earlier wave still counts.
    denialAnalysis: Boolean(denialAnalysis ?? s.denialAnalysis),
    proposalRaised: proposals.length > 0,
    // The cap family is the one proposal the denial analysis itself raises.
    proposalFromDenials: proposals.some(p => String(p?.name).startsWith('invariants/')),
    proposalApproved: proposals.some(p => p?.status === 'approved'),
    configurationApplied: Object.keys(s.invariantOverrides ?? {}).length > 0 || ws.some(w => w?.s4?.workOrder?.applied === true),
    seatEvidence: ((gl?.cynco?.n ?? 0) + (gl?.human?.n ?? 0)) > 0 || ws.some(w => w?.s4?.ideation),
    seatAuthority: seatAuthority ?? Math.max(s.ideationAuthority ?? 0, s.gateAuthorAuthority ?? 0),
    commitsLanded,
    // Campaign to date: any wave's brief (this one included) carried the digest.
    pacingDigest: ws.some(w => w?.s4?.pacingFromDenials === true),
    identityHistory: {
      waves: history.waves.length, intact: history.waves.filter(v => v === true).length,
      rows: history.rows.length, passed: history.rows.filter(v => v === true).length,
    },
  }
  const { productions, unproduced } = campaignNetwork(facts)
  const criteria = criteriaFromFacts(facts, identity)
  const core = autopoiesis.missingCriteria(criteria)
  const missing = CRITERIA.filter(k => core.includes(CORE_NAME[k]))
  if (missing.length !== core.length) throw new Error(`the core reports criteria this checklist cannot name: ${core.join(', ')}`)
  return { criteria, isAutopoietic: autopoiesis.isAutopoietic(criteria), missing, network: { unproduced, productions }, facts }
}

/**
 * The six criteria from a `facts` object alone plus an identity reading — the
 * one place the mapping lives. campaignAssessment derives the facts and calls
 * this; a stored record's `facts` can be re-run through it (with the wave's
 * stored `identity`, or a current one) without re-measuring anything.
 */
export function criteriaFromFacts(facts, identity) {
  const f = facts ?? {}
  const ih = f.identityHistory ?? { waves: 0, intact: 0, rows: 0, passed: 0 }
  const intact = identity?.intact === true
  return {
    hasBoundary: intact,
    boundarySelfProduced: f.gateAuthor === 'cynco',
    internalProduction: (f.commitsLanded ?? 0) >= 1,
    circularProduction: (f.denialAnalysis === true && f.proposalFromDenials === true) || f.pacingDigest === true,
    organizationallyClosed: campaignNetwork(f).network.isClosed(),
    organizationMaintained: intact && ih.intact === ih.waves && ih.passed === ih.rows,
  }
}

/** The effective seat authority: the campaign's own values and, when a home is
 *  given, the retained seats store (scripts/cynco-proposals.mjs) — the same
 *  reading for the runner's VERDICT and the `--autopoiesis` verb. */
export function effectiveSeatAuthority(state, home) {
  const s = state ?? {}
  return Math.max(s.ideationAuthority ?? 0, s.gateAuthorAuthority ?? 0,
    home ? storedSeatAuthority(home, 'ideation') : 0, home ? storedSeatAuthority(home, 'gate-author') : 0)
}

/** The verdict entry's line; null when no reading was taken. */
export function autopoiesisLine(a) {
  if (!a) return null
  if (a.assessError) return `- Autopoiesis: UNASSESSED — ${a.assessError}`
  const met = CRITERIA.filter(k => a.criteria?.[k]).length
  return a.missing?.length ? `- Autopoiesis: ${met}/6 — missing ${a.missing.join(', ')}` : `- Autopoiesis: ${met}/6`
}

/**
 * `--autopoiesis`: the same checklist over a campaign that already ran, from
 * what is stored — the last graded wave is "this wave". Writes nothing.
 */
export function storedAssessment({ spec, state, waves, ledgerRows, gateLines, seatAuthority }) {
  const s = state ?? {}
  const ws = waves ?? []
  const last = [...ws].reverse().find(w => w?.gradedAt) ?? null
  const row = last?.missionId ? ((ledgerRows ?? []).find(r => r?.missionId === last.missionId) ?? { missionId: last.missionId }) : null
  const rows = campaignRows({ waves: ws, ledgerRows, row })
  return campaignAssessment({ spec, state: s, waves: ws, row, rows, gateLines, denialAnalysis: s.denialAnalysis ?? null,
    identity: last?.identity ?? null, commitsLanded: s.lastCommits?.length ?? 0, seatAuthority })
}
