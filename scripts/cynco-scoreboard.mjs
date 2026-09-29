// scripts/cynco-scoreboard.mjs — Phase 5 ruling 2: the harness scoreboard.
//
// The four headline numbers the programme's goal names, computed per campaign
// and pooled over RUNNER-DRIVEN campaigns (those with a
// `<cyncoHome>/campaigns/<id>/waves.jsonl`). One spelling of each definition,
// each its own exported function, read by every VERDICT (the entry's
// `- Scoreboard:` line and the wave record's `scoreboard`), by
// `bun scripts/cynco-campaign.mjs <spec> --scoreboard`, and by the dashboard.
//
// Pure: everything comes in as arguments — the campaign state object, the wave
// records, the ledger rows, the rule-verdicts file, the economics lines. The
// definitions are stated verbatim in benchmark/cynco-ledger/README.md
// ("Scoreboard"); a change here is a change there.
//
// Unmeasured is `null` WITH its reason in `unmeasured`, never 0 (F16).

/** The decisions that end a campaign as PASS (decide(), scripts/cynco-campaign.mjs). */
export const PASS_KINDS = Object.freeze(['pass', 'pass-with-survivors'])

/**
 * The waves a campaign SPENT: every record except a STOP. A stop is a refusal
 * to dispatch — stopWave writes it so the reason is on the record, but nothing
 * ran and waveCount does not move. A fault spent its wave (ruling 8) and counts.
 */
export function spentWaves(waves) {
  return (waves ?? []).filter(w => w && w.decision?.kind !== 'stop')
}

/**
 * Where the campaign stands: the last spent wave's decision. Decided means that
 * decision is a PASS. Everything else — `next`, `fault`, and `budget` /
 * `no-progress` too — is open: a budget stop is resumed with `--waves N`
 * (C8's waves 1 and 2 both read STOP (budget) and wave 3 passed).
 */
export function campaignDecision(waves) {
  const spent = spentWaves(waves)
  const decision = spent.at(-1)?.decision?.kind ?? null
  return { decided: PASS_KINDS.includes(decision), decision, spent: spent.length }
}

/** This campaign's ledger rows by missionId (the first row wins, as campaignRows). */
function rowsByMission(waves, rows) {
  const ids = new Set(spentWaves(waves).map(w => w.missionId).filter(Boolean))
  const byId = new Map()
  for (const r of rows ?? []) if (r?.missionId && ids.has(r.missionId) && !byId.has(r.missionId)) byId.set(r.missionId, r)
  return byId
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Σ durationS/3600 over the spent waves: the wave record's own `durationS`,
 * else its ledger row's. A wave with neither (a fault whose driver wrote no
 * row) is named in `missing` — the hours are then a floor, not a total, and no
 * rate is computed over them (ratePerGpuHour).
 *
 * `upperBound` names the waves whose record hours are a fault's wall clock
 * since dispatch (`durationFrom: 'wall-clock'`, faultWave) — counted, but an
 * UPPER bound (it includes the wait on a driver that may have died in minute
 * one), so any rate over them is a floor and prints `≥` (final review I2).
 */
export function gpuHours({ waves, rows }) {
  const byId = rowsByMission(waves, rows)
  let seconds = 0, counted = 0
  const missing = [], upperBound = []
  for (const w of spentWaves(waves)) {
    const own = isNum(w.durationS)
    const d = own ? w.durationS : byId.get(w.missionId)?.durationS
    if (isNum(d)) { seconds += d; counted++; if (own && w.durationFrom === 'wall-clock') upperBound.push(w.wave) } else missing.push(w.wave)
  }
  return { hours: counted ? seconds / 3600 : null, missing, upperBound }
}

/** The `unmeasured` note for a wave whose hours are a wall-clock upper bound. */
export const upperBoundNote = (n) => `gpuHours: wave ${n} hours are a wall-clock upper bound (fault) — the rate is a floor`

/**
 * The one spelling of "PASSes ÷ GPU-hours", shared by the campaign and the
 * pooled board. `missing` names the waves whose hours are unmeasured: with any
 * of them the Σ is only a floor, and a floor in the denominator overstates the
 * rate — so the rate is null with the reason, never a number (F16).
 */
export function ratePerGpuHour(passes, hours, missing = []) {
  if (missing.length) return { value: null, reason: `hours unmeasured for ${missing.join(', ')} — an unmeasured hour cannot make a denominator` }
  if (!hours) return { value: null, reason: 'no spent wave carries a durationS' }
  return { value: passes / hours, reason: null }
}

/**
 * passRatePerGpuHour = decided-PASS campaigns ÷ Σ durationS/3600 over every
 * wave. Per campaign: 1 ÷ its GPU-hours when it decided PASS; an undecided
 * campaign is `open`.
 */
export function passRatePerGpuHour({ waves, rows }) {
  const d = campaignDecision(waves)
  if (!d.decided) return { value: null, reason: `open — undecided after ${d.spent} wave(s)` }
  const { hours, missing } = gpuHours({ waves, rows })
  return ratePerGpuHour(1, hours, missing.map(n => `wave ${n}`))
}

/** wavesPerCampaign = waves to the decision; an undecided campaign is `N so far (open)`. */
export function wavesPerCampaign({ waves }) {
  const d = campaignDecision(waves)
  return d.decided ? { value: d.spent, reason: null } : { value: null, reason: `${d.spent} so far (open)` }
}

/** A wave whose gate was actually graded: a gate block with a FAIL list, a terminator, and no harness fault. */
const gradedGate = (w) => Boolean(w?.gate && Array.isArray(w.gate.fails) && w.gate.terminator != null && !w.gate.harnessFault)

/**
 * The commits a wave landed: the runner's `commitsBetween` count, stored on
 * the record as `outcome.commitsLanded` (also read at top level). A record
 * that predates the field is read off `state.lastCommits` when it is the wave
 * the state last graded — the reading `--autopoiesis` takes — and is otherwise
 * UNKNOWN (null), never 0. `toolStats.commits` is a different instrument (the
 * mission's commit-class Bash calls; README "facts.commitsLanded") and is not
 * substituted.
 */
export function commitsLandedOf(w, state) {
  const n = w?.commitsLanded ?? w?.outcome?.commitsLanded
  if (Number.isInteger(n)) return n
  if (w?.missionId && state?.lastRow?.missionId === w.missionId && Array.isArray(state.lastCommits)) return state.lastCommits.length
  return null
}

/**
 * gateLinesFixedPerLandedWave = Σ over waves with ≥ 1 landed commit of
 * max(0, failsBefore − failsAfter) ÷ the number of such waves. failsBefore is
 * the previous graded wave's `gate.fails.length` (wave 1:
 * `calibration.baseFails.length`); failsAfter is this wave's. A wave that
 * graded no gate (fault) is excluded and named; so is a graded wave whose
 * commit count is unknown.
 */
export function gateLinesFixedPerLandedWave({ state, waves }) {
  const base = state?.calibration?.baseFails
  let before = Array.isArray(base) ? base.length : null
  // graded: waves with a graded gate; known: of those, with a readable commit
  // count and failsBefore; unknown: the rest. They decide which reason a null
  // carries (linesFixedReason) — "no wave landed a commit" is a claim the
  // records must actually make.
  let fixed = 0, landedWaves = 0, graded = 0, known = 0, unknown = 0
  const excluded = []
  const spent = spentWaves(waves)
  for (const w of spent) {
    if (!gradedGate(w)) { excluded.push(`wave ${w.wave} graded no gate (${w.decision?.kind ?? 'no decision'}) — excluded`); continue }
    graded++
    const after = w.gate.fails.length
    const commits = commitsLandedOf(w, state)
    if (commits === null) { unknown++; excluded.push(`wave ${w.wave} has no commitsLanded on its record — excluded, not read as 0`) }
    else if (commits >= 1 && before === null) { unknown++; excluded.push(`wave ${w.wave} has no failsBefore (no calibration.baseFails) — excluded`) }
    else {
      known++
      if (commits >= 1) { fixed += Math.max(0, before - after); landedWaves++ }
    }
    before = after
  }
  const reason = linesFixedReason({ spent: spent.length, graded, known, unknown, landedWaves })
  return { value: landedWaves ? fixed / landedWaves : null, landedWaves, fixed, graded, known, unknown, reason, excluded }
}

/** Why gateLinesFixedPerLandedWave is null — shared by the campaign and the pooled board. */
export function linesFixedReason({ spent, graded, known, unknown, landedWaves }) {
  if (landedWaves) return null
  if (!spent) return 'no waves spent'
  if (!graded) return 'every wave excluded — none graded a gate (see unmeasured)'
  if (unknown && !known) return 'commit counts unknown (see unmeasured)'
  if (unknown) return `no known-count wave landed; ${unknown} unknown (see unmeasured)`
  return 'no wave landed a commit'
}

/**
 * humanInterventionsPerWave = (operator notes delivered + proposals decided by
 * a human + supervisor refusals + reseals + adopted waves) ÷ waves.
 *
 * The stated PROXY for "supervisor minutes per wave" — minutes are recorded
 * nowhere; the count of human acts is what can be measured.
 *   - notes: `operatorNotes[]` on this campaign's rows with
 *     `deliveredAtIteration` set and `source === 'operator'`. The driver's
 *     re-injected probe (`source: 'driver'`) is not a human act; a note with no
 *     source is unknown (the ledger README: "never as operator") and is counted
 *     in `unknownSourceNotes`, not here.
 *   - humanDecisions: proposals `approved`/`rejected` with `decidedBy` ≠
 *     `auto` (only a gate seal at earned authority writes `auto`; every
 *     operator verb is a human decision, whether or not it wrote `decidedBy`).
 *   - refusals: every `state.authoring.<id>.refusals[]` entry.
 *   - reseals: `state.reseals[]`.
 *   - adopted: wave records marked `adopted: true` — an `--adopt-inflight` or
 *     `cynco-campaign-adopt.mjs` hand-off (records before Phase 5 carry no mark).
 *
 * Phase 6 ruling 8: the count starts at the SEAL. When the campaign's own
 * authoring record carries `sealedAt` (`state.authoring[spec.id].sealedAt`,
 * written by `sealGate`), a refusal (`at`) or a proposal decision
 * (`decidedAt`) dated before it is an AUTHORING-phase act — it shaped the gate,
 * not a wave — and is left out and counted in `beforeSeal` (named in
 * `unmeasured`). An act with no readable date cannot be placed either side of
 * the seal, so it IS counted, and `undated` names it. Reseals, notes and
 * adoptions happen to waves and are post-seal by construction. A campaign with
 * no seal record (a human-sealed gate, or a call with no `spec`) counts every
 * act, as before.
 */
export function humanInterventionsPerWave({ spec = null, state, waves, rows }) {
  const s = state ?? {}
  const sealedAt = spec?.id ? s.authoring?.[spec.id]?.sealedAt ?? null : null
  const sealMs = sealedAt === null ? NaN : Date.parse(sealedAt)
  let beforeSeal = 0, undated = 0
  // true = the act counts. Only consulted when there is a seal to compare to.
  const afterSeal = (when) => {
    if (Number.isNaN(sealMs)) return true
    const t = typeof when === 'string' ? Date.parse(when) : NaN
    if (Number.isNaN(t)) { undated++; return true }
    if (t < sealMs) { beforeSeal++; return false }
    return true
  }
  const spent = spentWaves(waves)
  let notes = 0, unknownSourceNotes = 0
  for (const r of rowsByMission(waves, rows).values()) {
    for (const n of Array.isArray(r.operatorNotes) ? r.operatorNotes : []) {
      if (n?.deliveredAtIteration === null || n?.deliveredAtIteration === undefined) continue
      if (n.source === 'operator') notes++
      else if (n.source !== 'driver') unknownSourceNotes++
    }
  }
  const humanDecisions = (Array.isArray(s.proposals) ? s.proposals : [])
    .filter(p => (p?.status === 'approved' || p?.status === 'rejected') && p.decidedBy !== 'auto')
    .filter(p => afterSeal(p.decidedAt ?? p.at)).length
  const refusals = Object.values(s.authoring ?? {})
    .flatMap(a => (Array.isArray(a?.refusals) ? a.refusals : []))
    .filter(r => afterSeal(r?.at)).length
  const reseals = Array.isArray(s.reseals) ? s.reseals.length : 0
  const adopted = spent.filter(w => w.adopted === true).length
  const { value, reason } = perWave(notes + humanDecisions + refusals + reseals + adopted, spent.length)
  return { value, notes, humanDecisions, refusals, reseals, adopted, unknownSourceNotes, sealedAt, beforeSeal, undated, reason }
}

// "Best" over verdict-file entries: a PREDICTIVE entry first; then one with
// enough evidence to be read at all (not `TOO FEW`); then the highest
// precision; ties by id. An entry with no numeric precision never wins.
function bestOf(entries) {
  const rank = ([id, r]) => [r.verdict === 'PREDICTIVE' ? 0 : 1, String(r.verdict ?? '').startsWith('TOO FEW') ? 1 : 0, -r.precision, id]
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1 } return 0 }
  const ranked = entries.filter(([, r]) => isNum(r?.precision)).sort((a, b) => cmp(rank(a), rank(b)))
  return ranked[0] ? { id: ranked[0][0], precision: ranked[0][1].precision, ci: ranked[0][1].ci ?? null, verdict: ranked[0][1].verdict ?? null } : null
}

/**
 * perRulePrecision = from rule-verdicts.json: predictive count ÷ total over
 * the S5 RULES, and the single best rule with its precision, CI and verdict
 * (bestOf). The learner's `M1.*` rows (`source: 'model'`, Phase 5 ruling 5)
 * share the file and the Holm family but are not rules — the engine never
 * grants them authority — so they are neither counted nor ranked here; the
 * best of them is the sibling `learner` field, null when the file has none.
 * null when there is no verdict file.
 */
export function perRulePrecision(ruleVerdicts) {
  const all = ruleVerdicts?.rules
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null
  const entries = Object.entries(all)
  // Phase 6: the runner's shadow regulator (`R1.no-progress`, source 'runner')
  // is not a rule either — neither counted nor ranked.
  const rules = entries.filter(([, r]) => r?.source !== 'model' && r?.source !== 'runner')
  const models = entries.filter(([, r]) => r?.source === 'model')
  const predictive = rules.filter(([, r]) => r?.verdict === 'PREDICTIVE').length
  return { predictive, total: rules.length, best: bestOf(rules), learner: bestOf(models) }
}

/**
 * The frontier SUPERVISING dollars from the economics script's VERDICT line
 * (`VERDICT: frontier spent $N SUPERVISING …`, scripts/supervision-economics.mjs),
 * as `economicsLines()` returns it (an array) or as text. null when absent.
 */
export function parseSupervisionDollars(economics) {
  const text = Array.isArray(economics) ? economics.join(' ') : typeof economics === 'string' ? economics : ''
  const m = /\$([0-9][0-9,]*(?:\.[0-9]+)?)\s+SUPERVISING/.exec(text) ?? /SUPERVISING\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(text)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

/**
 * supervisionDollarsPerWave = the economics script's SUPERVISING dollars ÷
 * waves, printed beside humanInterventionsPerWave. The script prices the
 * WHOLE supervision history, not one campaign, so the per-campaign figure is
 * that total over this campaign's waves and says so where it prints.
 */
export function supervisionDollarsPerWave({ economics, waves }) {
  if (economics === null || economics === undefined) return { value: null, dollars: null, reason: 'no economics line (the economics script did not run)' }
  const dollars = parseSupervisionDollars(economics)
  if (dollars === null) return { value: null, dollars: null, reason: 'the economics line carries no SUPERVISING figure' }
  return { ...perWave(dollars, waves), dollars }
}

/**
 * The one spelling of "a count ÷ waves" — humanInterventionsPerWave and
 * supervisionDollarsPerWave, per campaign and pooled.
 */
export function perWave(n, waves) {
  return waves ? { value: n / waves, reason: null } : { value: null, reason: 'no waves spent' }
}

/** One campaign's board. `spec` supplies the id; `rows` may be the whole ledger (joined by missionId). */
export function campaignScoreboard({ spec, state, waves, rows, ruleVerdicts = null, economics = null }) {
  const ws = waves ?? []
  const d = campaignDecision(ws)
  const gpu = gpuHours({ waves: ws, rows })
  const rate = passRatePerGpuHour({ waves: ws, rows })
  const wpc = wavesPerCampaign({ waves: ws })
  const gl = gateLinesFixedPerLandedWave({ state, waves: ws })
  const hi = humanInterventionsPerWave({ spec, state, waves: ws, rows })
  const rp = perRulePrecision(ruleVerdicts)
  const sup = supervisionDollarsPerWave({ economics, waves: d.spent })
  const unmeasured = []
  if (rate.value === null) unmeasured.push(`passRatePerGpuHour: ${rate.reason}`)
  if (wpc.value === null) unmeasured.push(`wavesPerCampaign: ${wpc.reason}`)
  for (const n of gpu.missing) unmeasured.push(`gpuHours: wave ${n} has no durationS on its record or ledger row — the hours are a floor`)
  for (const n of gpu.upperBound) unmeasured.push(upperBoundNote(n))
  for (const e of gl.excluded) unmeasured.push(`gateLinesFixedPerLandedWave: ${e}`)
  if (gl.value === null) unmeasured.push(`gateLinesFixedPerLandedWave: ${gl.reason}`)
  if (hi.value === null) unmeasured.push(`humanInterventionsPerWave: ${hi.reason}`)
  if (hi.unknownSourceNotes) unmeasured.push(`humanInterventionsPerWave: ${hi.unknownSourceNotes} delivered note(s) carry no source — unknown sender, not counted`)
  if (hi.beforeSeal) unmeasured.push(`humanInterventionsPerWave: ${hi.beforeSeal} act(s) before the seal (${hi.sealedAt}) not counted — authoring-phase, not campaign, interventions`)
  if (hi.undated) unmeasured.push(`humanInterventionsPerWave: ${hi.undated} act(s) carry no date — counted, though they cannot be placed after the seal (${hi.sealedAt})`)
  if (rp === null) unmeasured.push('perRulePrecision: no rule-verdicts.json — missing or unreadable')
  if (sup.value === null) unmeasured.push(`supervisionDollarsPerWave: ${sup.reason}`)
  return {
    id: spec?.id ?? null, decided: d.decided, decision: d.decision, waves: d.spent, gpuHours: gpu.hours, gpuHoursMissing: gpu.missing,
    gpuHoursUpperBound: gpu.upperBound,
    passRatePerGpuHour: rate.value, passRatePerGpuHourIsLowerBound: isNum(rate.value) && gpu.upperBound.length > 0, wavesPerCampaign: wpc.value,
    gateLinesFixedPerLandedWave: { value: gl.value, landedWaves: gl.landedWaves, fixed: gl.fixed, graded: gl.graded, known: gl.known, unknown: gl.unknown, reason: gl.reason },
    humanInterventionsPerWave: { value: hi.value, notes: hi.notes, humanDecisions: hi.humanDecisions, refusals: hi.refusals, reseals: hi.reseals, adopted: hi.adopted, reason: hi.reason },
    perRulePrecision: rp, supervisionDollars: sup.dollars, supervisionDollarsPerWave: sup.value, unmeasured,
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0)
// The per-campaign `unmeasured` notes that name a single wave (or a note)
// dropping out of a denominator; the pooled board carries them per campaign.
const POOLED_WAVE_NOTES = ['gpuHours', 'gateLinesFixedPerLandedWave', 'humanInterventionsPerWave']

/**
 * The pooled board over campaign boards. A board that could not be computed
 * (`error`) or spent no wave is excluded and named; `opts.excluded` adds the
 * caller's own exclusions (hand-driven missions, dirs with no waves.jsonl).
 * The ratios pool over waves (Σ numerator ÷ Σ denominator), not a mean of
 * per-campaign ratios; wavesPerCampaign is the mean over DECIDED campaigns.
 */
export function pooledScoreboard(campaignScoreboards, opts = {}) {
  const included = [], excluded = []
  for (const b of campaignScoreboards ?? []) {
    if (!b) continue
    if (b.error) excluded.push(`${b.id ?? '?'}: ${b.error}`)
    else if (!(b.waves > 0)) excluded.push(`${b.id ?? '?'}: no waves spent`)
    else included.push(b)
  }
  excluded.push(...(opts.excluded ?? []))
  const decided = included.filter(b => b.decided)
  const waves = sum(included.map(b => b.waves))
  const hours = sum(included.map(b => b.gpuHours ?? 0))
  const unmeasured = []
  // Every campaign's per-wave exclusions reach the pooled board, named by
  // campaign: a wave that dropped out of a denominator anywhere is counted
  // here too, not only on its own campaign's board.
  for (const b of included) {
    for (const u of b.unmeasured ?? []) {
      const field = POOLED_WAVE_NOTES.find(f => u.startsWith(`${f}: wave `) || (f === 'humanInterventionsPerWave' && u.startsWith(`${f}: `) && /delivered note|the seal/.test(u)))
      if (field) unmeasured.push(`${field}: ${b.id} ${u.slice(field.length + 2)}`)
    }
  }

  // passRatePerGpuHour: the same ratePerGpuHour the campaign board uses, over
  // every included campaign's hours — open campaigns' included.
  const rate = decided.length
    ? ratePerGpuHour(decided.length, hours, included.flatMap(b => (b.gpuHoursMissing ?? []).map(n => `${b.id} wave ${n}`)))
    : { value: null, reason: 'no runner-driven campaign has decided yet' }
  if (rate.value === null) unmeasured.push(`passRatePerGpuHour: ${rate.reason}`)
  // Any included wave's hours a wall-clock upper bound → the pooled Σ is too,
  // and the rate over it a floor (I2). The per-wave notes arrived above.
  const upperBound = included.flatMap(b => (b.gpuHoursUpperBound ?? []).map(n => `${b.id} wave ${n}`))
  const wpc = decided.length ? sum(decided.map(b => b.wavesPerCampaign)) / decided.length : null
  if (wpc === null) unmeasured.push('wavesPerCampaign: no runner-driven campaign has decided yet')

  const g = (k) => sum(included.map(b => b.gateLinesFixedPerLandedWave?.[k] ?? 0))
  const lines = { landedWaves: g('landedWaves'), fixed: g('fixed'), graded: g('graded'), known: g('known'), unknown: g('unknown') }
  const glReason = linesFixedReason({ spent: waves, ...lines })
  if (glReason) unmeasured.push(`gateLinesFixedPerLandedWave: ${glReason}`)

  const h = (k) => sum(included.map(b => b.humanInterventionsPerWave?.[k] ?? 0))
  const human = { notes: h('notes'), humanDecisions: h('humanDecisions'), refusals: h('refusals'), reseals: h('reseals'), adopted: h('adopted') }
  const hi = perWave(sum(Object.values(human)), waves)
  if (hi.reason) unmeasured.push(`humanInterventionsPerWave: ${hi.reason}`)

  // The economics total is one whole-history figure; every board carries the
  // same one, so the first measured board's is it.
  const dollars = included.map(b => b.supervisionDollars).find(isNum) ?? null
  const sup = dollars === null
    ? { value: null, reason: included.length ? reasonOf(included[0], 'supervisionDollarsPerWave') : 'no waves spent' }
    : perWave(dollars, waves)
  if (sup.value === null) unmeasured.push(`supervisionDollarsPerWave: ${sup.reason}`)

  return {
    campaigns: included.length, decided: decided.length, waves, gpuHours: included.length ? hours : null, gpuHoursUpperBound: upperBound,
    passRatePerGpuHour: rate.value, passRatePerGpuHourIsLowerBound: isNum(rate.value) && upperBound.length > 0, wavesPerCampaign: wpc,
    gateLinesFixedPerLandedWave: { value: lines.landedWaves ? lines.fixed / lines.landedWaves : null, ...lines, reason: glReason },
    humanInterventionsPerWave: { value: hi.value, ...human, reason: hi.reason },
    supervisionDollars: dollars, supervisionDollarsPerWave: sup.value, excluded, unmeasured,
  }
}

const reasonOf = (b, field) => (b.unmeasured ?? []).find(u => u.startsWith(`${field}: `))?.slice(field.length + 2) ?? 'unmeasured'
const num = (v, d, reason) => (isNum(v) ? v.toFixed(d) : `null (${reason})`)
/** `≥ ` before a PASS/GPU-h whose hours include a wall-clock upper bound (I2). */
const floorMark = (b) => (b?.passRatePerGpuHourIsLowerBound === true ? '≥ ' : '')
const pct = (v) => (isNum(v) ? String(Math.round(v * 100)) : '?')

function bestText(best) {
  if (!best) return ''
  const ci = Array.isArray(best.ci) ? ` [${pct(best.ci[0])},${pct(best.ci[1])}]` : ''
  return ` (best ${best.id} ${pct(best.precision)}%${ci} ${best.verdict})`
}

/** The verdict entry's line is capped; the verb's detail lines carry everything. */
export const ENTRY_LINE_MAX = 200

// A reason cut to its head for the entry line: before the first " — " or " (",
// at most 32 characters. The full reason stays in `unmeasured`.
const short = (reason) => {
  const r = String(reason ?? 'unmeasured').split(' — ')[0].split(' (')[0]
  return r.length > 32 ? `${r.slice(0, 31)}…` : r
}

/**
 * The `- Scoreboard:` line: short reasons, and the best rule as
 * `best I3 58% NO EVIDENCE` (no CI; the verdict's head only), then the
 * learner's best `M1.*` row the same way. If it is still over ENTRY_LINE_MAX,
 * the reasons go and a bare `null` stays; if even that is over, the learner's
 * verdict goes too (the verb's detail line keeps it).
 */
function entryLine(sb) {
  const gl = sb.gateLinesFixedPerLandedWave ?? {}, hi = sb.humanInterventionsPerWave ?? {}, rp = sb.perRulePrecision
  const build = (level) => {
    const terse = level >= 1
    const nul = (reason) => (terse ? 'null' : `null (${short(reason)})`)
    const val = (v, reason) => (isNum(v) ? v.toFixed(2) : nul(reason))
    const rate = isNum(sb.passRatePerGpuHour) ? `${floorMark(sb)}${sb.passRatePerGpuHour.toFixed(3)}` : sb.decided ? nul(reasonOf(sb, 'passRatePerGpuHour')) : 'open'
    const waves = isNum(sb.wavesPerCampaign) ? `waves ${sb.wavesPerCampaign}` : `waves ${sb.waves} so far (open)`
    const best = rp?.best ? ` (best ${rp.best.id} ${pct(rp.best.precision)}% ${short(rp.best.verdict)})` : ''
    const rules = rp ? `${rp.predictive}/${rp.total}${best}` : nul(reasonOf(sb, 'perRulePrecision'))
    const learner = rp?.learner ? ` | learner ${rp.learner.id} ${pct(rp.learner.precision)}%${level >= 2 ? '' : ` ${short(rp.learner.verdict)}`}` : ''
    return `- Scoreboard: PASS/GPU-h ${rate} | ${waves} | lines fixed per landed wave ${val(gl.value, gl.reason)}`
      + ` | human interventions per wave ${val(hi.value, hi.reason)} | rules predictive ${rules}${learner}`
  }
  for (const level of [0, 1]) {
    const line = build(level)
    if (line.length <= ENTRY_LINE_MAX) return line
  }
  return build(2)
}

function pooledLines(p) {
  const gl = p.gateLinesFixedPerLandedWave, hi = p.humanInterventionsPerWave
  const lines = [`Pooled over ${p.campaigns} runner-driven campaign(s), ${p.decided} decided: `
    + `PASS/GPU-h ${isNum(p.passRatePerGpuHour) ? floorMark(p) : ''}${num(p.passRatePerGpuHour, 3, reasonOf(p, 'passRatePerGpuHour'))}`
    + ` | waves per campaign ${num(p.wavesPerCampaign, 2, reasonOf(p, 'wavesPerCampaign'))}`
    + ` | lines fixed per landed wave ${num(gl.value, 2, gl.reason)}`
    + ` | human interventions per wave ${num(hi.value, 2, hi.reason)}`]
  if (isNum(p.gpuHours)) lines.push(`  gpuHours ${p.gpuHours.toFixed(2)} over ${p.waves} wave(s); lines fixed ${gl.fixed} over ${gl.landedWaves} landed wave(s); `
    + `human acts: notes ${hi.notes}, human decisions ${hi.humanDecisions}, refusals ${hi.refusals}, reseals ${hi.reseals}, adoptions ${hi.adopted}`)
  lines.push(isNum(p.supervisionDollarsPerWave)
    ? `  supervisionDollarsPerWave ${p.supervisionDollarsPerWave.toFixed(2)} ($${p.supervisionDollars.toFixed(2)} whole-history SUPERVISING ÷ ${p.waves} runner-driven wave(s))`
    : `  supervisionDollarsPerWave null (${reasonOf(p, 'supervisionDollarsPerWave')})`)
  for (const e of p.excluded) lines.push(`Excluded: ${e}`)
  for (const u of p.unmeasured) lines.push(`  unmeasured: ${u}`)
  return lines
}

/**
 * The printed board. A campaign board → one `- Scoreboard: …` line (the
 * verdict entry's); `{ detail: true }` adds one line per definition with its
 * parts, the supervision dollars and every unmeasured reason (the verb's). A
 * pooled board → its own lines. A board that threw prints UNMEASURED.
 */
export function scoreboardLines(sb, { detail = false } = {}) {
  if (!sb) return []
  if (sb.error) return [`- Scoreboard: UNMEASURED — ${sb.error}`]
  if (Array.isArray(sb.excluded) && typeof sb.campaigns === 'number') return pooledLines(sb)
  const gl = sb.gateLinesFixedPerLandedWave ?? {}, hi = sb.humanInterventionsPerWave ?? {}, rp = sb.perRulePrecision
  const line = entryLine(sb)
  if (!detail) return [line]
  const lines = [line]
  lines.push(`  ${sb.id}: decision ${sb.decision ?? 'none'} (${sb.decided ? 'decided' : 'open'}); gpuHours ${num(sb.gpuHours, 2, 'no durations')} over ${sb.waves} wave(s)`)
  const bound = sb.passRatePerGpuHourIsLowerBound === true ? `, an upper bound (wave ${(sb.gpuHoursUpperBound ?? []).join(', ')} hours are a fault's wall clock)` : ''
  lines.push(`  passRatePerGpuHour ${isNum(sb.passRatePerGpuHour) ? `${floorMark(sb)}${sb.passRatePerGpuHour.toFixed(3)} = 1 PASS ÷ ${sb.gpuHours.toFixed(2)} GPU-h${bound}` : sb.decided ? `null (${reasonOf(sb, 'passRatePerGpuHour')})` : 'open'}`)
  lines.push(`  wavesPerCampaign ${isNum(sb.wavesPerCampaign) ? sb.wavesPerCampaign : `${sb.waves} so far (open)`}`)
  lines.push(`  gateLinesFixedPerLandedWave ${isNum(gl.value) ? `${gl.value.toFixed(2)} = ${gl.fixed} line(s) fixed ÷ ${gl.landedWaves} landed wave(s)` : `null (${gl.reason})`}`)
  lines.push(`  humanInterventionsPerWave ${num(hi.value, 2, hi.reason)} = (notes ${hi.notes} + human decisions ${hi.humanDecisions} + refusals ${hi.refusals} + reseals ${hi.reseals} + adoptions ${hi.adopted}) ÷ ${sb.waves}`)
  lines.push(`  perRulePrecision ${rp ? `${rp.predictive}/${rp.total} predictive${rp.best ? `; best${bestText(rp.best).replace(/^ \(best/, '').replace(/\)$/, '')}` : ''}` : `null (${reasonOf(sb, 'perRulePrecision')})`}`)
  // The learner's best M1.* row on the frozen holdout — not a rule, not counted above.
  if (rp) lines.push(`  learner ${rp.learner ? bestText(rp.learner).replace(/^ \(best /, '').replace(/\)$/, '') : 'none (no M1.* row in rule-verdicts.json)'}`)
  lines.push(isNum(sb.supervisionDollarsPerWave)
    ? `  supervisionDollarsPerWave ${sb.supervisionDollarsPerWave.toFixed(2)} ($${sb.supervisionDollars.toFixed(2)} whole-history SUPERVISING ÷ ${sb.waves} wave(s) — the economics script does not split by campaign)`
    : `  supervisionDollarsPerWave null (${reasonOf(sb, 'supervisionDollarsPerWave')})`)
  for (const u of sb.unmeasured ?? []) lines.push(`  unmeasured: ${u}`)
  return lines
}
