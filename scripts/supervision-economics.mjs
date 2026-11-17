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
 *     a supervised repo) or development (engine, tui, dashboard, benchmark
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
 * THE FRONTIER SIDE IS NOT A RUNNING TOTAL (F239, 2026-11-17). It is the sum
 * over the transcripts that are on disk when the script runs. Claude Code
 * removes old session files, and a session run in a git worktree is written to
 * a folder of its own. Until this date the script read one folder and compared
 * whatever was left in it with the WHOLE ledger: the campaign log's supervising
 * spend fell from $4,295.55 to $2,995.57 between two waves for that reason and
 * no other. So the script now reads the repo's worktree folders too, prints
 * what each side covers, and computes the VERDICT over the days both sides can
 * still be read. When no mission falls on such a day it says so and prints no
 * dollar figure, which the campaign scoreboard reads as "unmeasured".
 *
 * Usage: node scripts/supervision-economics.mjs [--since YYYY-MM-DD]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

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

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
/** Claude Code's folder name for the main checkout this instrument has always read. */
const PROJECT_SLUG = 'C--Users-civer-localcode'
const LEDGER_DIR = 'benchmark/cynco-ledger'
/** Where campaign specs (`<id>.campaign.json`, each naming its `repo`) are kept in this repository. */
const SPEC_ROOT = 'docs'

// ---- which transcripts ---------------------------------------------------

/**
 * The transcript folders of this repository: its own, and one per git worktree a
 * session ran in (Claude Code names those `<slug>--claude-worktrees-<name>`).
 * Sorted, the main folder first. A folder that is not there is not listed.
 */
export function transcriptFolders(projectsRoot, slug, ls = readdirSync) {
  let names
  try { names = ls(projectsRoot) } catch { return [] }
  const mine = names.filter(n => n === slug || n.startsWith(`${slug}--claude-worktrees-`))
  return mine.sort((a, b) => (a === slug ? -1 : b === slug ? 1 : a.localeCompare(b))).map(n => join(projectsRoot, n))
}

// ---- frontier classifier -------------------------------------------------

const fwd = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The repositories CynCo has been dispatched into or has a campaign for: every
 * ledger row's `cwd` and every campaign spec's `repo`. A tool call that touches
 * one of them is supervision. Until 2026-11-17 the classifier named one path,
 * the CivKings checkout, so a campaign in any other repository was invisible.
 *
 * `selfRoot` (this repository, as an absolute path) is never a supervised root,
 * whatever a row says: a mission that ran inside it would otherwise turn all
 * development into supervision. Compared without regard to case or slash
 * direction, and as text: the paths in a ledger are Windows paths whatever
 * machine reads them, so nothing here asks the platform to resolve one.
 */
export function supervisedRoots({ rows = [], specRepos = [], selfRoot }) {
  const self = fwd(selfRoot).toLowerCase()
  const seen = new Map()
  for (const raw of [...rows.map(r => r?.cwd), ...specRepos]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const root = fwd(raw)
    const key = root.toLowerCase()
    if (key === self || key.startsWith(`${self}/`) || self.startsWith(`${key}/`)) continue
    if (!seen.has(key)) seen.set(key, root)
  }
  return [...seen.values()].sort()
}

/** A path as a pattern that finds it in a JSON-encoded tool input, where a Windows separator is two backslashes. */
export function rootPattern(root) {
  const parts = fwd(root).split('/').filter(Boolean).map(escapeRe)
  // Not followed by more of a name: `.../casino` is not `.../casinofloor`.
  return new RegExp(parts.join('[\\\\/]+') + '(?![\\w.-])', 'i')
}

// Deterministic, tool-target based. Supervision is checked FIRST: editing
// cynco-ledger.mjs is supervision tooling even though it is also code.
const SUPERVISION_BASE = [
  /civkings-redesign/i,                       // briefs, spec, plan, campaign docs
  /[\\/]\.cynco[\\/]+(heldout|staging|sessions|rewards)/i, // gates, staged assets, mission transcripts
  /gate_[cs]\d|perturb_[cs]\d/i,              // sealed gates + calibration probes
  /dispatch-mission|dispatch_[cs]?\d|driver_[cs]?\d/i, // dispatch script + run logs
  /cynco-mission-driver|cynco-ledger|cynco-mutation-sweep|cynco-ledger-sweep/i,
  /supervision-economics/i,
  /campaign-log|cynco-failure-log/i,
  /missions\.\d+\.jsonl/i,                    // ledger data files
]
const DEVELOPMENT = [
  /[\\/]engine[\\/]|\bengine[\\/]/i,
  /[\\/]tui[\\/]|\btui[\\/]/i,
  /dashboard/i,
  /[\\/]benchmark[\\/]|\bbenchmark[\\/]/i,    // ledger data already caught above
  /\bbun (test|run)\b|vitest|npx tsc/i,
  /[\\/]memory[\\/]MEMORY|[\\/]memory[\\/].*\.md/i,
  /[\\/]scripts[\\/]|\bscripts[\\/]/i,        // non-cynco scripts (cynco ones caught above)
  /[\\/]docs[\\/]|\bdocs[\\/]/i,              // non-campaign docs (redesign docs caught above)
]

/** The classifier for a set of supervised roots: `classifyText` and `classifyMessage`. */
export function classifierFor(roots = []) {
  const supervision = [...SUPERVISION_BASE, ...roots.map(rootPattern)]
  const classifyText = (s) => {
    for (const p of supervision) if (p.test(s)) return 'supervision'
    for (const p of DEVELOPMENT) if (p.test(s)) return 'development'
    return null
  }
  /** Class of one assistant message from its tool_use blocks, or null. */
  const classifyMessage = (content) => {
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
  return { classifyText, classifyMessage }
}

// ---- frontier side -------------------------------------------------------
const emptyUsage = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 })

/**
 * Usage per day and class over the transcripts in `folders`, and what was read:
 * how many transcripts, in how many folders, and the first and last day a
 * message carries. `io` is the file seam (`ls`, `read`).
 */
export function readFrontier(folders, classifyMessage, io = { ls: readdirSync, read: (p) => readFileSync(p, 'utf-8') }) {
  const byDay = new Map() // day -> {supervision, development, unattributed} of emptyUsage()
  const coverage = { folders: 0, transcripts: 0, firstDay: null, lastDay: null }
  for (const dir of folders) {
    let files
    try { files = io.ls(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
    if (files.length === 0) continue
    coverage.folders += 1
    for (const f of files) {
      coverage.transcripts += 1
      let context = null // running class within this session file
      for (const line of io.read(join(dir, f)).split('\n')) {
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
        if (coverage.firstDay === null || day < coverage.firstDay) coverage.firstDay = day
        if (coverage.lastDay === null || day > coverage.lastDay) coverage.lastDay = day
        const bucket = cls ?? context ?? 'unattributed'
        const t = byDay.get(day) ?? { supervision: emptyUsage(), development: emptyUsage(), unattributed: emptyUsage() }
        const b = t[bucket]
        b.input += u.input_tokens ?? 0
        b.output += u.output_tokens ?? 0
        b.cacheWrite += u.cache_creation_input_tokens ?? 0
        b.cacheRead += u.cache_read_input_tokens ?? 0
        b.msgs += 1
        byDay.set(day, t)
      }
    }
  }
  return { byDay, coverage }
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

/**
 * The campaign a ledger row belongs to: its `campaignId`, or for rows written
 * before that field the id its mission id starts with (`c10-wave2-…` is `c10`),
 * or null. The old `^(c\d)-` read `c10` and `c11` as no campaign at all.
 */
export function campaignOf(row) {
  if (typeof row?.campaignId === 'string' && row.campaignId !== '') return row.campaignId
  const m = /^([a-z]+\d+[a-z]?)-wave\d/i.exec(row?.missionId ?? '')
  return m ? m[1].toLowerCase() : null
}

/**
 * The ledger's rows: every `missions.NNNN.jsonl` shard under `dir`.
 *
 * NOT `missions.jsonl`, the frozen first shard (records 1 to 193, dispatched before
 * 2026-08-15, before the first campaign). This script has skipped it since its first
 * version (2026-08-26), so every figure it has printed is over the later shards. That is
 * kept, because changing what an instrument counts changes every number read from it;
 * the report names the shard it leaves out. Whether it should be counted is the owner's.
 */
export const LEDGER_SHARD = /^missions\..*\.jsonl$/
export function readLedger(dir, io = { ls: readdirSync, read: (p) => readFileSync(p, 'utf-8') }) {
  const rows = []
  let files
  try { files = io.ls(dir).filter(f => LEDGER_SHARD.test(f)) } catch { return rows }
  for (const f of files) {
    for (const line of io.read(join(dir, f)).split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* a torn line is not a mission */ }
    }
  }
  return rows
}

const dayOf = r => String(r?.dispatchedAt ?? '').slice(0, 10)

/** Buckets per campaign (and `other`) over the rows dispatched on or after `fromDay` (all of them when null). */
export function localSide(rows, fromDay = null) {
  const campaigns = new Map()
  const other = emptyBucket()
  let firstDay = null, lastDay = null
  for (const r of rows) {
    const day = dayOf(r)
    if (fromDay && day < fromDay) continue
    if (day) {
      if (firstDay === null || day < firstDay) firstDay = day
      if (lastDay === null || day > lastDay) lastDay = day
    }
    const id = campaignOf(r)
    const bucket = id ? (campaigns.get(id) ?? emptyBucket()) : other
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
    if (id) campaigns.set(id, bucket)
  }
  const total = emptyBucket()
  for (const b of [...campaigns.values(), other]) for (const k of Object.keys(total)) total[k] += b[k]
  return { campaigns, other, total, firstDay, lastDay }
}

// Real counterfactual: measured tokens at API rates.
const realUsd = b =>
  (b.decodeTokens * PRICE.output + b.cachedTokens * PRICE.cacheRead +
   b.prefillTokens * PRICE.input) / 1e6
// Fallback estimate for unmeasured turns.
const estUsd = b => (b.estTurns * (EST_PER_TURN.outputPerTurn * PRICE.output +
  EST_PER_TURN.cacheReadPerTurn * PRICE.cacheRead +
  EST_PER_TURN.freshInputPerTurn * PRICE.input)) / 1e6

// ---- the window both sides can be read over ------------------------------

/**
 * The first day the verdict may count from: the later of `--since` and the
 * first day a transcript still on disk carries. Before that day the frontier
 * side cannot be read, so a mission dispatched before it has no supervision to
 * be compared with. `from` is null when there is no transcript at all.
 */
export function verdictWindow({ since = null, frontierFirstDay = null }) {
  if (frontierFirstDay === null) return { from: null, why: 'no Claude Code transcript of this repository is on disk' }
  if (since && since >= frontierFirstDay) return { from: since, why: `asked for with --since ${since}` }
  return { from: frontierFirstDay, why: `the first day a transcript still on disk carries${since ? ` (later than --since ${since})` : ''}` }
}

// ---- report --------------------------------------------------------------
const f2 = n => n.toFixed(2)
const fmt = n => n.toLocaleString('en-US')

/**
 * The VERDICT section, as lines. The campaign runner copies these into every
 * wave's verdict and the scoreboard reads the `$N SUPERVISING` figure out of
 * them, so: the first line starts with `VERDICT:`, and a verdict that cannot
 * be computed carries NO dollar figure next to that word.
 */
export function verdictLines({ window, coverage, ledger, inWindow, frontierTotals, supervisionToLastMission = null }) {
  const range = (a, b) => (a === null ? 'none' : a === b ? a : `${a} to ${b}`)
  const covers = `transcripts on disk: ${range(coverage.firstDay, coverage.lastDay)}; ledger: ${range(ledger.firstDay, ledger.lastDay)}`
  if (window.from === null || inWindow.total.missions === 0) {
    return [
      `VERDICT: not computable. No mission in the ledger was dispatched on a day the frontier transcripts still cover (${covers}).`,
      'The spend that supervised those missions was in Claude Code transcripts that are no longer on disk, so there is',
      'nothing to set against the generation they oversaw. A figure printed before 2026-11-17 compared what was left',
      'on disk with the whole ledger and is not a measurement (F239).',
    ]
  }
  const supUsd = usd(frontierTotals.supervision)
  const devUsd = usd(frontierTotals.development)
  const unattrUsd = usd(frontierTotals.unattributed)
  const counterReal = realUsd(inWindow.total)
  const counterEst = estUsd(inWindow.total)
  const elec = inWindow.total.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
  const left = ledger.total.missions - inWindow.total.missions
  const lines = [
    `VERDICT: from ${window.from} on, frontier spent $${f2(supUsd)} SUPERVISING (development $${f2(devUsd)} and`,
    `unattributed $${f2(unattrUsd)} are excluded — building LocalCode is not oversight).`,
    `The supervised generation would have cost ~$${f2(counterReal + counterEst)} on the API`,
    `($${f2(counterReal)} priced from measured tokens, $${f2(counterEst)} still estimated)`,
    `and ran locally for ~$${f2(elec)} of power.`,
  ]
  if (counterReal + counterEst > 0) {
    lines.push(`supervision ratio: $1 of frontier verify oversees ~$${f2((counterReal + counterEst) / Math.max(supUsd, 0.01))} of displaced generation.`)
  }
  // The classifier files gate, harness and instrument work as supervision too, and that work goes
  // on after the last mission. Said in dollars, so the ratio above is read with it.
  if (supervisionToLastMission !== null && inWindow.lastDay !== null) {
    const upTo = usd(supervisionToLastMission)
    const after = supUsd - upTo
    if (after >= 0.005) {
      const onThoseDays = counterReal + counterEst > 0 && upTo >= 0.005 ? ` ($1 to ~$${f2((counterReal + counterEst) / upTo)} on those days alone)` : ''
      lines.push(`Of that supervising spend, $${f2(upTo)} came on or before ${inWindow.lastDay}, the day the last counted mission was dispatched${onThoseDays};`)
      lines.push(`the other $${f2(after)} came after it, with no mission to oversee: the classifier files gate, harness and instrument work as supervision too.`)
    }
  }
  lines.push(`This counts ${inWindow.total.missions} mission(s) dispatched from ${window.from} on (${window.why}); ${left} earlier one(s) are left out,`)
  lines.push('because the transcripts of the sessions that supervised them are no longer on disk. It is not a running total.')
  return lines
}

function specRepos(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.campaign.json')) {
        try { const repo = JSON.parse(readFileSync(p, 'utf-8')).repo; if (typeof repo === 'string') out.push(repo) } catch { /* a spec that does not parse names no repo */ }
      }
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

function main(argv) {
  const i = argv.indexOf('--since')
  const since = i >= 0 ? argv[i + 1] : null

  const rows = readLedger(LEDGER_DIR)
  const roots = supervisedRoots({ rows, specRepos: specRepos(SPEC_ROOT), selfRoot: resolve('.') })
  const folders = transcriptFolders(PROJECTS_ROOT, PROJECT_SLUG)
  const { byDay, coverage } = readFrontier(folders, classifierFor(roots).classifyMessage)
  const window = verdictWindow({ since, frontierFirstDay: coverage.firstDay })
  const ledger = localSide(rows, since)
  const inWindow = localSide(rows, window.from ?? '9999-99-99')

  console.log('SUPERVISION ECONOMICS — frontier (verify) vs local (generate)')
  console.log(`assumptions: API $/MTok in=${PRICE.input} out=${PRICE.output} cacheW=${PRICE.cacheWrite} cacheR=${PRICE.cacheRead};`)
  console.log('  local counterfactual: REAL rows price measured tokens (decode@out, cached@cacheR, prefill@in);')
  console.log(`  EST rows/turns use ${EST_PER_TURN.outputPerTurn} out + ${EST_PER_TURN.cacheReadPerTurn} cacheRead + ${EST_PER_TURN.freshInputPerTurn} freshIn per turn;`)
  console.log(`  local power ${LOCAL.watts}W @ $${LOCAL.usdPerKwh}/kWh${since ? `; window since ${since}` : ''}`)
  console.log('')
  console.log('COVERAGE (what each side can still be read for):')
  console.log(`  frontier: ${coverage.transcripts} transcript(s) in ${coverage.folders} folder(s) of ${folders.length} (the repository's own and its worktrees'),`
    + ` messages from ${coverage.firstDay ?? 'none'} to ${coverage.lastDay ?? 'none'}.`)
  console.log('            Claude Code removes old session transcripts, so this side is what is on disk today, not a running total.')
  console.log(`  local:    ${ledger.total.missions} mission(s) in the ledger${since ? ` since ${since}` : ''}, dispatched ${ledger.firstDay ?? 'none'} to ${ledger.lastDay ?? 'none'}.`)
  if (existsSync(join(LEDGER_DIR, 'missions.jsonl'))) {
    console.log('            missions.jsonl, the frozen first shard (records before 2026-08-15), is not counted: this script never has.')
  }
  console.log(`  supervised repositories (a tool call that touches one is supervision): ${roots.length ? roots.join(', ') : 'none known'}`)
  console.log('')
  console.log('FRONTIER (Claude Code sessions, real usage, classified by tool targets):')
  console.log('  day          msgs   supervise$   develop$   unattrib$      total$')
  const ftot = { supervision: emptyUsage(), development: emptyUsage(), unattributed: emptyUsage() }
  // The verdict's frontier side counts from the window's first day, like its local side.
  const fwin = { supervision: emptyUsage(), development: emptyUsage(), unattributed: emptyUsage() }
  // Supervision on the window's days up to the day the last counted mission was dispatched.
  const supToLast = emptyUsage()
  for (const day of [...byDay.keys()].sort()) {
    if (since && day < since) continue
    const t = byDay.get(day)
    const msgs = t.supervision.msgs + t.development.msgs + t.unattributed.msgs
    console.log(`  ${day}  ${String(msgs).padStart(5)}   $${f2(usd(t.supervision)).padStart(8)}  $${f2(usd(t.development)).padStart(8)}  $${f2(usd(t.unattributed)).padStart(8)}   $${f2(usd(t.supervision) + usd(t.development) + usd(t.unattributed)).padStart(8)}`)
    for (const k of Object.keys(ftot)) {
      for (const kk of Object.keys(ftot[k])) {
        ftot[k][kk] += t[k][kk]
        if (window.from !== null && day >= window.from) fwin[k][kk] += t[k][kk]
      }
    }
    if (window.from !== null && day >= window.from && inWindow.lastDay !== null && day <= inWindow.lastDay) {
      for (const kk of Object.keys(supToLast)) supToLast[kk] += t.supervision[kk]
    }
  }
  const fmsgs = ftot.supervision.msgs + ftot.development.msgs + ftot.unattributed.msgs
  console.log(`  TOTAL       ${String(fmsgs).padStart(5)}   $${f2(usd(ftot.supervision)).padStart(8)}  $${f2(usd(ftot.development)).padStart(8)}  $${f2(usd(ftot.unattributed)).padStart(8)}   $${f2(usd(ftot.supervision) + usd(ftot.development) + usd(ftot.unattributed)).padStart(8)}`)
  console.log('')
  console.log('LOCAL (mission ledger; real = measured tokenStats, est = per-turn fallback):')
  console.log('  campaign  missions(real/est)   turns  toolCalls   hours   elec$    real API$    est API$')
  const rowsOut = [...ledger.campaigns.entries()].sort()
  rowsOut.push(['other', ledger.other])
  for (const [name, b] of rowsOut) {
    if (b.missions === 0) continue
    const elec = b.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
    console.log(`  ${name.padEnd(9)} ${String(b.missions).padStart(4)} (${b.realMissions}/${b.estMissions})       ${fmt(b.turns).padStart(6)}  ${fmt(b.toolCalls).padStart(9)}  ${f2(b.hours).padStart(6)}  $${f2(elec).padStart(5)}   $${f2(realUsd(b)).padStart(8)}   $${f2(estUsd(b)).padStart(8)}`)
  }
  const ltot = ledger.total
  const elecTot = ltot.hours * LOCAL.watts / 1000 * LOCAL.usdPerKwh
  console.log(`  TOTAL     ${String(ltot.missions).padStart(4)} (${ltot.realMissions}/${ltot.estMissions})       ${fmt(ltot.turns).padStart(6)}  ${fmt(ltot.toolCalls).padStart(9)}  ${f2(ltot.hours).padStart(6)}  $${f2(elecTot).padStart(5)}   $${f2(realUsd(ltot)).padStart(8)}   $${f2(estUsd(ltot)).padStart(8)}`)
  if (ltot.unmeasuredTurns > 0) {
    console.log(`  note: ${fmt(ltot.unmeasuredTurns)} turns inside measured missions had no server timings; they are priced in the est column.`)
  }
  console.log('')
  for (const line of verdictLines({ window, coverage, ledger, inWindow, frontierTotals: fwin, supervisionToLastMission: supToLast })) console.log(line)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
}
