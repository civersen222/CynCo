/**
 * Supervision economics: what the frontier model spends supervising vs what
 * the local model executes.
 *
 * The calibrated-gate thesis (memory: project_calibrated_gate_supervision.md):
 * the frontier model ONLY authors specs/contracts/gates, calibrates them, and
 * issues verdicts; every generation turn runs locally. Verification is cheaper
 * than generation, so the split IS the savings. This script measures both
 * sides from what each side already records:
 *
 *   FRONTIER — Claude Code session transcripts
 *     (~/.claude/projects/<project>/*.jsonl): every assistant message carries
 *     a `usage` block with real token counts. Each message is CLASSIFIED as
 *     supervision (gates, briefs, dispatch, verdicts, sweeps, ledger tooling,
 *     the civkings repo) or development (engine, tui, dashboard, benchmark
 *     code) by the targets of its tool calls; text-only messages inherit the
 *     running class of their session. Messages before the first classifiable
 *     tool call land in an explicit `unattributed` bucket — never silently
 *     folded into either side. The VERDICT uses supervision dollars only:
 *     building LocalCode is product work, not the cost of overseeing CynCo.
 *
 *   LOCAL — the mission ledger (benchmark/cynco-ledger/missions.*.jsonl):
 *     missions whose record carries `tokenStats` (session.tokenStats frames,
 *     the llama.cpp server's own measured timings) are priced REAL:
 *     decode @ output rate, cached prefix @ cache-read rate, evaluated
 *     prefill @ input rate. Missions without tokenStats (runs predating the
 *     frame, or runs that died before the first turn) fall back to the
 *     per-turn counterfactual ESTIMATE, and every row is labelled real/est —
 *     a guess is never allowed to masquerade as a measurement.
 *
 * Usage: node scripts/supervision-economics.mjs [--since YYYY-MM-DD]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---- assumptions, printed with every report ------------------------------
// Opus API list prices, USD per million tokens (2026-08).
const PRICE = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }
// Counterfactual pricing of MEASURED local tokens on the frontier API:
// decode -> output rate; cached prefix -> cache-read rate (the API would have
// served it from cache too); evaluated prefill -> input rate. Conservative:
// no cache-write surcharge is claimed.
// Fallback ESTIMATE for missions with no tokenStats, per generation turn:
const EST_PER_TURN = { outputPerTurn: 700, cacheReadPerTurn: 40000, freshInputPerTurn: 1500 }
// Local marginal cost: the 5090 box under mission load.
const LOCAL = { watts: 600, usdPerKwh: 0.15 }

const TRANSCRIPT_DIR = join(homedir(), '.claude', 'projects', 'C--Users-civer-localcode')
const LEDGER_DIR = 'benchmark/cynco-ledger'

const since = (() => {
  const i = process.argv.indexOf('--since')
  return i >= 0 ? process.argv[i + 1] : null
})()

// ---- frontier classifier -------------------------------------------------
// Deterministic, tool-target based. Supervision is checked FIRST: editing
// cynco-ledger.mjs is supervision tooling even though it is also code.
const SUPERVISION = [
  /civkings-redesign/i,                       // briefs, spec, plan, campaign docs
  /[\\/]\.cynco[\\/](heldout|staging|sessions|rewards)/i, // gates, staged assets, mission transcripts
  /gate_[cs]\d|perturb_[cs]\d/i,              // sealed gates + calibration probes
  /dispatch-mission|dispatch_[cs]?\d|driver_[cs]?\d/i, // dispatch script + run logs
  /cynco-mission-driver|cynco-ledger|cynco-mutation-sweep|cynco-ledger-sweep/i,
  /supervision-economics/i,
  /campaign-log|cynco-failure-log/i,
  /missions\.\d+\.jsonl/i,                    // ledger data files
  /Users[\\/]civer[\\/]civkings/i,            // the supervised repo itself
]
const DEVELOPMENT = [
  /[\\/]engine[\\/]|\bengine[\\/]/i,
  /[\\/]tui[\\/]|\btui[\\/]/i,
  /dashboard/i,
  /[\\/]benchmark[\\/]|\bbenchmark[\\/]/i,    // ledger data already caught above
  /\bbun (test|run)\b|vitest|npx tsc/i,
  /[\\/]memory[\\/]MEMORY|[\\/]memory[\\/].*\.md/i,
  /[\\/]scripts[\\/]|\bscripts[\\/]/i,        // non-cynco scripts (cynco ones caught above)
  /[\\/]docs[\\/]|\bdocs[\\/]/i,              // non-civkings docs (redesign docs caught above)
]

function classifyText(s) {
  for (const p of SUPERVISION) if (p.test(s)) return 'supervision'
  for (const p of DEVELOPMENT) if (p.test(s)) return 'development'
  return null
}

/** Class of one assistant message from its tool_use blocks, or null. */
function classifyMessage(content) {
  if (!Array.isArray(content)) return null
  let cls = null
  for (const block of content) {
    if (block?.type !== 'tool_use') continue
    const got = classifyText(JSON.stringify(block.input ?? {}))
    if (got === 'supervision') return 'supervision' // supervision wins outright
    if (got === 'development') cls = 'development'
  }
  return cls
}

// ---- frontier side -------------------------------------------------------
const emptyUsage = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 })
const byDay = new Map() // day -> {supervision, development, unattributed} of emptyUsage()
for (const f of readdirSync(TRANSCRIPT_DIR).filter(f => f.endsWith('.jsonl'))) {
  const lines = readFileSync(join(TRANSCRIPT_DIR, f), 'utf-8').split('\n')
  let context = null // running class within this session file
  for (const line of lines) {
    if (!line.includes('"message"')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d?.type !== 'assistant') continue
    const cls = classifyMessage(d.message?.content)
    if (cls) context = cls
    const u = d.message?.usage
    if (!u || typeof u.output_tokens !== 'number') continue
    const day = (d.timestamp ?? '').slice(0, 10)
    if (!day) continue
    const bucket = cls ?? context ?? 'unattributed'
    const t = byDay.get(day) ?? {
      supervision: emptyUsage(), development: emptyUsage(), unattributed: emptyUsage(),
    }
    const b = t[bucket]
    b.input += u.input_tokens ?? 0
    b.output += u.output_tokens ?? 0
    b.cacheWrite += u.cache_creation_input_tokens ?? 0
    b.cacheRead += u.cache_read_input_tokens ?? 0
    b.msgs += 1
    byDay.set(day, t)
  }
}

const usd = t =>
  (t.input * PRICE.input + t.output * PRICE.output +
   t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6

// ---- local side ----------------------------------------------------------
const emptyBucket = () => ({
  missions: 0, turns: 0, toolCalls: 0, hours: 0,
  realMissions: 0, estMissions: 0,
  // measured tokens (summed over missions that have tokenStats)
  prefillTokens: 0, cachedTokens: 0, decodeTokens: 0, unmeasuredTurns: 0,
  estTurns: 0, // turns priced by the per-turn fallback
})
const campaigns = new Map() // 'c1' -> bucket
const otherMissions = emptyBucket()
for (const f of readdirSync(LEDGER_DIR).filter(f => /^missions\..*\.jsonl$/.test(f))) {
  for (const line of readFileSync(join(LEDGER_DIR, f), 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (since && (r.dispatchedAt ?? '') < since) continue
    const m = /^(c\d)-/.exec(r.missionId ?? '')
    const bucket = m ? (campaigns.get(m[1]) ?? emptyBucket()) : otherMissions
    const turns = Array.isArray(r.turns) ? r.turns.length : 0
    bucket.missions += 1
    bucket.turns += turns
    bucket.toolCalls += r.toolStats?.total ?? 0
    bucket.hours += (r.durationS ?? 0) / 3600
    const ts = r.tokenStats
    if (ts && typeof ts.decodeTokens === 'number') {
      bucket.realMissions += 1
      bucket.prefillTokens += ts.prefillTokens ?? 0
      bucket.cachedTokens += ts.cachedTokens ?? 0
      bucket.decodeTokens += ts.decodeTokens ?? 0
      bucket.unmeasuredTurns += ts.unmeasuredTurns ?? 0
      bucket.estTurns += ts.unmeasuredTurns ?? 0 // unmeasured is not free
    } else {
      bucket.estMissions += 1
      bucket.estTurns += turns
    }
    if (m) campaigns.set(m[1], bucket)
  }
}

// Real counterfactual: measured tokens at API rates.
const realUsd = b =>
  (b.decodeTokens * PRICE.output + b.cachedTokens * PRICE.cacheRead +
   b.prefillTokens * PRICE.input) / 1e6
// Fallback estimate for unmeasured turns.
const estUsd = b => (b.estTurns * (EST_PER_TURN.outputPerTurn * PRICE.output +
  EST_PER_TURN.cacheReadPerTurn * PRICE.cacheRead +
  EST_PER_TURN.freshInputPerTurn * PRICE.input)) / 1e6

// ---- report --------------------------------------------------------------
const f2 = n => n.toFixed(2)
const fmt = n => n.toLocaleString('en-US')

console.log('SUPERVISION ECONOMICS — frontier (verify) vs local (generate)')
console.log(`assumptions: API $/MTok in=${PRICE.input} out=${PRICE.output} cacheW=${PRICE.cacheWrite} cacheR=${PRICE.cacheRead};`)
console.log(`  local counterfactual: REAL rows price measured tokens (decode@out, cached@cacheR, prefill@in);`)
console.log(`  EST rows/turns use ${EST_PER_TURN.outputPerTurn} out + ${EST_PER_TURN.cacheReadPerTurn} cacheRead + ${EST_PER_TURN.freshInputPerTurn} freshIn per turn;`)
console.log(`  local power ${LOCAL.watts}W @ $${LOCAL.usdPerKwh}/kWh${since ? `; window since ${since}` : ''}`)
console.log('')
console.log('FRONTIER (Claude Code sessions, real usage, classified by tool targets):')
console.log('  day          msgs   supervise$   develop$   unattrib$      total$')
const ftot = { supervision: emptyUsage(), development: emptyUsage(), unattributed: emptyUsage() }
for (const day of [...byDay.keys()].sort()) {
  if (since && day < since) continue
  const t = byDay.get(day)
  const msgs = t.supervision.msgs + t.development.msgs + t.unattributed.msgs
  console.log(`  ${day}  ${String(msgs).padStart(5)}   $${f2(usd(t.supervision)).padStart(8)}  $${f2(usd(t.development)).padStart(8)}  $${f2(usd(t.unattributed)).padStart(8)}   $${f2(usd(t.supervision) + usd(t.development) + usd(t.unattributed)).padStart(8)}`)
  for (const k of Object.keys(ftot)) {
    for (const kk of Object.keys(ftot[k])) ftot[k][kk] += t[k][kk]
  }
}
const supUsd = usd(ftot.supervision)
const devUsd = usd(ftot.development)
const unattrUsd = usd(ftot.unattributed)
const fmsgs = ftot.supervision.msgs + ftot.development.msgs + ftot.unattributed.msgs
console.log(`  TOTAL       ${String(fmsgs).padStart(5)}   $${f2(supUsd).padStart(8)}  $${f2(devUsd).padStart(8)}  $${f2(unattrUsd).padStart(8)}   $${f2(supUsd + devUsd + unattrUsd).padStart(8)}`)
console.log('')
console.log('LOCAL (mission ledger; real = measured tokenStats, est = per-turn fallback):')
console.log('  campaign  missions(real/est)   turns  toolCalls   hours   elec$    real API$    est API$')
const ltot = emptyBucket()
const rows = [...campaigns.entries()].sort()
rows.push(['other', otherMissions])
for (const [name, b] of rows) {
  if (b.missions === 0) continue
  const elec = b.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
  console.log(`  ${name.padEnd(9)} ${String(b.missions).padStart(4)} (${b.realMissions}/${b.estMissions})       ${fmt(b.turns).padStart(6)}  ${fmt(b.toolCalls).padStart(9)}  ${f2(b.hours).padStart(6)}  $${f2(elec).padStart(5)}   $${f2(realUsd(b)).padStart(8)}   $${f2(estUsd(b)).padStart(8)}`)
  for (const k of Object.keys(ltot)) ltot[k] += b[k]
}
const elecTot = ltot.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
console.log(`  TOTAL     ${String(ltot.missions).padStart(4)} (${ltot.realMissions}/${ltot.estMissions})       ${fmt(ltot.turns).padStart(6)}  ${fmt(ltot.toolCalls).padStart(9)}  ${f2(ltot.hours).padStart(6)}  $${f2(elecTot).padStart(5)}   $${f2(realUsd(ltot)).padStart(8)}   $${f2(estUsd(ltot)).padStart(8)}`)
if (ltot.unmeasuredTurns > 0) {
  console.log(`  note: ${fmt(ltot.unmeasuredTurns)} turns inside measured missions had no server timings; they are priced in the est column.`)
}
console.log('')
const counterReal = realUsd(ltot)
const counterEst = estUsd(ltot)
console.log(`VERDICT: frontier spent $${f2(supUsd)} SUPERVISING (development $${f2(devUsd)} and`)
console.log(`unattributed $${f2(unattrUsd)} are excluded — building LocalCode is not oversight).`)
console.log(`The supervised generation would have cost ~$${f2(counterReal + counterEst)} on the API`)
console.log(`($${f2(counterReal)} priced from measured tokens, $${f2(counterEst)} still estimated)`)
console.log(`and ran locally for ~$${f2(elecTot)} of power.`)
if (counterReal + counterEst > 0) {
  console.log(`supervision ratio: $1 of frontier verify oversees ~$${f2((counterReal + counterEst) / Math.max(supUsd, 0.01))} of displaced generation.`)
}
