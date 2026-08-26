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
 *     a `usage` block with real token counts. Summed per calendar day so
 *     campaign windows can be carved out by date.
 *
 *   LOCAL — the mission ledger (benchmark/cynco-ledger/missions.*.jsonl):
 *     per-mission turns, tool calls, wall-clock duration, grouped by campaign
 *     (missionId prefix c1-/c2-/c3-/c4-/c5-). The ledger does not yet record
 *     local token counts (gap noted in task #31); the counterfactual below is
 *     therefore stated per-turn with the assumption printed, never silently.
 *
 * Usage: node scripts/supervision-economics.mjs [--since YYYY-MM-DD]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---- assumptions, printed with every report ------------------------------
// Opus API list prices, USD per million tokens (2026-08).
const PRICE = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }
// Counterfactual: what one local generation turn would have cost on the
// frontier API. A mission turn is one model response: prompt ~context-sized
// (mostly cache-read on the API) + output. Deliberately conservative.
const COUNTERFACTUAL = { outputPerTurn: 700, cacheReadPerTurn: 40000, freshInputPerTurn: 1500 }
// Local marginal cost: the 5090 box under mission load.
const LOCAL = { watts: 600, usdPerKwh: 0.15 }

const TRANSCRIPT_DIR = join(homedir(), '.claude', 'projects', 'C--Users-civer-localcode')
const LEDGER_DIR = 'benchmark/cynco-ledger'

const since = (() => {
  const i = process.argv.indexOf('--since')
  return i >= 0 ? process.argv[i + 1] : null
})()

// ---- frontier side -------------------------------------------------------
const byDay = new Map() // day -> {input, output, cacheWrite, cacheRead, msgs}
for (const f of readdirSync(TRANSCRIPT_DIR).filter(f => f.endsWith('.jsonl'))) {
  const lines = readFileSync(join(TRANSCRIPT_DIR, f), 'utf-8').split('\n')
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    const u = d?.message?.usage
    if (!u || typeof u.output_tokens !== 'number') continue
    const day = (d.timestamp ?? '').slice(0, 10)
    if (!day) continue
    const t = byDay.get(day) ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 }
    t.input += u.input_tokens ?? 0
    t.output += u.output_tokens ?? 0
    t.cacheWrite += u.cache_creation_input_tokens ?? 0
    t.cacheRead += u.cache_read_input_tokens ?? 0
    t.msgs += 1
    byDay.set(day, t)
  }
}

const usd = t =>
  (t.input * PRICE.input + t.output * PRICE.output +
   t.cacheWrite * PRICE.cacheWrite + t.cacheRead * PRICE.cacheRead) / 1e6

// ---- local side ----------------------------------------------------------
const campaigns = new Map() // 'c1' -> {missions, turns, toolCalls, hours}
const otherMissions = { missions: 0, turns: 0, toolCalls: 0, hours: 0 }
for (const f of readdirSync(LEDGER_DIR).filter(f => /^missions\..*\.jsonl$/.test(f))) {
  for (const line of readFileSync(join(LEDGER_DIR, f), 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (since && (r.dispatchedAt ?? '') < since) continue
    const m = /^(c\d)-/.exec(r.missionId ?? '')
    const bucket = m ? (campaigns.get(m[1]) ?? { missions: 0, turns: 0, toolCalls: 0, hours: 0 }) : otherMissions
    bucket.missions += 1
    bucket.turns += Array.isArray(r.turns) ? r.turns.length : 0
    bucket.toolCalls += r.toolStats?.total ?? 0
    bucket.hours += (r.durationS ?? 0) / 3600
    if (m) campaigns.set(m[1], bucket)
  }
}

// ---- report --------------------------------------------------------------
const f2 = n => n.toFixed(2)
const fmt = n => n.toLocaleString('en-US')

console.log('SUPERVISION ECONOMICS — frontier (verify) vs local (generate)')
console.log(`assumptions: API $/MTok in=${PRICE.input} out=${PRICE.output} cacheW=${PRICE.cacheWrite} cacheR=${PRICE.cacheRead};`)
console.log(`  counterfactual/turn: out=${COUNTERFACTUAL.outputPerTurn} cacheRead=${COUNTERFACTUAL.cacheReadPerTurn} freshIn=${COUNTERFACTUAL.freshInputPerTurn};`)
console.log(`  local power ${LOCAL.watts}W @ $${LOCAL.usdPerKwh}/kWh${since ? `; window since ${since}` : ''}`)
console.log('')
console.log('FRONTIER (Claude Code sessions, real usage):')
console.log('  day         msgs      output    cacheWrite     cacheRead       USD')
let ftot = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 }
for (const day of [...byDay.keys()].sort()) {
  if (since && day < since) continue
  const t = byDay.get(day)
  console.log(`  ${day}  ${String(t.msgs).padStart(5)}  ${fmt(t.output).padStart(10)}  ${fmt(t.cacheWrite).padStart(12)}  ${fmt(t.cacheRead).padStart(12)}  $${f2(usd(t)).padStart(8)}`)
  for (const k of Object.keys(ftot)) ftot[k] += t[k]
}
console.log(`  TOTAL       ${String(ftot.msgs).padStart(5)}  ${fmt(ftot.output).padStart(10)}  ${fmt(ftot.cacheWrite).padStart(12)}  ${fmt(ftot.cacheRead).padStart(12)}  $${f2(usd(ftot)).padStart(8)}`)
console.log('')
console.log('LOCAL (mission ledger):')
console.log('  campaign  missions   turns  toolCalls   hours   elec$   counterfactual API$')
let ltot = { missions: 0, turns: 0, toolCalls: 0, hours: 0 }
const cfUsd = b => (b.turns * (COUNTERFACTUAL.outputPerTurn * PRICE.output +
  COUNTERFACTUAL.cacheReadPerTurn * PRICE.cacheRead +
  COUNTERFACTUAL.freshInputPerTurn * PRICE.input)) / 1e6
const rows = [...campaigns.entries()].sort()
rows.push(['other', otherMissions])
for (const [name, b] of rows) {
  if (b.missions === 0) continue
  const elec = b.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
  console.log(`  ${name.padEnd(9)} ${String(b.missions).padStart(7)}  ${fmt(b.turns).padStart(6)}  ${fmt(b.toolCalls).padStart(9)}  ${f2(b.hours).padStart(6)}  $${f2(elec).padStart(5)}  $${f2(cfUsd(b)).padStart(8)}`)
  for (const k of Object.keys(ltot)) ltot[k] += b[k]
}
const elecTot = ltot.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
console.log(`  TOTAL     ${String(ltot.missions).padStart(7)}  ${fmt(ltot.turns).padStart(6)}  ${fmt(ltot.toolCalls).padStart(9)}  ${f2(ltot.hours).padStart(6)}  $${f2(elecTot).padStart(5)}  $${f2(cfUsd(ltot)).padStart(8)}`)
console.log('')
const frontierUsd = usd(ftot)
const counterfactual = cfUsd(ltot)
console.log(`VERDICT: frontier spent $${f2(frontierUsd)} supervising; the supervised generation`)
console.log(`would have cost ~$${f2(counterfactual)} on the API and ran locally for ~$${f2(elecTot)} of power.`)
if (counterfactual > 0) {
  console.log(`supervision ratio: $1 of frontier verify oversees ~$${f2(counterfactual / Math.max(frontierUsd, 0.01))} of displaced generation.`)
}
