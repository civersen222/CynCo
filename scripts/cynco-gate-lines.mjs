// scripts/cynco-gate-lines.mjs — the evidence layer of the gate-author seat.
//
//   bun scripts/cynco-gate-lines.mjs [--out PATH] [--json]
//   node scripts/cynco-signal-validation.mjs --gate-lines      # the table
//
// THE EVIDENCE UNIT IS THE GRADED GATE LINE, not the campaign.
//
// A campaign is one draw. "CynCo authored c9 and c9 passed" is a sample of
// one, and at one campaign every two months the seat would earn authority
// somewhere around 2030. A gate LINE is a falsifiable claim — "the resolution
// list is drawn, pressed at its centre, and the next draw is that size" — and
// one campaign ships nine to seventeen of them. So the question this module
// answers is asked of the line:
//
//     did the line the author sealed survive the campaign it was written for,
//     or did somebody have to move it?
//
//   held      — the campaign reached a decision and nothing rewrote the line.
//   resealed  — the line's text changed (or it appeared, or it vanished) after
//               the calibration that sealed it. The bar moved under the run.
//   open      — the campaign has not reached a decision yet. Not evidence.
//
// `resealed` is the failure mode this exists to catch: a gate whose author can
// quietly rewrite it mid-campaign is not a bar, and a "pass" against a rewritten
// line proves nothing about the line that was sealed. So the reseal is recorded
// by the RUNNER at CALIBRATE time (scripts/cynco-campaign.mjs), from the
// calibration it is about to overwrite, and it is recorded whether or not
// anybody wanted it recorded.
//
// Derived, never authoritative: `~/.cynco/campaigns/*/` and the history file
// are the sources, and the dataset is regenerated in full at every verdict.
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cyncoHome } from '../engine/paths.js'
import { readCampaigns } from './cynco-triples.mjs'
import { wilson, fisherExact } from './cynco-signal-validation.mjs'

/**
 * `<cyncoHome>/datasets/gate-lines.jsonl`.
 *
 * A function, not a bare constant: `cyncoHome()` reads `CYNCO_HOME` on every
 * call (engine/paths.ts is deliberately the only seam), and a module-level
 * constant would freeze the path at import time — which is exactly when a test
 * has not yet pointed `CYNCO_HOME` at its temp directory.
 */
export const GATE_LINES_PATH = (home = cyncoHome()) => join(home, 'datasets', 'gate-lines.jsonl')

/** Campaigns that ran before the runner existed, transcribed by hand. */
export const HISTORY_PATH = 'docs/civkings-redesign-briefs/gate-lines.history.json'

/**
 * A campaign is DECIDED when its last wave record carries a decision the
 * campaign does not come back from: the bar was cleared (`pass`,
 * `pass-with-survivors`), the budget ran out (`budget`), or the loop stopped
 * for want of progress (`no-progress`). `fault` and `stop` are refusals to
 * measure, not readings, and `next` is a campaign still running — a line under
 * any of those is `open`.
 */
export const DECIDED_KINDS = ['pass', 'pass-with-survivors', 'budget', 'no-progress']

/** Every graded line the calibration saw, as `{ id: printedText }`. */
export function linesOf(calibration) {
  const out = {}
  for (const f of calibration?.baseFails ?? []) out[f.id] = f.line
  for (const p of calibration?.basePasses ?? []) out[p.id] = p.line
  return out
}

/**
 * One reseal: what the gate graded before, what it grades now, and which line
 * ids are not the same claim any more (added, removed, or reworded).
 *
 * The line text is compared, not just the id set, because the id is a label and
 * the TEXT is the claim: `C9.1a.modes-listed: FAIL modes=[]` becoming
 * `C9.1a.modes-listed: FAIL modes drawn=[] pressed=[]` is a different bar under
 * the same name.
 *
 * That comparison OVER-MARKS: a FAIL line's detail is printed from the run, so
 * a line whose detail quotes a count (`modes=[]` → `modes=['1080p']`) reads as
 * changed when the assertion behind it did not move. The error is deliberately
 * in that direction — an over-marked line is counted against the author, never
 * for them, so the reading can only understate how well a seat is doing.
 *
 * Only the shas cross into the record. The full line text of every campaign,
 * kept twice per reseal, would make `state.json` grow without bound and would
 * put the sealed gate's own wording into a file the authoring mission can read.
 */
export function resealRecord({ at, wave, from, to }) {
  const before = from?.lines ?? {}, after = to?.lines ?? {}
  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  const changedLineIds = [...ids].filter(id => before[id] !== after[id]).sort()
  return { at, wave, from: { gateSha256: from?.gateSha256 ?? null }, to: { gateSha256: to?.gateSha256 ?? null }, changedLineIds }
}

/**
 * The first wave whose `gate.passes` carried the id, or null.
 *
 * A wave record with no `wave` number answers `null` rather than a falsy 0:
 * a faulted or hand-written record can reach here without one, and 0 is a wave
 * index nothing ever had — "the line passed at wave 0" would be a fact this
 * dataset invented.
 */
function firstPassWave(waves, id) {
  for (const w of waves ?? []) {
    if ((w?.gate?.passes ?? []).some(p => (p?.id ?? p) === id)) return typeof w.wave === 'number' ? w.wave : null
  }
  return null
}

/** Is this campaign's last wave record a decision it does not come back from? */
export function decidedOf(waves) {
  const last = (waves ?? []).filter(Boolean).at(-1)
  return Boolean(last && DECIDED_KINDS.includes(last.decision?.kind))
}

/**
 * One row per (campaign, graded line).
 *
 * `states` are runner campaigns (`{ id, author, sealedAt, decided, calibration,
 * reseals, waves }`); `history` is the hand-transcribed record of the campaigns that ran
 * before the runner did. A campaign present in both is taken from the runner
 * state and skipped in the history — counting it twice would double its lines
 * in the denominator the promotion is decided on.
 */
export function gateLineRows({ states = [], history = null } = {}) {
  const rows = []
  const fromState = new Set()
  for (const st of states) {
    const lines = linesOf(st?.calibration)
    const ids = Object.keys(lines)
    if (ids.length === 0) continue
    fromState.add(st.id)
    // The FIRST reseal that touched a line is the one that answers "when did
    // the bar move"; a line reworded twice moved at the first rewrite.
    const resealedAt = new Map()
    for (const r of st.reseals ?? []) {
      for (const id of r?.changedLineIds ?? []) if (!resealedAt.has(id)) resealedAt.set(id, r.wave ?? null)
    }
    for (const id of ids) {
      const resealed = resealedAt.has(id)
      rows.push({
        campaign: st.id, author: st.author ?? 'human', sealedAt: st.sealedAt ?? null, lineId: id,
        outcome: resealed ? 'resealed' : st.decided ? 'held' : 'open',
        resealedAtWave: resealed ? resealedAt.get(id) : null,
        firstPassWave: firstPassWave(st.waves, id),
        decided: Boolean(st.decided), source: 'runner',
      })
    }
  }
  for (const c of history?.campaigns ?? []) {
    if (fromState.has(c?.id)) { console.error(`[gate-lines] ${c.id} is in the history file and in the campaign state dir — the state dir wins, the history entry is skipped`); continue }
    const resealed = new Set(c?.resealed ?? [])
    for (const id of c?.lineIds ?? []) {
      rows.push({
        campaign: c.id, author: c.author ?? 'human', sealedAt: c.sealedAt ?? null, lineId: id,
        outcome: resealed.has(id) ? 'resealed' : c.decided ? 'held' : 'open',
        resealedAtWave: null, firstPassWave: null, decided: Boolean(c.decided), source: 'history',
      })
    }
  }
  return rows
}

/**
 * The two held-rates and the 2×2 that compares them.
 *
 * TERMINAL ROWS ONLY. An `open` line is a campaign still running: counting it
 * as a miss would punish an author for a campaign nobody has finished reading,
 * and counting it as held would let an unfinished campaign earn authority.
 */
export function summarize(rows) {
  const terminal = (rows ?? []).filter(r => r.outcome === 'held' || r.outcome === 'resealed')
  const block = (author) => {
    const mine = terminal.filter(r => r.author === author)
    const held = mine.filter(r => r.outcome === 'held').length
    return { n: mine.length, held, rate: mine.length ? held / mine.length : null, ci: wilson(held, mine.length) }
  }
  const cynco = block('cynco'), human = block('human')
  const table = [[cynco.held, cynco.n - cynco.held], [human.held, human.n - human.held]]
  return { byAuthor: { cynco, human }, fisher: { p: fisherExact(table[0][0], table[0][1], table[1][0], table[1][1]), table } }
}

function readHistory(historyPath) {
  if (!historyPath || !existsSync(historyPath)) return null
  try { return JSON.parse(readFileSync(historyPath, 'utf8')) }
  catch (e) { console.error(`[gate-lines] ${historyPath} is unreadable, no history counted — ${e.message}`); return null }
}

/**
 * Who wrote this campaign's gate.
 *
 * The wave record is the authority (`gate.author`, written from the loaded
 * spec at every grading); a campaign whose waves predate that field falls back
 * to its own authoring record, which exists exactly when the gate-author seat
 * staged and sealed the campaign. Neither present means a human wrote it — the
 * default the spec loader itself applies.
 */
function authorOf(state, waves, id) {
  for (const w of [...(waves ?? [])].reverse()) if (w?.gate?.author) return w.gate.author
  return state?.authoring?.[id]?.sealedAt ? 'cynco' : 'human'
}

/**
 * When this campaign's gate was sealed.
 *
 * The authoring record's `sealedAt` is the exact stamp, and only a
 * CynCo-authored campaign has one: a human seals by writing the triple into
 * `~/.cynco/heldout/<family>/<id>` by hand, and nothing records the moment. For
 * those, the campaign's own first calibration IS the seal date — the calibration
 * is the first thing that ever ran against the sealed triple, so it dates the
 * seal to within one invocation. Both are ISO strings; a campaign with neither
 * (nothing calibrated yet) is null.
 */
function sealedAtOf(state, id) {
  return state?.authoring?.[id]?.sealedAt ?? state?.calibration?.calibratedAt ?? null
}

/**
 * Regenerate the dataset: every campaign state dir plus the history file.
 * Returns the rows and the summary the verdict entry and the promotion read.
 */
export function exportGateLines({ campaignsDir = join(cyncoHome(), 'campaigns'), historyPath = HISTORY_PATH, outPath = GATE_LINES_PATH() } = {}) {
  const states = readCampaigns(campaignsDir).map(({ id, state, waves }) => ({
    id, author: authorOf(state, waves, id), sealedAt: sealedAtOf(state, id), decided: decidedOf(waves),
    calibration: state?.calibration ?? null, reseals: state?.reseals ?? [], waves,
  }))
  const rows = gateLineRows({ states, history: readHistory(historyPath) })
  const summary = summarize(rows)
  mkdirSync(resolve(outPath, '..'), { recursive: true })
  // tmp + rename, the way the triples exporter writes: a reader that opens the
  // dataset mid-write must see the previous one whole, never half of this one.
  writeFileSync(outPath + '.tmp', rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  renameSync(outPath + '.tmp', outPath)
  return { rows, summary, outPath }
}

// ── Gate outcomes: the campaign-level record of the seal ─────────────────────
//
// The line dataset above cannot see a gate that never sealed: a triple the
// supervisor refused has no calibration on the campaign, so it has no graded
// lines, so it contributes no row — and "the seat's gates held 30/30" reads the
// same whether zero or five gates were refused on the way. The SEAL is a
// campaign-level event, so this is one row per campaign:
//
//   refused   — at least one supervisor refusal and no seal (yet).
//   sealed    — sealed; the campaign has not reached a decision.
//   held      — sealed; decided; never resealed.
//   resealed  — sealed; at least one reseal record, decided or not. Any record
//               counts, even one whose `changedLineIds` is empty: the gate file
//               was rewritten under a running campaign, which is the event.
//
// A gate neither sealed nor refused (staged, still being authored) is not an
// outcome yet and has no row.

/** `<cyncoHome>/datasets/gate-outcomes.jsonl` — a function for the reason `GATE_LINES_PATH` is. */
export const GATE_OUTCOMES_PATH = (home = cyncoHome()) => join(home, 'datasets', 'gate-outcomes.jsonl')

/**
 * One row per campaign: `{ campaign, author, outcome, refusals, attempts, sealedAt }`.
 *
 * `states` are `{ id, author, sealedAt, decided, refusals: [], attempts, reseals: [] }`
 * (exportGateOutcomes builds them from the state dirs); `history` is the same
 * hand-transcribed file the line rows read, where an entry is sealed by
 * definition (it ran) and resealed when its `resealed` list is non-empty. A
 * campaign in both is the runner's — the collision is already logged by
 * `gateLineRows`, which reads the same two sources at the same verdict.
 */
export function gateOutcomeRows({ states = [], history = null } = {}) {
  const rows = []
  const fromState = new Set()
  for (const st of states) {
    if (!st?.id) continue
    fromState.add(st.id)
    const refusals = Array.isArray(st.refusals) ? st.refusals.length : 0
    const sealed = Boolean(st.sealedAt)
    let outcome
    if (!sealed) outcome = refusals > 0 ? 'refused' : null
    else outcome = (st.reseals ?? []).length > 0 ? 'resealed' : st.decided ? 'held' : 'sealed'
    if (!outcome) continue
    rows.push({ campaign: st.id, author: st.author ?? 'human', outcome, refusals, attempts: st.attempts ?? null, sealedAt: st.sealedAt ?? null })
  }
  for (const c of history?.campaigns ?? []) {
    if (!c?.id || fromState.has(c.id)) continue
    const outcome = (c.resealed ?? []).length > 0 ? 'resealed' : c.decided ? 'held' : 'sealed'
    rows.push({ campaign: c.id, author: c.author ?? 'human', outcome, refusals: 0, attempts: null, sealedAt: c.sealedAt ?? null })
  }
  return rows
}

/**
 * Who authored this campaign's gate, for the outcome row. The wave record wins
 * when there is one; otherwise the PRESENCE of an authoring record is the
 * answer — a refused gate never sealed, so `authorOf`'s `sealedAt` test would
 * call the seat's refusal a human's.
 */
function outcomeAuthorOf(state, waves, id) {
  for (const w of [...(waves ?? [])].reverse()) if (w?.gate?.author) return w.gate.author
  return state?.authoring?.[id] ? 'cynco' : 'human'
}

/** Regenerate the gate-outcomes dataset from every campaign state dir plus the history file. */
export function exportGateOutcomes({ campaignsDir = join(cyncoHome(), 'campaigns'), historyPath = HISTORY_PATH, outPath = GATE_OUTCOMES_PATH() } = {}) {
  const states = readCampaigns(campaignsDir).map(({ id, state, waves }) => {
    const a = state?.authoring?.[id]
    return {
      id, author: outcomeAuthorOf(state, waves, id), sealedAt: sealedAtOf(state, id), decided: decidedOf(waves),
      refusals: Array.isArray(a?.refusals) ? a.refusals : [], attempts: a?.attempts ?? null, reseals: state?.reseals ?? [],
    }
  })
  const rows = gateOutcomeRows({ states, history: readHistory(historyPath) })
  mkdirSync(resolve(outPath, '..'), { recursive: true })
  writeFileSync(outPath + '.tmp', rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  renameSync(outPath + '.tmp', outPath)
  return { rows, outPath }
}

function main(argv) {
  const outIdx = argv.indexOf('--out')
  const r = exportGateLines(outIdx === -1 ? {} : { outPath: resolve(argv[outIdx + 1]) })
  if (argv.includes('--json')) { console.log(JSON.stringify(r.summary, null, 2)); return 0 }
  const { cynco, human } = r.summary.byAuthor
  console.log(`gate lines: ${r.rows.length} row(s) → ${r.outPath}`)
  console.log(`  cynco ${cynco.held}/${cynco.n} held; human ${human.held}/${human.n} held; Fisher p ${r.summary.fisher.p.toFixed(3)}`)
  return 0
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) process.exit(main(process.argv.slice(2)))
