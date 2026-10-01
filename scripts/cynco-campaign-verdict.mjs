// scripts/cynco-campaign-verdict.mjs
import { spawnSync } from 'node:child_process'
import { gateLineVerdict } from './cynco-signal-validation.mjs'
import { autopoiesisLine } from './cynco-autopoiesis.mjs'
import { scoreboardLines } from './cynco-scoreboard.mjs'
import { progressLine } from './cynco-campaign-progress.mjs'

const today = () => new Date().toISOString().slice(0, 10)
const h = (s) => (s / 3600).toFixed(2)

// Mirrors cynco-brief.mjs's pacing() digest voice (scripts/cynco-brief.mjs:59-88):
// invariants.denials is a windowed snapshot (last 50, since plan 2's fix wave) —
// the true total lives in denialCount; fall back to the window's length only
// when a run predates that field.
function invariantsLine(inv) {
  if (!inv) return 'Invariants: none (engine without mission invariants).'
  const denyCount = inv.denialCount ?? inv.denials?.length ?? 0
  const byInvariant = inv.denialsByInvariant
    ? ` (${Object.entries(inv.denialsByInvariant).map(([k, v]) => `${k} ${v}`).join(', ')})`
    : ''
  const relents = inv.terminalRelents?.length
    ? ` The engine stopped enforcing ${inv.terminalRelents.join(', ')} after repeated relents.`
    : ''
  return `Invariants: engine denied ${denyCount} call(s)${byInvariant}, ${inv.revertRefusals ?? 0} revert refusal(s), ${inv.codeIndexAssisted ?? 0} CodeIndex-assisted Grep(s).${relents}`
}

// Phase 2b-ii verify-first routing (row.routing, from governance.status). null
// means the wave could not route at all — interactive, no invariants, or no
// KEEP-GREEN assertion — and the line is omitted rather than printing a row of
// zeroes that reads as "the router ran and did nothing".
//
// `count` is every route; `used` is how many KEEP-GREEN runs it actually paid
// for, which is the number that answers "did the budget bind". Cached and
// could-not-run routes are reported separately because they are different
// facts: a cached verdict IS an answer, a timeout is not.
function routingLine(routing) {
  if (!routing) return null
  const k = routing.byKind ?? {}
  const o = routing.byOutcome ?? {}
  const n = (v) => v ?? 0
  const cached = n(o['cached-passed']) + n(o['cached-failed'])
  const couldNotRun = n(o.timeout) + n(o.unrunnable) + n(o['budget-exhausted'])
  return `- Routing: ${n(routing.count)} verify-first (revert ${n(k.revert)}, low-confidence edit ${n(k['low-confidence-edit'])}): `
    + `passed ${n(o.passed)}, failed ${n(o.failed)}, cached ${cached}, could not run ${couldNotRun}`
    + ` (${n(routing.used)}/${n(routing.budget)} KEEP-GREEN runs spent).`
}

// Classifier/regulator agreement check: toolStats.bashByEffect (what each Bash
// call actually DID) must sum to toolStats.byName.Bash (how many Bash calls the
// classifier counted). A mismatch means the two disagree on what happened.
function bashByEffectLine(ts) {
  const be = ts?.bashByEffect
  if (!be) return null
  const sum = (be.read ?? 0) + (be.write ?? 0) + (be.run ?? 0) + (be.commit ?? 0) + (be.revert ?? 0) + (be.other ?? 0)
  const bashByName = ts.byName?.Bash ?? 0
  return `- Bash by effect: read ${be.read ?? 0}, write ${be.write ?? 0}, run ${be.run ?? 0}, commit ${be.commit ?? 0}, revert ${be.revert ?? 0}, other ${be.other ?? 0} (sum ${sum} vs byName.Bash ${bashByName} — ${sum === bashByName ? 'agree' : 'DISAGREE'}).`
}

// Phase 3: the gate-line reading, from scripts/cynco-gate-lines.mjs's summary.
// Both seats print, because the CynCo number means nothing on its own — the
// question is whether a CynCo-authored line holds as well as a human's, and a
// held rate with no comparison is a number looking for a story. `rate` is a
// dash rather than 0 when an author has no terminal line at all: no evidence
// is not a rate of zero.
function gateLinesLine(summary) {
  if (!summary?.byAuthor) return null
  const { cynco, human } = summary.byAuthor
  const rate = cynco.rate === null || cynco.rate === undefined ? '—' : cynco.rate.toFixed(3)
  // Numerator first — `26/30 held`, the way every other ratio in this entry
  // reads (`edit-gap 2/80 complied`, `Derived sweep 6/25`). n/held would print
  // `30/26` and be read as 26 of 30 by everyone who ever sees it.
  return `- Gate lines: cynco ${cynco.held}/${cynco.n} held (rate ${rate}, ci [${cynco.ci[0].toFixed(2)}, ${cynco.ci[1].toFixed(2)}]) vs human ${human.held}/${human.n}; ${gateLineVerdict(summary)}`
}

// Phase 4: the identity reading (scripts/cynco-identity.mjs). null means no
// reading was taken and the line is omitted — never printed as "intact".
function identityLine(identity) {
  if (!identity) return null
  return identity.intact ? '- Identity: intact' : `- Identity: VIOLATED ${identity.violated.join(' ')}`
}

// Phase 5 ruling 5: the outcome hindcast (scripts/cynco-hindcast.mjs) and the
// ladder's reading of each model row. The verdict is `ruleVerdictOf`'s string
// cut at its dash (`TOO FEW`, `NO EVIDENCE`, `PREDICTIVE`, …). Unmeasured
// reads null, never 0 (F16); a fault prints UNMEASURED with its reason, the
// way the scoreboard's does. null (no reading taken) is no line. The entry
// line carries the dropped-column COUNT only (28 names made it unreadable);
// `{ detail: true }` — the `--scoreboard` verb — names them.
//
// Phase 6 Task 4: `runners` (the ladder's `source: 'runner'` entries,
// `R1.no-progress`) are named with their verdict on this same ladder line,
// after the model rows, read the same way. The runner row does not depend on
// the hindcast, so a fault line carries it too.
export function hindcastLine(h, { detail = false, runners = null } = {}) {
  if (!h) return null
  const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'null')
  const num = (v, d) => (typeof v === 'number' ? v.toFixed(d) : 'null')
  const byId = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  const rung = ([id, r]) => {
    const ci = Array.isArray(r?.ci) && r.n > 0 ? ` [${Math.round(r.ci[0] * 100)}, ${Math.round(r.ci[1] * 100)}]` : ''
    // An UNMEASURED verdict keeps its reason (Task 4 review M2, F16: unmeasured
    // is null WITH its reason); every other verdict is cut at its dash.
    const full = String(r?.verdict ?? 'no verdict')
    const verdict = full.startsWith('UNMEASURED') ? full : full.split(' — ')[0]
    const note = typeof r?.note === 'string' && r.note ? ` (${r.note})` : ''
    return `${id} precision ${pct(r?.precision)}${ci} on ${r?.n ?? 0} fired p(Holm) ${num(r?.pAdjusted, 3)} ${verdict}${note}`
  }
  const runnerRungs = Object.entries(runners ?? {}).sort(byId).map(rung)
  if (h.fault) return `- Outcome hindcast: UNMEASURED — ${h.fault}${runnerRungs.map(r => `; ${r}`).join('')}`
  const models = Object.entries(h.ladder ?? {}).sort(byId).map(rung)
  // A model ladder that faulted still says so when the runner rows follow it.
  const ladder = [...(!models.length && h.ladderFault ? [`LADDER NOT WRITTEN (${h.ladderFault}) — rules rewritten alone`] : models), ...runnerRungs]
  const leak = h.leakCheck
    ? `leak check ${['gbt', 'lr'].filter(k => h.leakCheck[k]).map(k => `${k} AUC prefix ${num(h.leakCheck[k].aucPrefix, 2)} / hindsight ${num(h.leakCheck[k].aucHindsight, 2)}`).join(', ')}`
    : 'leak check not run'
  const length = h.lengthFeature ? `; LENGTH FEATURE ${h.lengthFeature} in the prefix` : ''
  const dropped = h.droppedFeatures?.length ? `; dropped ${h.droppedFeatures.length} dead column(s)${detail ? `: ${h.droppedFeatures.join(', ')}` : ''}` : ''
  const s = h.secondary
  const secondary = !s ? '' : s.refusal ? `; K = 32 ${s.refusal}`
    : `; K = ${s.prefixTurns ?? 32} gbt AUC ${num(s.models?.gbt?.auc, 2)}, lr AUC ${num(s.models?.lr?.auc, 2)}`
  // F165: the one signals version the model was fitted on, and every
  // version's eligible count — absent on a model written before F165.
  const counts = Object.entries(h.rowsByVersion ?? {}).sort(([a], [b]) => Number(a) - Number(b)).map(([k, n]) => `v${k} ${n}`)
  const signals = typeof h.signalsVersion === 'number' ? `, signals v${h.signalsVersion} only (eligible ${counts.join(', ') || 'none'})` : ''
  // Task 2 review N3: the one irreversible act — the automatic per-version
  // holdout freeze — is named on the wave whose export performed it.
  const frozeNow = h.holdout?.frozenNow === true ? `; v${h.signalsVersion ?? '?'} holdout frozen now (${h.holdout.ids ?? '?'} ids)` : ''
  return `- Outcome hindcast: v${h.version ?? '?'} at K = ${h.prefixTurns ?? '?'} turns${signals} on ${h.nHoldout ?? '?'} held-out missions (base ${pct(h.baseRate)}): `
    + `${ladder.length ? ladder.join('; ') : 'no ladder reading'}; ${leak}${length}${secondary}${dropped}${frozeNow}`
}

export function verdictEntry({ spec, wave, row, grade, decision, ideationRecord, economicsLines, denialAnalysis = null, denialScope = 'campaign', capProposal = null, governancePosiwid = null, gateLines = null, identity = null, autopoiesis = null, scoreboard = null, hindcast = null, progress = null, runnerLadder = null }) {
  const ts = row.toolStats ?? {}
  const inv = row.invariants
  const rejected = row.invariantsRejected === true
  const lines = []
  lines.push(`## ${spec.id.toUpperCase()} wave ${wave} — ${row.missionId} (graded ${today()}, BASE ${row.commitRange?.base ?? '?'} → HEAD ${grade.sha ?? '?'})`)
  lines.push('')
  lines.push(`- ${ts.total ?? '?'} tool calls, exitReason ${row.exitReason} (${row.durationS}s = ${h(row.durationS)}h), ${ts.commits ?? 0} commit(s). ` +
    `maxCallsWithoutSourceEdit ${ts.maxCallsWithoutSourceEdit ?? '?'}, maxCallsWithoutCommit ${ts.maxCallsWithoutCommit ?? '?'}. ` +
    `CodeIndex ${ts.byName?.CodeIndex ?? 0}/${ts.total ?? '?'}. graderProbes ${row.graderProbes?.probes ?? 0}/${row.graderProbes?.total ?? ts.total ?? '?'}. ` +
    invariantsLine(inv) +
    (rejected ? ' **INVARIANTS REJECTED — the wave ran without its orders.**' : ''))
  const beLine = bashByEffectLine(ts)
  if (beLine) lines.push(beLine)
  const rtLine = routingLine(row.routing)
  if (rtLine) lines.push(rtLine)
  lines.push(`- **Sealed gate at ${grade.sha}: ${grade.gate.terminator ?? 'NO TERMINATOR'}${grade.gate.failCount != null ? ` (${grade.gate.failCount} fails)` : ''}${grade.gate.harnessFault ? ` — HARNESS FAULT: ${grade.gate.harnessFault}` : ''}.** ${grade.gate.priorRegressions != null ? `Prior-campaign regressions: ${grade.gate.priorRegressions}.` : ''}`)
  for (const f of grade.gate.fails) lines.push(`  - \`${f.line}\``)
  if (grade.gate.passes.length) lines.push(`  - PASS: ${grade.gate.passes.map(p => p.id).join(', ')}`)
  lines.push(`- Suite gate ${grade.suite.harnessFault ? `REFUSED (${grade.suite.harnessFault})` : grade.suite.exit === 0 ? 'PASS' : 'FAIL'}: REGRESSED ${grade.suite.regressions.length}${grade.suite.regressions.length ? ` (${grade.suite.regressions.join(', ')})` : ''}, REPAIRED ${grade.suite.repairs.length}.`)
  lines.push(grade.sweep
    ? `- Derived sweep ${grade.sweep.killed}/${grade.sweep.total}${grade.sweep.kind === 'derived-full' ? ' (derived-full: refused on the diff, retried with --mutate over the wave\'s sources)' : ''}; survivors: ${grade.sweep.survived.length ? grade.sweep.survived.join(', ') : 'none'}.`
    : grade.sweepFault
      ? `- Derived sweep: UNMEASURED — ${grade.sweepFault}${grade.sweepWhy ? `: ${grade.sweepWhy}` : ''}${grade.sweepRetried ? (grade.sweepFault === 'sweep refused (exit 2)' ? ' (and again on the --mutate retry)' : ' (on the --mutate retry, after the diff sweep refused)') : ''}.`
      : '- Derived sweep: UNMEASURED (no diff or the sweep refused).')
  lines.push(`- POSIWID ${grade.posiwid.verdict} (divergence ${grade.posiwid.divergence.toFixed(3)}, dominant ${grade.posiwid.dominantObserved}).`)
  if (governancePosiwid) {
    const { verdict, divergence, dominantObserved, support, onsetWave } = governancePosiwid
    lines.push(`- Governance POSIWID ${verdict} (divergence ${divergence.toFixed(3)}, dominant ${dominantObserved}, support ${support}${onsetWave ? `; drift onset wave ${onsetWave}` : ''}).`)
  }
  if (ideationRecord) lines.push(`- S4 ideation (authority ${ideationRecord.authority}): ${ideationRecord.hypotheses.length} hypothesis/es; followed=${ideationRecord.followed}.`)
  lines.push(`- Ledger: verified ${grade.verified === null ? 'null (harness fault)' : grade.verified}; mutationSweep ${grade.sweep ? `recorded (${grade.sweep.kind ?? 'derived'})` : 'null'}.`)
  const idLine = identityLine(identity)
  if (idLine) lines.push(idLine)
  // Phase 4 ruling 4: the campaign checklist (scripts/cynco-autopoiesis.mjs),
  // beside the identity reading its first criterion is.
  const apLine = autopoiesisLine(autopoiesis)
  if (apLine) lines.push(apLine)
  // Phase 6 ruling 2: the mid-wave gate readings and the shadow R1.no-progress
  // (scripts/cynco-campaign-progress.mjs), read off the wave record. No record
  // handed over, no line; a record without readings prints the reason.
  if (progress) lines.push(progressLine(progress))
  // Phase 5 ruling 2: the four headline numbers, campaign to date
  // (scripts/cynco-scoreboard.mjs). No board, no line.
  lines.push(...scoreboardLines(scoreboard))
  // Phase 5 ruling 5: the outcome hindcast, right after the board.
  // Phase 6 Task 4: the ladder's runner rows (R1.no-progress) ride on it.
  const hcLine = hindcastLine(hindcast, { runners: runnerLadder })
  if (hcLine) lines.push(hcLine)
  if (denialAnalysis?.invariants) {
    const pct = v => v === null ? '—' : (v * 100).toFixed(1) + '%'
    // The scope is part of the claim: a pooled reading is every run in the
    // ledger, not this campaign, and a verdict must not label it "campaign to
    // date" just because that reads better.
    const scope = denialScope === 'campaign' ? 'campaign to date' : 'all runs — no campaign block yet'
    lines.push(`- Denials (${scope}): ${denialAnalysis.invariants.map(r =>
      r.invariant === 'revert' || r.verdict === 'TOO FEW'
        ? `${r.invariant} ${r.complied}/${r.denials} (${r.verdict})`
        : `${r.invariant} ${r.complied}/${r.denials} complied (quiet rate ${pct(r.baseRate)}, ${r.verdict})`).join('; ')}.`)
  }
  const glLine = gateLinesLine(gateLines)
  if (glLine) lines.push(glLine)
  if (capProposal) {
    const cap = capProposal.name.slice('invariants/'.length)
    lines.push(`- **PROPOSAL ${capProposal.name} ${capProposal.currentValue ?? spec.invariants[cap]} → ${capProposal.newValue} (max ${capProposal.bounds.max}) — approve with --approve-proposal ${capProposal.name}.**`)
  }
  lines.push('')
  if (economicsLines?.length) { lines.push(`Economics after this wave: ${economicsLines.join(' ')}`); lines.push('') }
  // invariantsRejected overrides decision.kind loudly — the runner is expected
  // to pass decision.kind === 'fault' in that case anyway, but the verdict
  // label must never depend on that being wired correctly upstream.
  const label = rejected ? '**STOP (fault)**'
    : decision.kind === 'pass' ? '**CAMPAIGN PASS**'
      : decision.kind === 'pass-with-survivors' ? `**CAMPAIGN PASS (sweep survivors: ${decision.survivors?.length ?? 0})**`
        : decision.kind === 'next' ? '**MISS**' : `**STOP (${decision.kind})**`
  lines.push(`Verdict: ${label} — ${decision.why}`)
  return lines.join('\n') + '\n'
}

export async function notify(message, env = process.env, fetchImpl = globalThis.fetch) {
  const base = env.CYNCO_NTFY_URL
  if (!base) return false
  try {
    const r = await fetchImpl(`${base.replace(/\/$/, '')}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.CYNCO_NTFY_TOKEN ? { Authorization: `Bearer ${env.CYNCO_NTFY_TOKEN}` } : {}) },
      body: JSON.stringify({ topic: env.CYNCO_NTFY_ALERT_TOPIC ?? 'cynco-alerts', title: 'CynCo campaign', message, priority: 3 }),
      signal: AbortSignal.timeout(10000),
    })
    return Boolean(r.ok)
  } catch { return false }
}

const defaultGit = (repoRoot) => (args) => { const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } }

export function commitVerdict({ repoRoot, branch, files, message, io }) {
  const git = io?.git ?? defaultGit(repoRoot)
  const status = git(['status', '--porcelain']).stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim())
  const foreign = status.filter(p => !files.includes(p) && !p.startsWith('benchmark/cynco-ledger/'))
  if (foreign.length) throw new Error(`working tree has changes outside the verdict files: ${foreign.join(', ')} — refusing to commit over someone's work`)
  // A failed checkout used to be silent: `git add` and `git commit` ran anyway
  // and the verdict landed on whatever branch the tree happened to be on —
  // main, most likely. Fail loudly instead; the runner logs "commit skipped"
  // and the wave record keeps verdictSha null, which is the honest reading.
  const co = git(['rev-parse', '--verify', branch]).status !== 0 ? git(['checkout', '-b', branch]) : git(['checkout', branch])
  if (co.status !== 0) throw new Error(`commitVerdict: git checkout ${branch} failed: ${String(co.stderr ?? '').trim()}`)
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  if (head !== branch) throw new Error(`commitVerdict: git checkout ${branch} failed: HEAD is ${head || '(unknown)'}`)
  git(['add', ...files])
  git(['commit', '-m', message])
  return { sha: git(['rev-parse', 'HEAD']).stdout.trim() }
}

export function economicsLines(io = { run: (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout ?? '' }) {
  const out = io.run('node', ['scripts/supervision-economics.mjs'])
  const lines = out.split('\n')
  const i = lines.findIndex(l => l.startsWith('VERDICT:'))
  return i === -1 ? [] : lines.slice(i).map(l => l.trim()).filter(Boolean)
}
