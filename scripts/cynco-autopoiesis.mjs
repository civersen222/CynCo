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
  ['validation', 'proposal', f => f.proposalRaised === true],
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
 * ledger rows (campaignRows). `commitsLanded` is this wave's commit count,
 * `pacingDigest` whether THIS wave's brief carried the campaign-to-date denial
 * digest, and `seatAuthority` the effective seat authority (the retained store
 * included) when the caller has it — otherwise the state's own values are used.
 */
export function campaignAssessment({ spec, state, waves, row, rows, gateLines, denialAnalysis, identity, identityHistory, commitsLanded = 0, pacingDigest = false, seatAuthority }) {
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
    proposalApproved: proposals.some(p => p?.status === 'approved'),
    configurationApplied: Object.keys(s.invariantOverrides ?? {}).length > 0 || ws.some(w => w?.s4?.workOrder?.applied === true),
    seatEvidence: ((gl?.cynco?.n ?? 0) + (gl?.human?.n ?? 0)) > 0 || ws.some(w => w?.s4?.ideation),
    seatAuthority: seatAuthority ?? Math.max(s.ideationAuthority ?? 0, s.gateAuthorAuthority ?? 0),
    commitsLanded,
    pacingDigest: pacingDigest === true,
    identityHistory: {
      waves: history.waves.length, intact: history.waves.filter(v => v === true).length,
      rows: history.rows.length, passed: history.rows.filter(v => v === true).length,
    },
  }
  const { network, productions, unproduced } = campaignNetwork(facts)
  const digestEver = facts.pacingDigest || ws.some(w => w?.autopoiesis?.facts?.pacingDigest === true)
  const criteria = {
    hasBoundary: identity?.intact === true,
    boundarySelfProduced: facts.gateAuthor === 'cynco',
    internalProduction: commitsLanded >= 1,
    circularProduction: (facts.denialAnalysis && facts.proposalRaised) || digestEver,
    organizationallyClosed: network.isClosed(),
    organizationMaintained: identity?.intact === true && history.waves.every(v => v === true) && history.rows.every(v => v === true),
  }
  const core = autopoiesis.missingCriteria(criteria)
  const missing = CRITERIA.filter(k => core.includes(CORE_NAME[k]))
  if (missing.length !== core.length) throw new Error(`the core reports criteria this checklist cannot name: ${core.join(', ')}`)
  return { criteria, isAutopoietic: autopoiesis.isAutopoietic(criteria), missing, network: { unproduced, productions }, facts }
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
export function storedAssessment({ spec, state, waves, ledgerRows, gateLines }) {
  const s = state ?? {}
  const ws = waves ?? []
  const last = [...ws].reverse().find(w => w?.gradedAt) ?? null
  const row = last?.missionId ? ((ledgerRows ?? []).find(r => r?.missionId === last.missionId) ?? { missionId: last.missionId }) : null
  const rows = campaignRows({ waves: ws, ledgerRows, row })
  return campaignAssessment({ spec, state: s, waves: ws, row, rows, gateLines, denialAnalysis: s.denialAnalysis ?? null,
    identity: last?.identity ?? null, commitsLanded: s.lastCommits?.length ?? 0, pacingDigest: last?.autopoiesis?.facts?.pacingDigest === true })
}
