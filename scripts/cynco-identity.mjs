// scripts/cynco-identity.mjs — S5 identity as one machine-checked set.
//
// Phase 4 ("autopoiesis for real"): the campaign may change its own
// parameters — a seat's authority, a cap — but never what makes it THIS
// campaign. Before Phase 4 that set lived in four places at once (the spec
// loader's checkIdentity, the Rule 11 sha re-check, applyProposalDecision's
// tunable-cap list, the ledger's marker field) and nothing asked, at any one
// moment, whether all four still held. This module is that moment.
//
// Four invariants, each with its evidence:
//   gate-sealed      the instruments live under ~/.cynco/heldout/, checkIdentity
//                    passes, and a row that reports a sealed count reports >= 1
//   rule-11          the campaign is calibrated, and the runner re-checked the
//                    instrument shas for THIS wave before it did anything else
//   revert-refused   the revert ban is on in the spec AND in the effective
//                    invariants the wave was actually handed
//   marker-recorded  the spec names a completion marker, and the row says
//                    whether it was seen (null counts: "not seen" is recorded)
//
// `refusesIdentity(name)` is the other half: the proposal names no registry
// may ever approve, whatever the evidence says.
import { checkIdentity } from './cynco-campaign-spec.mjs'
import { effectiveInvariants } from './cynco-ideation.mjs'

export const IDENTITY_INVARIANTS = ['gate-sealed', 'rule-11', 'revert-refused', 'marker-recorded']

const HELDOUT = /\.cynco\/heldout\//
const norm = (p) => String(p ?? '').replace(/\\/g, '/')

function gateSealed({ spec, row, io }) {
  const problems = []
  const instruments = ['gate', 'perturb', ...(spec?.positive ? ['positive'] : [])]
  for (const k of instruments) if (!HELDOUT.test(norm(spec?.[k]))) problems.push(`${k} not under ~/.cynco/heldout/ (${spec?.[k] ?? 'unset'})`)
  const check = io?.checkIdentity ?? checkIdentity
  let checked
  try { checked = check(spec) }
  catch (e) { checked = { ok: false, problems: [`checkIdentity threw: ${e?.message ?? e}`] } }
  if (!checked?.ok) problems.push(`checkIdentity: ${(checked?.problems ?? ['refused']).join('; ')}`)
  // The ledger row carries no sealed count today; when a later row does, a
  // count of zero means the wave ran against no sealed instrument at all.
  const count = row ? (row.sealed?.count ?? row.verify?.sealedCount ?? null) : null
  let countDetail
  if (count === null) countDetail = 'no sealed count on row'
  else if (typeof count === 'number' && count >= 1) countDetail = `sealed count ${count}`
  else { countDetail = `sealed count ${count}`; problems.push(`row reports sealed count ${count} (must be >= 1)`) }
  return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `instruments under heldout; checkIdentity ok; ${countDetail}` }
}

function rule11({ state, wave }) {
  if (!state?.calibration?.gateSha256) return { ok: false, detail: 'no calibration on record' }
  if (wave && state.rule11CheckedWave !== wave) return { ok: false, detail: `the sha re-check did not run for wave ${wave} (last checked: ${state.rule11CheckedWave ?? 'never'})` }
  return { ok: true, detail: wave ? `calibrated; shas re-checked for wave ${wave}` : 'calibrated' }
}

function revertRefused({ spec, state }) {
  if (spec?.invariants?.revertBan !== true) return { ok: false, detail: 'spec.invariants.revertBan is not true' }
  if (effectiveInvariants(spec, state).revertBan !== true) return { ok: false, detail: 'the effective invariants do not carry revertBan' }
  return { ok: true, detail: 'revertBan on in spec and effective invariants' }
}

function markerRecorded({ spec, row }) {
  if (!(typeof spec?.marker === 'string' && spec.marker.length > 0)) return { ok: false, detail: 'spec names no marker' }
  if (row && row.markerSeen === undefined) return { ok: false, detail: 'the ledger row does not record markerSeen' }
  return { ok: true, detail: row ? `markerSeen ${row.markerSeen}` : 'marker named' }
}

const CHECKS = { 'gate-sealed': gateSealed, 'rule-11': rule11, 'revert-refused': revertRefused, 'marker-recorded': markerRecorded }

/**
 * Is the campaign still the campaign? Pure over its inputs; `io.checkIdentity`
 * is the only seam (default: the spec loader's real check, which reads the
 * disk and git). `wave` and `row` are absent outside a verdict — the operator
 * verbs assert identity with neither, and the wave-bound halves then pass.
 */
export function assertIdentityIntact({ spec, state, wave = null, row = null, io = {} } = {}) {
  const evidence = {}
  for (const name of IDENTITY_INVARIANTS) evidence[name] = CHECKS[name]({ spec, state, wave, row, io })
  const violated = IDENTITY_INVARIANTS.filter(n => !evidence[n].ok)
  return { intact: violated.length === 0, violated, evidence }
}

/** A proposal name that targets identity. No registry may approve one. */
export function refusesIdentity(name) {
  const n = String(name ?? '')
  return /^identity\//.test(n) || n === 'invariants/revertBan' || n === 'invariants/codeIndexFirst' || /^spec\//.test(n) || /^calibration\//.test(n)
}
