// scripts/cynco-campaign-verdict.mjs
import { spawnSync } from 'node:child_process'

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

export function verdictEntry({ spec, wave, row, grade, decision, ideationRecord, economicsLines }) {
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
  lines.push(`- **Sealed gate at ${grade.sha}: ${grade.gate.terminator ?? 'NO TERMINATOR'}${grade.gate.failCount != null ? ` (${grade.gate.failCount} fails)` : ''}${grade.gate.harnessFault ? ` — HARNESS FAULT: ${grade.gate.harnessFault}` : ''}.** ${grade.gate.priorRegressions != null ? `Prior-campaign regressions: ${grade.gate.priorRegressions}.` : ''}`)
  for (const f of grade.gate.fails) lines.push(`  - \`${f.line}\``)
  if (grade.gate.passes.length) lines.push(`  - PASS: ${grade.gate.passes.map(p => p.id).join(', ')}`)
  lines.push(`- Suite gate ${grade.suite.harnessFault ? `REFUSED (${grade.suite.harnessFault})` : grade.suite.exit === 0 ? 'PASS' : 'FAIL'}: REGRESSED ${grade.suite.regressions.length}${grade.suite.regressions.length ? ` (${grade.suite.regressions.join(', ')})` : ''}, REPAIRED ${grade.suite.repairs.length}.`)
  lines.push(grade.sweep ? `- Derived sweep ${grade.sweep.killed}/${grade.sweep.total}; survivors: ${grade.sweep.survived.length ? grade.sweep.survived.join(', ') : 'none'}.` : '- Derived sweep: UNMEASURED (no diff or the sweep refused).')
  lines.push(`- POSIWID ${grade.posiwid.verdict} (divergence ${grade.posiwid.divergence.toFixed(3)}, dominant ${grade.posiwid.dominantObserved}).`)
  if (ideationRecord) lines.push(`- S4 ideation (authority ${ideationRecord.authority}): ${ideationRecord.hypotheses.length} hypothesis/es; followed=${ideationRecord.followed}.`)
  lines.push(`- Ledger: verified ${grade.verified === null ? 'null (harness fault)' : grade.verified}; mutationSweep ${grade.sweep ? 'recorded (derived)' : 'null'}.`)
  lines.push('')
  if (economicsLines?.length) { lines.push(`Economics after this wave: ${economicsLines.join(' ')}`); lines.push('') }
  // invariantsRejected overrides decision.kind loudly — the runner is expected
  // to pass decision.kind === 'fault' in that case anyway, but the verdict
  // label must never depend on that being wired correctly upstream.
  const label = rejected ? '**STOP (fault)**' : decision.kind === 'pass' ? '**CAMPAIGN PASS**' : decision.kind === 'next' ? '**MISS**' : `**STOP (${decision.kind})**`
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

const defaultGit = (repoRoot) => (args) => { const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }); return { status: r.status, stdout: r.stdout ?? '' } }

export function commitVerdict({ repoRoot, branch, files, message, io }) {
  const git = io?.git ?? defaultGit(repoRoot)
  const status = git(['status', '--porcelain']).stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim())
  const foreign = status.filter(p => !files.includes(p) && !p.startsWith('benchmark/cynco-ledger/'))
  if (foreign.length) throw new Error(`working tree has changes outside the verdict files: ${foreign.join(', ')} — refusing to commit over someone's work`)
  if (git(['rev-parse', '--verify', branch]).status !== 0) git(['checkout', '-b', branch])
  else git(['checkout', branch])
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
