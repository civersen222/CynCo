#!/usr/bin/env bun
// scripts/cynco-campaign.mjs — the campaign-level metasystem.
//
//   bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c8.campaign.json [--waves N] [--resume] [--dry-run] [--sync]
//                                  [--approve-proposal ideation/brief] [--reject-proposal ideation/brief]
//
// S2: salvage + no-progress stop.   S3: budgets + invariants handed to the wave.
// S3*: sealed gate, suite gate, sweep.   S4: brief (generator binds; ideation advises).
// S5: the campaign spec (identity, checked once per invocation).   Algedonic: ntfy.
//
// Runs under bun (it reaches into engine/*.ts through .js specifiers).
import { resolve, join, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cyncoHome } from '../engine/paths.js'
import { loadCampaignSpec, checkIdentity } from './cynco-campaign-spec.mjs'
import { CampaignState } from './cynco-campaign-state.mjs'
import { calibrate, defaultIo as calibrateIo } from './cynco-campaign-calibrate.mjs'
import { generateBrief, sidecarFor } from './cynco-brief.mjs'
import { gradeWave } from './cynco-campaign-grade.mjs'
import { verdictEntry, notify, commitVerdict, economicsLines } from './cynco-campaign-verdict.mjs'
import { runIdeation, measureFollowed, authorityRegistry, promotionProposal } from './cynco-ideation.mjs'
import { patchLedgerRow, findLedgerRow } from './cynco-ledger-patch.mjs'
import { sidecarPath } from './cynco-contract.mjs'

const BRIEFS_DIR = 'docs/civkings-redesign-briefs'
const LOG = `${BRIEFS_DIR}/campaign-log.md`
const ENGINE_URL = 'http://127.0.0.1:9161/'
const ENGINE_PROBE_TIMEOUT_MS = 3_000

/**
 * The stop rule, pure so it can be argued with in a test rather than in a log.
 *
 * Order matters and is not arbitrary:
 *   1. invariantsRejected — the engine refused the mission's invariants block,
 *      so whatever the wave did, it did NOT do it under the terms the campaign
 *      set. A green gate under rejected invariants measures a different
 *      experiment. It outranks `pass` deliberately.
 *   2. harness fault — `verified === null` means an instrument broke; the grade
 *      is not evidence either way.
 *   3. pass / no-progress / budget / next.
 */
export function decide({ grade, state, spec, commitsLanded, row }) {
  if (row?.invariantsRejected === true) return { kind: 'fault', why: 'the wave ran without its invariants (block rejected by the engine)' }
  if (grade.verified === null) return { kind: 'fault', why: grade.gate.harnessFault ?? grade.suite.harnessFault ?? 'harness fault' }
  const passed = grade.gate.terminator === 'PASS' && grade.suite.exit === 0 && (grade.sweep === null || grade.sweep.survived.length === 0)
  if (passed) return { kind: 'pass', why: `sealed gate PASS, suite gate PASS, ${grade.sweep ? `sweep ${grade.sweep.killed}/${grade.sweep.total} no survivors` : 'sweep unmeasured'}` }
  const ids = grade.gate.fails.map(f => f.id)
  const same = Array.isArray(state.lastFails) && ids.length === state.lastFails.length && ids.every((x, i) => x === state.lastFails[i])
  if (same && commitsLanded === 0 && (state.consecutiveNoProgress ?? 0) >= 1) return { kind: 'no-progress', why: `two consecutive waves with the same ${ids.length} FAIL line(s) and no commits` }
  if (state.waveCount >= spec.budget.waves) return { kind: 'budget', why: `${spec.budget.waves} wave(s) spent; ${ids.length} line(s) still FAIL` }
  return { kind: 'next', why: `${ids.length} line(s) still FAIL` }
}

const gitC = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout ?? ''
const repoRel = (abs) => relative(process.cwd(), abs).replace(/\\/g, '/')

export const defaultIo = {
  writeBrief: (path, text, sidecar) => { writeFileSync(path, text, 'utf8'); writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2) + '\n'); return path },
  dispatch: async ({ spec, briefFile, invariants, timeoutS, pidFile, driverLog }) => {
    const env = { ...process.env, LOCALCODE_MAX_ITERATIONS: String(spec.budget.iterations), CYNCO_BASH_TIMEOUT_MS: String(spec.budget.bashTimeoutMs),
      CYNCO_MISSION_INVARIANTS: JSON.stringify(invariants), DRIVER_PID_FILE: pidFile, DRIVER_LOG: driverLog, CYNCO_SKIP_IDLE_ENGINE: '1' }
    const r = spawnSync('bash', ['scripts/dispatch-mission.sh', briefFile, spec.marker, spec.repo, String(timeoutS), spec.keepGreen], { env, encoding: 'utf8', timeout: 900_000 })
    if (r.status !== 0) throw new Error(`dispatch failed (exit ${r.status}): ${(r.stdout + r.stderr).slice(-2000)}`)
    // dispatch-mission.sh prints the invariants it accepted and the driver log
    // and PID it started; captured output is invisible unless we re-emit it, and
    // those three lines are the only unattended evidence that the wave was given
    // its orders and that the PID we are about to wait on is the driver's.
    if (r.stdout) console.log(r.stdout.trimEnd())
    if (r.stderr?.trim()) console.log(r.stderr.trimEnd())
    // dispatch-mission.sh backgrounds the driver, so the missionId does not
    // exist yet: it is read out of the driver log by missionIdFrom once the
    // driver has written its ledger line.
    return { driverLog }
  },
  waitForDriver: async ({ pidFile, driverLog, timeoutMs }) => {
    const t0 = Date.now()
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    // A driver that is already gone on the FIRST probe did not run an
    // eight-hour mission in zero seconds — the PID handoff is broken, and
    // believing it faults a wave that is in fact still running and still
    // holding the GPU with nobody left to grade it. Say which of the two it is.
    if (!alive()) return { exited: false, pidUnseen: pid }
    while (Date.now() - t0 < timeoutMs) {
      if (!alive()) return { exited: true }
      // Never sleep past the wall clock: a 30 s poll on top of an expired
      // budget is 30 s of a wave nobody is waiting on any more.
      await new Promise(r => setTimeout(r, Math.min(30_000, Math.max(1, timeoutMs - (Date.now() - t0)))))
    }
    return { exited: false }
  },
  // cynco-mission-driver.mjs:837 — `[ledger] <outcome> record <id> appended (…) → <shard>`
  missionIdFrom: (driverLog) => /\[ledger\] \w+ record (\S+) appended/.exec(readFileSync(driverLog, 'utf8'))?.[1] ?? null,
  readRow: (missionId) => findLedgerRow(missionId),
  commitsBetween: (repo, base, head) => gitC(repo, ['log', '--oneline', `${base}..${head}`]).split('\n').filter(Boolean).map(l => ({ sha: l.slice(0, 7), subject: l.slice(8) })),
  firstCommitFiles: (repo, base, head) => { const first = gitC(repo, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean)[0]; return first ? gitC(repo, ['show', '--name-only', '--format=', first]).split('\n').filter(Boolean) : [] },
  // cynco-work-snapshot.mjs:35, called by the driver with outDir 'C:/tmp'.
  salvageOf: (missionId) => { const p = `C:/tmp/${missionId}.uncommitted.patch`; if (!existsSync(p)) return null; const files = [...readFileSync(p, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]); return files.length ? { patchPath: p, files } : null },
  // Ruling 7: the advisory occupant runs on the SAME GPU as the wave. A live
  // engine on 9161 (the dashboard, or a run someone else started) means the
  // card is taken — any answer, even a 404, proves something is listening.
  engineLive: async () => { try { await fetch(ENGINE_URL, { signal: AbortSignal.timeout(ENGINE_PROBE_TIMEOUT_MS) }); return true } catch { return false } },
  grade: (spec, row) => gradeWave(spec, row),
  ideate: (args) => runIdeation(args),
  patchRow: (missionId, fields) => patchLedgerRow(missionId, fields),
  commit: (args) => commitVerdict(args),
  notify: (t) => notify(t),
  economics: () => economicsLines(),
  appendLog: (text) => appendFileSync(LOG, '\n' + text),
}

/**
 * Everything the brief generator needs about where the campaign stands.
 * Shared by runWave and `--dry-run` so the dry run prints the brief the next
 * wave would actually receive, not an approximation of it.
 */
export function waveContext(spec, s, io = defaultIo) {
  const wave = s.waveCount + 1
  const base = s.lastBase ?? spec.base
  // NOT `wave === 1 ? calibration : lastGrade`: a faulted wave advances
  // waveCount without ever producing a grade, so wave 2 can legitimately have
  // no lastGrade. Falling back to the calibration keeps the campaign resumable
  // instead of bricking it with a TypeError on the next invocation.
  const fails = s.lastGrade?.gate.fails ?? s.calibration?.baseFails ?? []
  const passes = s.lastGrade?.gate.passes ?? s.calibration?.basePasses ?? []
  const prior = s.lastRow
    ? { missionId: s.lastRow.missionId, exitReason: s.lastRow.exitReason, durationS: s.lastRow.durationS, commits: s.lastCommits ?? [], toolStats: s.lastRow.toolStats, invariants: s.lastRow.invariants ?? null, verify: s.lastRow.verify, posiwid: s.lastGrade?.posiwid ?? null }
    : null
  const salvage = s.lastRow ? io.salvageOf(s.lastRow.missionId) : null
  return { wave, base, fails, passes, prior, salvage, ideation: null }
}

export async function runWave(spec, state, io = defaultIo) {
  const s = state.state
  const ctx = waveContext(spec, s, io)
  const { wave, base, fails, prior } = ctx
  const registry = authorityRegistry(s)
  const commander = registry.whoCommands('brief')?.component ?? 'generator'

  let ideation = null, ideationMeta = null
  let missionId, row, briefFile, dispatchedAt, waveFiles

  if (s.adoptedRow) {
    // ADOPT (scripts/cynco-campaign-adopt.mjs): this wave already RAN — it was
    // dispatched by hand, or by an invocation that died before grading — and
    // only its measurement is missing. Every step before GRADE is skipped on
    // purpose: DISPATCH would burn another wall clock on work already in the
    // repo, GENERATE would overwrite the brief the wave was actually given,
    // and ideation only exists to advise that brief.
    missionId = s.adoptedRow
    row = io.readRow(missionId)
    if (!row) throw new Error(`adopted row ${missionId} is not in the ledger — adopt a missionId that exists`)
    briefFile = resolve(row.briefFile ?? join(BRIEFS_DIR, `${spec.id}-wave${wave}.txt`))
    dispatchedAt = row.dispatchedAt ?? null
    delete s.adoptedRow
    // The brief was authored outside the runner, so its sidecar may not exist;
    // commitVerdict hands `files` straight to `git add`, where one missing
    // pathspec stages nothing at all.
    waveFiles = [repoRel(briefFile), repoRel(sidecarPath(briefFile))].filter(f => existsSync(f))
    console.log(`[campaign] ADOPT ${missionId} — grading a wave that already ran (brief ${repoRel(briefFile)}); GENERATE/DISPATCH/WAIT skipped`)
  } else {
    // S4, occupant B (advisory) — runs only while no engine holds the GPU.
    if (spec.ideation?.enabled) {
      const busy = await (io.engineLive ?? defaultIo.engineLive)()
      if (busy) {
        console.log('[campaign] ideation skipped — an engine is answering on 9161 and the wave must not share the GPU')
        ideationMeta = { taskPath: null, durationMs: 0, error: 'engine busy' }
      } else {
        const draft = generateBrief(spec, ctx)
        const r = await io.ideate({ spec, fails, prior, briefText: draft, stateDir: state.dir })
        ideation = r.ideation; ideationMeta = { taskPath: r.taskPath ?? null, durationMs: r.durationMs ?? null, error: r.error ?? null }
      }
    }

    // S4, occupant A (binding).
    const text = generateBrief(spec, { ...ctx, ideation })
    briefFile = resolve(BRIEFS_DIR, `${spec.id}-wave${wave}.txt`)
    io.writeBrief(briefFile, text, sidecarFor(spec))
    waveFiles = [repoRel(briefFile), repoRel(sidecarPath(briefFile))]

    // S3: dispatch with the terms.
    const stamp = basename(briefFile).replace(/\.[^.]*$/, '')
    const pidFile = `C:/tmp/driver_${stamp}.pid`, driverLog = `C:/tmp/driver_${stamp}.log`
    dispatchedAt = new Date().toISOString()
    const dispatched = await io.dispatch({ spec, briefFile, invariants: spec.invariants, timeoutS: spec.budget.hoursPerWave * 3600, pidFile, driverLog })
    const waited = await io.waitForDriver({ pidFile, driverLog, timeoutMs: (spec.budget.hoursPerWave * 3600 + 3600) * 1000 })
    missionId = waited.exited ? (dispatched?.missionId ?? io.missionIdFrom?.(driverLog) ?? null) : null
    row = missionId ? io.readRow(missionId) : null
    if (!row) {
      // Ruling 8: a wave that faulted still SPENT a wave. Counting it is what
      // stops a broken engine from burning the whole budget in a retry loop.
      const why = waited.exited ? 'driver exited without a ledger row'
        : waited.pidUnseen ? `driver pid ${waited.pidUnseen} was already invisible on the first probe — the PID handoff is broken and the mission may still be running unwatched (see ${driverLog})`
        : 'driver did not exit within the wall clock'
      const rec = { wave, missionId, briefFile, base, dispatchedAt, decision: { kind: 'fault', why } }
      rec.notified = await tryNotify(io, `${spec.id} wave ${wave}: FAULT — ${rec.decision.why}`)
      state.appendWave(rec)
      s.waveCount = wave
      if (!rec.notified) s.pendingNotifications.push(rec.decision)
      state.save()
      return rec
    }
  }

  // Everything past this point is measurement and bookkeeping on a run that
  // already happened. A throw here (a gate that dies, a ledger shard that will
  // not rewrite, ntfy blowing up) must not lose the wave: record the fault,
  // spend the wave, and hand the decision back so the loop stops deliberately
  // rather than by exception.
  try {
  // S3*: grade.
  const grade = await io.grade(spec, row)
  const commits = io.commitsBetween(spec.repo, row.commitRange?.base ?? base, row.commitRange?.head ?? base)
  const followed = ideation ? measureFollowed(ideation, io.firstCommitFiles?.(spec.repo, row.commitRange?.base, row.commitRange?.head) ?? []) : null
  // decide() reads waveCount as "waves spent INCLUDING this one" — the state's
  // own counter is only advanced after the record is appended, so hand decide
  // the count this wave makes rather than the one before it.
  const decision = decide({ grade, state: { ...s, waveCount: wave }, spec, commitsLanded: commits.length, row })
  io.patchRow(missionId, { verified: grade.verified, ...(grade.sweep ? { mutationSweep: grade.sweep } : {}),
    gate: { sha: grade.sha, terminator: grade.gate.terminator, fails: grade.gate.fails.map(f => f.line), passes: grade.gate.passes.length, priorRegressions: grade.gate.priorRegressions, suiteRegressions: grade.suite.regressions, harnessFault: grade.gate.harnessFault ?? grade.suite.harnessFault ?? null },
    posiwid: { divergence: grade.posiwid.divergence, verdict: grade.posiwid.verdict, dominantObserved: grade.posiwid.dominantObserved } })

  // Verdict (campaign log, economics, local commit, algedonic).
  const ideationRecord = ideation ? { authority: s.ideationAuthority ?? 0, hypotheses: ideation.hypotheses, followed } : null
  const entry = verdictEntry({ spec, wave, row, grade, decision, ideationRecord, economicsLines: io.economics() })
  io.appendLog(entry)
  // Ruling 5: commitVerdict matches these against `git status --porcelain`,
  // which speaks repo-relative forward slashes and nothing else.
  const files = [LOG, ...waveFiles, ...ledgerShardsTouched()]
  let verdictSha = null
  try { verdictSha = io.commit({ repoRoot: '.', branch: `campaign/${spec.id}`, files, message: `${spec.id.toUpperCase()} wave ${wave} verdict: ${decision.kind} — ${decision.why}` }).sha } catch (e) { console.error(`[campaign] commit skipped: ${e.message}`) }
  const notified = await tryNotify(io, `${spec.id.toUpperCase()} wave ${wave}: ${decision.kind.toUpperCase()} — ${decision.why}\n${grade.gate.fails.map(f => f.line).join('\n')}`)

  const rec = { wave, missionId, briefFile, base, head: grade.sha, dispatchedAt, gradedAt: new Date().toISOString(), gate: grade.gate, suite: grade.suite, sweep: grade.sweep, sweepFault: grade.sweepFault ?? null, posiwid: grade.posiwid, verified: grade.verified,
    outcome: { landed: row.outcome === 'landed', exitReason: row.exitReason },
    s4: { generatorInput: { failIds: fails.map(f => f.id), priorMissionId: prior?.missionId ?? null }, ideation, ideationMeta, authority: s.ideationAuthority ?? 0, commander, followed },
    decision, verdictSha, notified }
  state.appendWave(rec)
  const sameFails = Array.isArray(s.lastFails) && grade.gate.fails.map(f => f.id).join() === s.lastFails.join()
  s.consecutiveNoProgress = sameFails && commits.length === 0 ? (s.consecutiveNoProgress ?? 0) + 1 : 0
  s.waveCount = wave; s.lastBase = grade.sha ?? base; s.lastFails = grade.gate.fails.map(f => f.id); s.lastGrade = grade; s.lastRow = row; s.lastCommits = commits
  if (!notified) s.pendingNotifications.push(rec.decision)
  const proposal = promotionProposal(state.waves(), s.ideationAuthority ?? 0)
  if (proposal && !s.proposals.some(p => p.status === 'pending')) { s.proposals.push({ ...proposal, proposedAt: new Date().toISOString() }); await tryNotify(io, `${spec.id}: PROPOSAL ${proposal.name} ${s.ideationAuthority ?? 0} → ${proposal.newValue} (max ${proposal.bounds.max}, p=${proposal.evidence.p.toFixed(3)}). Approve with --approve-proposal ${proposal.name}`) }
  state.save()
  return rec
  } catch (e) {
    console.error(`[campaign] wave ${wave} post-run step failed: ${e?.stack ?? e}`)
    const why = `post-run step failed: ${e?.message ?? e}`
    const notified = await tryNotify(io, `${spec.id} wave ${wave}: FAULT — ${why}`)
    const rec = { wave, missionId, briefFile, base, dispatchedAt, decision: { kind: 'fault', why }, notified }
    state.appendWave(rec)
    s.waveCount = wave
    if (!notified) s.pendingNotifications.push(rec.decision)
    state.save()
    return rec
  }
}

// notify is the last thing standing between a fault and silence; a throw from
// it must never be the reason the wave record goes unwritten.
const tryNotify = async (io, message) => {
  try { return Boolean(await io.notify(message)) } catch (e) { console.error(`[campaign] notify failed: ${e?.message ?? e}`); return false }
}

function ledgerShardsTouched() {
  const out = spawnSync('git', ['status', '--porcelain', 'benchmark/cynco-ledger'], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').filter(Boolean).map(l => l.slice(3).trim())
}

/** Has the campaign already spent every wave it was budgeted? */
export function budgetSpent(state, spec) {
  return (state.state.waveCount ?? 0) >= spec.budget.waves
}

export async function main(argv) {
  // Every path below reaches for a repo-relative path (scripts/, docs/,
  // benchmark/cynco-ledger/). Run from anywhere else and the first symptom is
  // a brief written into the wrong tree, not an error.
  if (!existsSync('scripts/dispatch-mission.sh')) { console.error('[campaign] run from the localcode repo root'); return 2 }
  const specPath = argv.find(a => a.endsWith('.campaign.json'))
  if (!specPath) { console.error('usage: bun scripts/cynco-campaign.mjs <id>.campaign.json [--waves N] [--resume] [--dry-run] [--sync] [--approve-proposal NAME] [--reject-proposal NAME]'); return 2 }
  const spec = loadCampaignSpec(specPath)
  const identity = checkIdentity(spec)
  if (!identity.ok) { console.error('[campaign] IDENTITY VIOLATION:\n  ' + identity.problems.join('\n  ')); return 2 }
  const state = new CampaignState(join(cyncoHome(), 'campaigns', spec.id)).load()
  const flag = (n) => argv.indexOf(n)
  // --resume is the default and always has been: the state directory IS the
  // resume point. The flag is accepted so an operator can say so out loud.
  if (flag('--approve-proposal') !== -1 || flag('--reject-proposal') !== -1) {
    const approve = flag('--approve-proposal') !== -1; const name = argv[(approve ? flag('--approve-proposal') : flag('--reject-proposal')) + 1]
    const p = state.state.proposals.find(x => x.name === name && x.status === 'pending'); if (!p) { console.error(`no pending proposal ${name}`); return 2 }
    p.status = approve ? 'approved' : 'rejected'; p.decidedAt = new Date().toISOString()
    if (approve && p.name === 'ideation/brief') state.state.ideationAuthority = Math.min(p.newValue, p.bounds.max)
    state.save(); console.log(`[campaign] proposal ${name} ${p.status}`); return 0
  }
  if (flag('--sync') !== -1) return sync(spec, state)
  if (flag('--waves') !== -1) {
    const n = Number(argv[flag('--waves') + 1])
    if (!Number.isInteger(n) || n <= 0) { console.error('[campaign] --waves needs a positive integer'); return 2 }
    spec.budget.waves = n
  }
  const dryRun = flag('--dry-run') !== -1
  // The dirty-tree refusal protects the VERDICT COMMIT from landing on top of
  // someone's work. A dry run commits nothing, so it is not subject to it —
  // and refusing there would make the brief unreadable exactly when it is
  // being reviewed mid-edit.
  if (!dryRun) {
    const dirty = (spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean).filter(l => !l.includes('benchmark/cynco-ledger/'))
    if (dirty.length) { console.error(`[campaign] working tree is dirty outside the ledger (${dirty.length} path(s)) — commit or stash first; the runner will not commit over your work`); return 2 }
  }

  // CALIBRATE whenever the instruments changed (or never ran).
  const sha = (p) => calibrateIo.sha256(p)
  const cal = state.state.calibration
  if (!cal || cal.gateSha256 !== sha(spec.gate) || cal.perturbSha256 !== sha(spec.perturb)) {
    console.log('[campaign] CALIBRATE (Rule 11): gate/perturb changed or never calibrated')
    const r = await calibrate(spec)
    if (!r.ok) { console.error('[campaign] CALIBRATION REFUSED:\n  ' + r.problems.join('\n  ')); await notify(`${spec.id}: calibration refused — ${r.problems[0]}`); return 3 }
    state.state.calibration = { gateSha256: r.gateSha256, perturbSha256: r.perturbSha256, baseFails: r.baseFails, basePasses: [], perturbFails: r.perturbFails, calibratedAt: new Date().toISOString() }
    state.save()
    console.log(`[campaign] calibrated: BASE MISS ${r.baseFails.length}, perturb honest${r.suiteBaselineCreated ? ', suite baseline written' : ''}`)
  }
  if (dryRun) {
    console.log(generateBrief(spec, waveContext(spec, state.state)))
    return 0
  }
  // decide() can only say `budget` about a wave it just graded; a campaign
  // resumed after its last wave would otherwise dispatch one more.
  if (budgetSpent(state, spec)) {
    console.log(`[campaign] budget already spent (${state.state.waveCount}/${spec.budget.waves} waves) — nothing to dispatch`)
    return 1
  }
  while (true) {
    const rec = await runWave(spec, state)
    console.log(`[campaign] wave ${rec.wave}: ${rec.decision.kind} — ${rec.decision.why}`)
    if (rec.decision.kind !== 'next') { await notify(`${spec.id.toUpperCase()} STOPPED: ${rec.decision.kind} — ${rec.decision.why}`); return rec.decision.kind === 'pass' ? 0 : 1 }
  }
}

async function sync(spec, state) {
  const branch = `campaign/${spec.id}`
  const reach = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'main'], { encoding: 'utf8', timeout: 20_000 })
  if (reach.status !== 0) { console.log('[campaign] no network — nothing synced; pending branch ' + branch); return 0 }
  spawnSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' })
  const existing = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { encoding: 'utf8' })
  if (existing.status !== 0) spawnSync('gh', ['pr', 'create', '--head', branch, '--title', `${spec.id.toUpperCase()} campaign verdicts (runner)`, '--body', `Unattended wave verdicts written by scripts/cynco-campaign.mjs. Merge on GitHub.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`], { stdio: 'inherit' })
  else console.log(`[campaign] PR exists: ${existing.stdout.trim()}`)
  for (const n of state.state.pendingNotifications.splice(0)) await notify(`${spec.id}: (queued) ${n.kind} — ${n.why}`)
  state.save()
  return 0
}

// bun sets import.meta.main; node 24 does too. The argv comparison is the
// fallback for a runtime that sets neither, and fileURLToPath is the only
// correct file:// → Windows path conversion.
const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => { console.error(`[campaign] ${e?.stack ?? e}`); process.exit(1) })
}
