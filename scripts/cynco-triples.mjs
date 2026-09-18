// scripts/cynco-triples.mjs — the Level 4 spine's dataset: (input, decision,
// outcome) at three recursion levels, joined by missionId and wave.
//
//   denial   — an invariant denied a call; outcome = what the next call was
//   ideation — the advisory S4 seat proposed; outcome = followed × landed
//   wave     — the campaign dispatched a wave; outcome = the verdict
//
// Derived, never authoritative: the ledger shards and ~/.cynco/campaigns/*/
// are the sources. Regenerated in full at every wave verdict.
//
//   bun scripts/cynco-triples.mjs [--out PATH] [--json]
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cyncoHome } from '../engine/paths.js'
import { readLedger } from './cynco-ledger-shards.mjs'

/** What each denial asked the next call to be. `revert` asks only "not that". */
export const DESIRED = { 'edit-gap': ['sourceEdit', 'commit'], 'commit-gap': ['commit'] }
const LOOKS = new Set(['inspect', 'read', 'codeIndex', 'denied-or-error', 'pending'])

export function complied(invariant, nextCallClass) {
  if (nextCallClass === null || nextCallClass === undefined || nextCallClass === 'pending') return false
  if (invariant === 'revert') return nextCallClass !== 'revert'
  return (DESIRED[invariant] ?? []).includes(nextCallClass)
}

export function changed(nextCallClass) {
  if (nextCallClass === null || nextCallClass === undefined) return false
  return !LOOKS.has(nextCallClass)
}

const rec = (invariant, nextCallClass) => ({ complied: complied(invariant, nextCallClass), changed: changed(nextCallClass) })

/** One record per denial (window) or per (invariant, nextCallClass) (aggregate). */
export function denialRecords(row, { campaign, wave }) {
  const inv = row?.invariants
  if (!inv) return []
  const base = { kind: 'denial', campaign: campaign ?? null, wave: wave ?? null, missionId: row.missionId }
  const total = inv.denialCount ?? inv.denials?.length ?? 0
  const window = inv.denials ?? []
  if (window.length >= total || !inv.nextCallClassByInvariant) {
    return window.map(d => ({ ...base, invariant: d.invariant, tool: d.tool ?? null, callIndex: d.callIndex ?? null, nextCallClass: d.nextCallClass ?? null, count: 1, ...rec(d.invariant, d.nextCallClass), source: 'window' }))
  }
  const out = []
  for (const [invariant, classes] of Object.entries(inv.nextCallClassByInvariant)) {
    for (const [nextCallClass, count] of Object.entries(classes)) {
      out.push({ ...base, invariant, tool: null, callIndex: null, nextCallClass, count, ...rec(invariant, nextCallClass), source: 'aggregate' })
    }
  }
  return out
}

function invariantsSummary(inv) {
  if (!inv) return null
  const total = inv.denialCount ?? inv.denials?.length ?? 0
  return {
    caps: inv.caps ?? null, denialCount: total, denialsByInvariant: inv.denialsByInvariant ?? null,
    revertRefusals: inv.revertRefusals ?? 0, codeIndexAssisted: inv.codeIndexAssisted ?? 0,
    terminalRelents: inv.terminalRelents ?? [], windowTruncated: (inv.denials?.length ?? 0) < total,
  }
}

const KINDS = ['edit-gap', 'commit-gap', 'revert']
const emptyDenials = () => Object.fromEntries(KINDS.map(k => [k, { denials: 0, complied: 0, changed: 0 }]))
const emptyQuiet = () => Object.fromEntries(KINDS.map(k => [k, { calls: 0, complied: 0 }]))

export function buildTriples({ rows, campaigns }) {
  const byMission = new Map(rows.map(r => [r.missionId, r]))
  const records = []
  const summary = { generatedAt: new Date().toISOString(), counts: { denial: 0, ideation: 0, wave: 0 }, campaigns: {}, denials: emptyDenials(), quiet: emptyQuiet() }
  const seen = new Set()

  const addDenials = (row, ctx) => {
    for (const d of denialRecords(row, ctx)) {
      records.push(d)
      summary.counts.denial += 1
      const s = summary.denials[d.invariant] ?? (summary.denials[d.invariant] = { denials: 0, complied: 0, changed: 0 })
      s.denials += d.count; if (d.complied) s.complied += d.count; if (d.changed) s.changed += d.count
    }
    // Ruling 4: the quiet-call base rate, per mission.
    const inv = row.invariants
    if (!inv) return
    const total = row.toolStats?.total ?? 0
    const denialCount = inv.denialCount ?? inv.denials?.length ?? 0
    const calls = Math.max(0, total - denialCount)
    const compliedOf = (k) => denialRecords(row, ctx).filter(d => d.invariant === k && d.complied).reduce((a, d) => a + d.count, 0)
    const edits = row.toolStats?.byClass?.sourceEdit ?? 0, commits = row.toolStats?.commits ?? 0
    summary.quiet['edit-gap'].calls += calls; summary.quiet['edit-gap'].complied += Math.max(0, edits + commits - compliedOf('edit-gap'))
    summary.quiet['commit-gap'].calls += calls; summary.quiet['commit-gap'].complied += Math.max(0, commits - compliedOf('commit-gap'))
    summary.quiet.revert.calls += calls; summary.quiet.revert.complied += calls
  }

  for (const c of campaigns ?? []) {
    const cs = { waves: 0, ideated: 0, followedLanded: { a: 0, b: 0, c: 0, d: 0 } }
    summary.campaigns[c.id] = cs
    let before = (c.state?.calibration?.baseFails ?? []).map(f => f.id)
    for (const w of c.waves ?? []) {
      const row = w.missionId ? byMission.get(w.missionId) ?? null : null
      const failsAfter = w.gate?.fails ? w.gate.fails.map(f => f.id) : null
      const landed = typeof w.outcome?.landed === 'boolean' ? w.outcome.landed : null
      const verified = w.verified === undefined ? (row?.verified ?? null) : w.verified
      records.push({
        kind: 'wave', campaign: c.id, wave: w.wave, missionId: w.missionId ?? null, decision: w.decision?.kind ?? null,
        failsBefore: before, failsAfter, linesFixed: failsAfter ? before.filter(id => !failsAfter.includes(id)).length : null,
        commits: row?.toolStats?.commits ?? null, hours: row ? row.durationS / 3600 : null, exitReason: w.outcome?.exitReason ?? row?.exitReason ?? null,
        landed, verified,
        sweep: w.sweep ? { killed: w.sweep.killed, total: w.sweep.total, survived: w.sweep.survived ?? [] } : null, sweepFault: w.sweepFault ?? null,
        posiwid: w.posiwid ?? null, invariants: invariantsSummary(row?.invariants), posiwidLive: row?.posiwidLive ?? null, identityGuard: row?.identityGuard ?? null,
      })
      summary.counts.wave += 1; cs.waves += 1
      if (w.s4?.ideation) {
        records.push({
          kind: 'ideation', campaign: c.id, wave: w.wave, missionId: w.missionId ?? null, authority: w.s4.authority ?? 0, commander: w.s4.commander ?? 'generator',
          hypotheses: w.s4.ideation.hypotheses?.length ?? 0, followed: w.s4.followed ?? null, landed, verified, decision: w.decision?.kind ?? null,
          order: w.s4.ideation.order ?? [], workOrderApplied: w.s4.workOrder?.applied ?? false,
        })
        summary.counts.ideation += 1; cs.ideated += 1
        if (typeof w.s4.followed === 'boolean' && typeof landed === 'boolean') {
          const key = w.s4.followed ? (landed ? 'a' : 'b') : (landed ? 'c' : 'd'); cs.followedLanded[key] += 1
        }
      }
      if (row) { addDenials(row, { campaign: c.id, wave: w.wave }); seen.add(row.missionId) }
      if (failsAfter) before = failsAfter
    }
  }
  for (const row of rows) if (row.invariants && !seen.has(row.missionId)) addDenials(row, { campaign: null, wave: null })
  const order = { denial: 0, ideation: 1, wave: 2 }
  records.sort((x, y) => order[x.kind] - order[y.kind])
  return { records, summary }
}

export function readCampaigns(dir = join(cyncoHome(), 'campaigns')) {
  if (!existsSync(dir)) return []
  const out = []
  for (const id of readdirSync(dir)) {
    const statePath = join(dir, id, 'state.json'), wavesPath = join(dir, id, 'waves.jsonl')
    if (!existsSync(statePath)) continue
    let state; try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { continue }
    const waves = existsSync(wavesPath)
      ? readFileSync(wavesPath, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
      : []
    out.push({ id, state, waves })
  }
  return out
}

export function exportTriples({ rows = readLedger(), campaigns = readCampaigns(), outPath = join(cyncoHome(), 'datasets', 'triples.jsonl') } = {}) {
  const { records, summary } = buildTriples({ rows, campaigns })
  mkdirSync(resolve(outPath, '..'), { recursive: true })
  const summaryPath = outPath.replace(/\.jsonl$/, '') + '.summary.json'
  const write = (p, text) => { writeFileSync(p + '.tmp', text, 'utf8'); renameSync(p + '.tmp', p) }
  write(outPath, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
  write(summaryPath, JSON.stringify(summary, null, 2))
  return { outPath, summaryPath, summary, records }
}

function main(argv) {
  const outIdx = argv.indexOf('--out')
  const r = exportTriples(outIdx === -1 ? {} : { outPath: resolve(argv[outIdx + 1]) })
  if (argv.includes('--json')) { console.log(JSON.stringify(r.summary, null, 2)); return 0 }
  const c = r.summary.counts
  console.log(`triples: ${c.denial} denial, ${c.ideation} ideation, ${c.wave} wave record(s) → ${r.outPath}`)
  for (const [id, s] of Object.entries(r.summary.campaigns)) console.log(`  ${id}: ${s.waves} wave(s), ${s.ideated} ideated, followed×landed a=${s.followedLanded.a} b=${s.followedLanded.b} c=${s.followedLanded.c} d=${s.followedLanded.d}`)
  for (const [k, s] of Object.entries(r.summary.denials)) console.log(`  ${k}: ${s.denials} denial(s), ${s.complied} complied, ${s.changed} changed the next call`)
  return 0
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) process.exit(main(process.argv.slice(2)))
