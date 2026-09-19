#!/usr/bin/env bun
// scripts/cynco-campaign.mjs — the campaign-level metasystem.
//
//   bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c8.campaign.json [--waves N] [--resume] [--dry-run] [--sync]
//                                  [--approve-proposal ideation/brief] [--reject-proposal ideation/brief]
//                                  [--adopt-inflight]
//
// S2: salvage + no-progress stop.   S3: budgets + invariants handed to the wave.
// S3*: sealed gate, suite gate, sweep.   S4: brief (generator binds; ideation advises).
// S5: the campaign spec (identity, checked once per invocation).   Algedonic: ntfy.
//
// Runs under bun (it reaches into engine/*.ts through .js specifiers).
import { resolve, join, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, existsSync, appendFileSync, unlinkSync, openSync, writeSync, closeSync } from 'node:fs'
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
 * Which sweep survivors sit inside a file the campaign CLAIMED — spec §3.2's
 * "a survivor a work[] item claims", read off `spec.allow.edit` /
 * `spec.allow.newFiles` because that is the set the work items are allowed to
 * touch. An allow entry can carry a parenthetical note or a glob
 * (`gilded/tests/test_c8_*.py (new test files …)`), so it is cut at its first
 * space and at its first `*`, leaving a path prefix. Survivors are `path:line`.
 *
 * A survivor OUTSIDE every claimed prefix is reported, never punished: the
 * campaign did not promise to cover code it was forbidden to edit, exactly as
 * the suite gate reports repairs it did not ask for.
 */
export function claimedSurvivors(survived, spec) {
  const prefixes = [...(spec.allow?.edit ?? []), ...(spec.allow?.newFiles ?? [])]
    .map(e => String(e).trim().split(/\s+/)[0].replace(/\\/g, '/').split('*')[0])
    .filter(Boolean)
  return (survived ?? []).filter(s => {
    const p = String(s).replace(/\\/g, '/').replace(/:\d+$/, '')
    return prefixes.some(pre => p === pre || p.startsWith(pre))
  })
}

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
 *   3. pass / pass-with-survivors / no-progress / budget / next.
 *
 * `pass` must stay REACHABLE: a sweep survivor in a file the campaign never
 * claimed is not a reason to deny a green gate, so only claimed survivors
 * downgrade the verdict — and they downgrade it to `pass-with-survivors`,
 * which stops the loop with exit 0. Neither is a `next`: looping on a gate
 * that is already green can only burn the budget.
 */
export function decide({ grade, state, spec, commitsLanded, row }) {
  if (row?.invariantsRejected === true) return { kind: 'fault', why: 'the wave ran without its invariants (block rejected by the engine)' }
  if (grade.verified === null) return { kind: 'fault', why: grade.gate.harnessFault ?? grade.suite.harnessFault ?? 'harness fault' }
  const green = grade.gate.terminator === 'PASS' && grade.suite.exit === 0
  if (green) {
    const survived = grade.sweep?.survived ?? []
    const claimed = claimedSurvivors(survived, spec)
    const sweepSaid = grade.sweep
      ? `sweep ${grade.sweep.killed}/${grade.sweep.total}${survived.length ? `, ${survived.length} survivor(s)` : ' no survivors'}`
      : 'sweep unmeasured'
    if (claimed.length) return { kind: 'pass-with-survivors', survivors: claimed, why: `sealed gate PASS, suite gate PASS, ${sweepSaid} — ${claimed.length} inside a claimed file: ${claimed.join(', ')}` }
    return { kind: 'pass', why: `sealed gate PASS, suite gate PASS, ${sweepSaid}${survived.length ? ' (none inside a claimed file)' : ''}` }
  }
  const ids = grade.gate.fails.map(f => f.id)
  const same = Array.isArray(state.lastFails) && ids.length === state.lastFails.length && ids.every((x, i) => x === state.lastFails[i])
  if (same && commitsLanded === 0 && (state.consecutiveNoProgress ?? 0) >= 1) return { kind: 'no-progress', why: `two consecutive waves with the same ${ids.length} FAIL line(s) and no commits` }
  if (state.waveCount >= spec.budget.waves) return { kind: 'budget', why: `${spec.budget.waves} wave(s) spent; ${ids.length} line(s) still FAIL` }
  return { kind: 'next', why: `${ids.length} line(s) still FAIL` }
}

/**
 * The environment a wave is dispatched with. The worker is an unattended model
 * with a Bash tool: anything in this env it can read, print, or post. The ntfy
 * credentials are the campaign's OWN alert channel (it could page the owner as
 * the runner) and GH_TOKEN/GITHUB_TOKEN would let a mission push and merge.
 * None of the three is needed to do the work, so none of them is handed over.
 */
export function dispatchEnv(base, extra) {
  const out = {}
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('CYNCO_NTFY_') || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN') continue
    out[k] = v
  }
  return { ...out, ...extra }
}

const gitC = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout ?? ''
const repoRel = (abs) => relative(process.cwd(), abs).replace(/\\/g, '/')

export const defaultIo = {
  writeBrief: (path, text, sidecar) => { writeFileSync(path, text, 'utf8'); writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2) + '\n'); return path },
  dispatch: async ({ spec, briefFile, invariants, timeoutS, pidFile, driverLog }) => {
    const env = dispatchEnv(process.env, { LOCALCODE_MAX_ITERATIONS: String(spec.budget.iterations), CYNCO_BASH_TIMEOUT_MS: String(spec.budget.bashTimeoutMs),
      CYNCO_MISSION_INVARIANTS: JSON.stringify(invariants), DRIVER_PID_FILE: pidFile, DRIVER_LOG: driverLog, CYNCO_SKIP_IDLE_ENGINE: '1' })
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
  // The LEDGER LINE is the authority, not the pid. The driver writes its row
  // and then tears down (engine shutdown, snapshots, the odd orphan); a pid
  // probe answers "is that process object still there", which on Windows has
  // been wrong in both directions (an MSYS pseudo-PID nobody can see, a pid
  // that outlives the work). Once the row exists the wave is gradeable, so
  // check for it FIRST on every tick and keep the pid only as the secondary
  // signal for "it is gone and wrote nothing".
  waitForDriver: async ({ pidFile, driverLog, timeoutMs, missionIdFrom = defaultIo.missionIdFrom, pollMs = 30_000 }) => {
    const t0 = Date.now()
    const idNow = () => { try { return missionIdFrom(driverLog) } catch { return null } }
    // The ledger line before the pid file: a driver that already wrote its
    // row is gradeable whether or not its pid file survived, and a missing
    // pid file is only a fault once the row is known to be absent.
    const first = idNow()
    if (first) return { exited: true, missionId: first }
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    // A driver that is already gone on the FIRST probe did not run an
    // eight-hour mission in zero seconds — the PID handoff is broken, and
    // believing it faults a wave that is in fact still running and still
    // holding the GPU with nobody left to grade it. Say which of the two it is.
    if (!alive()) return { exited: false, pidUnseen: pid }
    while (Date.now() - t0 < timeoutMs) {
      const id = idNow()
      if (id) return { exited: true, missionId: id }
      if (!alive()) return { exited: true, missionId: idNow() }
      // Never sleep past the wall clock: a 30 s poll on top of an expired
      // budget is 30 s of a wave nobody is waiting on any more.
      await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - t0)))))
    }
    return { exited: false, timedOut: true }
  },
  // cynco-mission-driver.mjs:837 — `[ledger] <outcome> record <id> appended (…) → <shard>`
  missionIdFrom: (driverLog) => /\[ledger\] \w+ record (\S+) appended/.exec(readFileSync(driverLog, 'utf8'))?.[1] ?? null,
  pidAlive: (pidFile) => { try { return pidIsAlive(Number(readFileSync(pidFile, 'utf8').trim())) } catch { return false } },
  sha256: (p) => calibrateIo.sha256(p),
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
  // Rule 11 is not a one-off: the calibration is evidence about the instrument
  // it was run against, and a gate edited mid-campaign (a fix, a rebase, a
  // hand-tweak) makes every reading after it incomparable with wave 1's. Check
  // the sha BEFORE anything is generated or dispatched; main's CALIBRATE will
  // re-run on the next invocation and the campaign continues from there.
  const sha256 = io.sha256 ?? defaultIo.sha256
  const gateSha256 = sha256(spec.gate)
  if (s.calibration && (gateSha256 !== s.calibration.gateSha256 || sha256(spec.perturb) !== s.calibration.perturbSha256)) {
    return stopWave(spec, state, io, { wave, base, why: 'gate or perturb changed since calibration — re-run to recalibrate' })
  }
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
    // An empty FAIL set means the last grade said PASS. The brief generator
    // would happily write THE MISSES with no lines under it and THE WORK with
    // no items in it, and the wave would spend eight hours on a blank order.
    // Stop instead — a green gate is not a reason to dispatch.
    if (fails.length === 0) return stopWave(spec, state, io, { wave, base, why: 'no failing gate lines to work — grade says PASS' })

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
    // checkIdentity guards the spec's own fields, but the ideation section is
    // written by a model that just read the repo. A brief naming the sealed
    // gate would be refused by sealedPaths mid-run, after the wall clock has
    // already started. Refuse to WRITE it instead.
    const leak = /heldout|gate_c\d|perturb_/.exec(text)
    if (leak) return stopWave(spec, state, io, { wave, base, why: `the generated brief names the sealed instrument "${leak[0]}" — refusing to write it (the S4 ideation section is the likely source)` })
    briefFile = resolve(BRIEFS_DIR, `${spec.id}-wave${wave}.txt`)
    io.writeBrief(briefFile, text, sidecarFor(spec))
    waveFiles = [repoRel(briefFile), repoRel(sidecarPath(briefFile))]

    // S3: dispatch with the terms.
    const stamp = basename(briefFile).replace(/\.[^.]*$/, '')
    const pidFile = `C:/tmp/driver_${stamp}.pid`, driverLog = `C:/tmp/driver_${stamp}.log`
    dispatchedAt = new Date().toISOString()
    let waited
    try {
      const dispatched = await io.dispatch({ spec, briefFile, invariants: spec.invariants, timeoutS: spec.budget.hoursPerWave * 3600, pidFile, driverLog })
      // Persist BEFORE waiting, the daemon's missionLedger discipline: from here
      // on a mission is out there on the GPU, and a runner that dies in the wait
      // must not let the NEXT invocation dispatch a second one on top of it.
      s.inFlight = { wave, missionId: null, briefFile, pidFile, driverLog, dispatchedAt }
      state.save()
      waited = await io.waitForDriver({ pidFile, driverLog, timeoutMs: (spec.budget.hoursPerWave * 3600 + 3600) * 1000 })
      missionId = waited.exited ? (waited.missionId ?? dispatched?.missionId ?? io.missionIdFrom?.(driverLog) ?? null) : null
      row = missionId ? io.readRow(missionId) : null
    } catch (e) {
      console.error(`[campaign] wave ${wave} dispatch/wait failed: ${e?.stack ?? e}`)
      return faultWave(spec, state, io, { wave, missionId: null, briefFile, base, dispatchedAt, files: waveFiles,
        why: `dispatch or wait failed: ${e?.message ?? e}` })
    }
    if (!row) {
      const why = waited.exited ? 'driver exited without a ledger row'
        : waited.pidUnseen ? `driver pid ${waited.pidUnseen} was already invisible on the first probe — the PID handoff is broken and the mission may still be running unwatched (see ${driverLog})`
          : 'driver did not exit within the wall clock'
      return faultWave(spec, state, io, { wave, missionId, briefFile, base, dispatchedAt, files: waveFiles, why })
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
  const followed = ideation ? measureFollowed(ideation, io.firstCommitFiles?.(spec.repo, row.commitRange?.base, row.commitRange?.head) ?? [], fails) : null
  // decide() reads waveCount as "waves spent INCLUDING this one" — the state's
  // own counter is only advanced after the record is appended, so hand decide
  // the count this wave makes rather than the one before it.
  const decision = decide({ grade, state: { ...s, waveCount: wave }, spec, commitsLanded: commits.length, row })
  io.patchRow(missionId, { verified: grade.verified, ...(grade.sweep ? { mutationSweep: grade.sweep } : {}), sweepFault: grade.sweepFault ?? null,
    gate: { sha: grade.sha, gateSha256, terminator: grade.gate.terminator, fails: grade.gate.fails.map(f => f.line), passes: grade.gate.passes.length, priorRegressions: grade.gate.priorRegressions, suiteRegressions: grade.suite.regressions, harnessFault: grade.gate.harnessFault ?? grade.suite.harnessFault ?? null },
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
  const notified = await notifyOrQueue(io, s, `${spec.id.toUpperCase()} wave ${wave}: ${decision.kind.toUpperCase()} — ${decision.why}\n${grade.gate.fails.map(f => f.line).join('\n')}`, decision)

  const rec = { wave, missionId, briefFile, base, head: grade.sha, gateSha256, dispatchedAt, gradedAt: new Date().toISOString(), gate: grade.gate, suite: grade.suite, sweep: grade.sweep, sweepFault: grade.sweepFault ?? null, posiwid: grade.posiwid, verified: grade.verified,
    outcome: { landed: row.outcome === 'landed', exitReason: row.exitReason },
    s4: { generatorInput: { failIds: fails.map(f => f.id), priorMissionId: prior?.missionId ?? null }, ideation, ideationMeta, authority: s.ideationAuthority ?? 0, commander, followed },
    decision, verdictSha, notified }
  state.appendWave(rec)
  const sameFails = Array.isArray(s.lastFails) && grade.gate.fails.map(f => f.id).join() === s.lastFails.join()
  s.consecutiveNoProgress = sameFails && commits.length === 0 ? (s.consecutiveNoProgress ?? 0) + 1 : 0
  s.waveCount = wave; s.lastBase = grade.sha ?? base; s.lastFails = grade.gate.fails.map(f => f.id); s.lastGrade = grade; s.lastRow = row; s.lastCommits = commits
  delete s.inFlight
  const proposal = promotionProposal(state.waves(), s.ideationAuthority ?? 0)
  if (proposal && !s.proposals.some(p => p.status === 'pending')) { s.proposals.push({ ...proposal, proposedAt: new Date().toISOString() }); await tryNotify(io, `${spec.id}: PROPOSAL ${proposal.name} ${s.ideationAuthority ?? 0} → ${proposal.newValue} (max ${proposal.bounds.max}, p=${proposal.evidence.p.toFixed(3)}). Approve with --approve-proposal ${proposal.name}`) }
  state.save()
  return rec
  } catch (e) {
    console.error(`[campaign] wave ${wave} post-run step failed: ${e?.stack ?? e}`)
    return faultWave(spec, state, io, { wave, missionId, briefFile, base, dispatchedAt, files: waveFiles, why: `post-run step failed: ${e?.message ?? e}` })
  }
}

// notify is the last thing standing between a fault and silence; a throw from
// it must never be the reason the wave record goes unwritten.
const tryNotify = async (io, message) => {
  try { return Boolean(await io.notify(message)) } catch (e) { console.error(`[campaign] notify failed: ${e?.message ?? e}`); return false }
}

/** Queue what the algedonic channel could not deliver, and drain it when it can (spec §6). */
async function notifyOrQueue(io, s, message, decision) {
  const notified = await tryNotify(io, message)
  if (!notified) { s.pendingNotifications.push(decision); return false }
  s.pendingNotifications = await drainQueued(s.pendingNotifications, (n) => tryNotify(io, `(queued) ${n.kind} — ${n.why}`))
  return true
}

/**
 * Drain a notification queue into a local array and hand back what could not
 * be sent. `splice(0)` used to empty the queue BEFORE the re-send, so a channel
 * that came back for one message and dropped the next lost the queued verdicts
 * for good — nothing recorded that they were never delivered.
 */
export async function drainQueued(queue, send) {
  const pending = queue.splice(0)
  const failed = []
  for (const n of pending) {
    let ok = false
    try { ok = Boolean(await send(n)) } catch { ok = false }
    if (!ok) failed.push(n)
  }
  return failed
}

/**
 * A refusal to dispatch. It is NOT a spent wave — nothing ran — so waveCount
 * stays where it is; the record exists so the reason is in waves.jsonl and not
 * only in a console nobody was watching.
 */
async function stopWave(spec, state, io, { wave, base, why }) {
  const rec = { wave, missionId: null, briefFile: null, base, dispatchedAt: null, decision: { kind: 'stop', why } }
  rec.notified = await notifyOrQueue(io, state.state, `${spec.id.toUpperCase()} wave ${wave}: STOP — ${why}`, rec.decision)
  state.appendWave(rec)
  delete state.state.inFlight
  state.save()
  console.error(`[campaign] wave ${wave} STOP — ${why}`)
  return rec
}

/**
 * Ruling 8: a wave that faulted still SPENT a wave — counting it is what stops
 * a broken engine from burning the whole budget in a retry loop. The brief and
 * its sidecar are committed here too: they are untracked files the dirty-tree
 * guard would otherwise refuse on at the NEXT invocation, bricking the campaign
 * with work that never ran.
 */
async function faultWave(spec, state, io, { wave, missionId, briefFile, base, dispatchedAt, why, files }) {
  const s = state.state
  const rec = { wave, missionId: missionId ?? null, briefFile, base, dispatchedAt, decision: { kind: 'fault', why } }
  if (files?.length) {
    try { io.commit?.({ repoRoot: '.', branch: `campaign/${spec.id}`, files, message: `${spec.id.toUpperCase()} wave ${wave} dispatched, faulted: ${why}` }) }
    catch (e) { console.error(`[campaign] fault-path commit skipped: ${e.message}`) }
  }
  rec.notified = await notifyOrQueue(io, s, `${spec.id} wave ${wave}: FAULT — ${why}`, rec.decision)
  state.appendWave(rec)
  s.waveCount = wave
  delete s.inFlight
  state.save()
  return rec
}

/** The startup refusal: a wave the last invocation dispatched is still out there. */
export function inFlightRefusal(state) {
  const f = state.state?.inFlight
  if (!f) return null
  return `[campaign] wave ${f.wave} is in flight since ${f.dispatchedAt} (driver log ${f.driverLog}) — wait for it, then run --adopt-inflight`
}

/**
 * `--adopt-inflight`: the operator says the in-flight wave is over. The ledger
 * line in the driver log is the proof it produced a mission; without it, a dead
 * pid is proof it produced nothing. A live pid is neither, so the refusal stands.
 */
export async function adoptInFlight(spec, state, io = defaultIo) {
  const f = state.state.inFlight
  if (!f) return { kind: 'none' }
  let missionId = null
  try { missionId = io.missionIdFrom(f.driverLog) } catch { missionId = null }
  if (missionId) {
    state.state.adoptedRow = missionId
    delete state.state.inFlight
    state.save()
    console.log(`[campaign] --adopt-inflight: wave ${f.wave} wrote ledger row ${missionId} — grading it`)
    return { kind: 'adopted', missionId }
  }
  if (io.pidAlive(f.pidFile)) return { kind: 'alive' }
  const rec = await faultWave(spec, state, io, { wave: f.wave, missionId: null, briefFile: f.briefFile, base: state.state.lastBase ?? spec.base, dispatchedAt: f.dispatchedAt,
    why: `driver is gone and wrote no ledger row (see ${f.driverLog})` })
  return { kind: 'fault', record: rec }
}

/**
 * One runner per campaign state dir. Two runners sharing it would dispatch two
 * waves onto one GPU and interleave their writes to state.json.
 */
export function takeLock(dir) {
  const path = join(dir, 'runner.lock')
  // `wx` is the atomic claim: the open fails when the file exists, so two
  // runners racing for one campaign cannot both write their pid and each read
  // the other's as "mine". Two passes: the first may find a stale lock and
  // remove it, the second claims — and if a third party claimed in between,
  // the second pass reads THEIR live pid and refuses.
  let pid = NaN
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      return { ok: true, path, pid: process.pid }
    } catch (e) { if (e?.code !== 'EEXIST') throw e }
    try { pid = Number(readFileSync(path, 'utf8').trim()) } catch { pid = NaN }
    if (pidIsAlive(pid)) return { ok: false, path, pid }
    console.log(`[campaign] removing a stale runner.lock (pid ${Number.isNaN(pid) ? 'unreadable' : pid} is gone)`)
    try { unlinkSync(path) } catch {}
  }
  return { ok: false, path, pid }
}

export function releaseLock(dir) {
  const path = join(dir, 'runner.lock')
  try { if (existsSync(path) && Number(readFileSync(path, 'utf8').trim()) === process.pid) unlinkSync(path) } catch {}
}

const pidIsAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }

function ledgerShardsTouched() {
  const out = spawnSync('git', ['status', '--porcelain', 'benchmark/cynco-ledger'], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').filter(Boolean).map(l => l.slice(3).trim())
}

/**
 * The dirty-tree refusal, as a predicate over `git status --porcelain` lines.
 *
 * Two things are NOT someone's work in progress: the ledger shards every wave
 * rewrites, and THIS campaign's own wave briefs. A wave that faulted before its
 * verdict leaves its brief and sidecar untracked, and without this exemption
 * that debris refuses every later invocation — the campaign bricks itself on
 * files it wrote. Only untracked (`??`) briefs are exempt: an EDITED brief is a
 * human's change to an order and must still stop the runner.
 */
export function dirtyOutsideCampaign(porcelainLines, spec) {
  const brief = new RegExp(`^${BRIEFS_DIR}/${spec.id}-wave\\d+\\.(txt|contract\\.json)$`)
  return porcelainLines.filter(l => {
    const p = l.slice(3).trim().replace(/\\/g, '/')
    if (p.startsWith('benchmark/cynco-ledger/')) return false
    if (l.startsWith('??') && brief.test(p)) return false
    return true
  })
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
  if (!specPath) { console.error('usage: bun scripts/cynco-campaign.mjs <id>.campaign.json [--waves N] [--resume] [--dry-run] [--sync] [--adopt-inflight] [--approve-proposal NAME] [--reject-proposal NAME]'); return 2 }
  const spec = loadCampaignSpec(specPath)
  const identity = checkIdentity(spec)
  if (!identity.ok) { console.error('[campaign] IDENTITY VIOLATION:\n  ' + identity.problems.join('\n  ')); return 2 }
  const state = new CampaignState(join(cyncoHome(), 'campaigns', spec.id)).load()
  const flag = (n) => argv.indexOf(n)
  // The operator's verbs come BEFORE the lock. A campaign runs for days and
  // its runner holds runner.lock the whole time; a proposal decision that had
  // to wait for the wave to end would arrive after the wave that needed it.
  // Neither verb dispatches, so neither needs the one-runner rule: a decision
  // is merged into state.json by CampaignState.save (the decision on disk
  // wins over the runner's in-memory `pending`), and --sync drains the ntfy
  // queue only when no runner is live.
  if (flag('--approve-proposal') !== -1 || flag('--reject-proposal') !== -1) {
    const approve = flag('--approve-proposal') !== -1; const name = argv[(approve ? flag('--approve-proposal') : flag('--reject-proposal')) + 1]
    const p = state.state.proposals.find(x => x.name === name && x.status === 'pending'); if (!p) { console.error(`no pending proposal ${name}`); return 2 }
    p.status = approve ? 'approved' : 'rejected'; p.decidedAt = new Date().toISOString()
    if (approve && p.name === 'ideation/brief') state.state.ideationAuthority = Math.min(p.newValue, p.bounds.max)
    state.save(); console.log(`[campaign] proposal ${name} ${p.status}`); return 0
  }
  if (flag('--sync') !== -1) {
    const held = takeLock(state.dir)
    if (held.ok) process.on('exit', () => releaseLock(state.dir))
    return sync(spec, state, { drain: held.ok, holder: held.pid })
  }
  const lock = takeLock(state.dir)
  if (!lock.ok) { console.error(`[campaign] another runner holds ${lock.path} (pid ${lock.pid}) — one runner per campaign`); return 2 }
  process.on('exit', () => releaseLock(state.dir))
  // --resume is the default and always has been: the state directory IS the
  // resume point. The flag is accepted so an operator can say so out loud.
  // A wave this runner dispatched and never graded is still on the GPU as far
  // as anything here knows. Dispatching another one would put two missions on
  // one card; the operator says when it is over, and --adopt-inflight is how.
  if (state.state.inFlight) {
    if (flag('--adopt-inflight') === -1) { console.error(inFlightRefusal(state)); return 2 }
    const r = await adoptInFlight(spec, state)
    if (r.kind === 'alive') { console.error(`[campaign] --adopt-inflight refused: the driver (pid file ${state.state.inFlight.pidFile}) is still alive and wrote no ledger row`); return 2 }
    if (r.kind === 'fault') { console.error(`[campaign] wave ${r.record.wave} recorded as a fault: ${r.record.decision.why}`); return 1 }
  }
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
    const dirty = dirtyOutsideCampaign((spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean), spec)
    if (dirty.length) { console.error(`[campaign] working tree is dirty outside the ledger (${dirty.length} path(s)) — commit or stash first; the runner will not commit over your work:\n  ${dirty.join('\n  ')}`); return 2 }
  }

  // CALIBRATE whenever the instruments changed (or never ran).
  const sha = (p) => calibrateIo.sha256(p)
  const cal = state.state.calibration
  if (!cal || cal.gateSha256 !== sha(spec.gate) || cal.perturbSha256 !== sha(spec.perturb)) {
    console.log('[campaign] CALIBRATE (Rule 11): gate/perturb changed or never calibrated')
    const r = await calibrate(spec)
    if (!r.ok) { console.error('[campaign] CALIBRATION REFUSED:\n  ' + r.problems.join('\n  ')); await notify(`${spec.id}: calibration refused — ${r.problems[0]}`); return 3 }
    // basePasses is what wave 1's brief prints as "Already PASS at BASE and must
    // stay so" — the only thing telling the worker which lines it may not break.
    state.state.calibration = { gateSha256: r.gateSha256, perturbSha256: r.perturbSha256, baseFails: r.baseFails, basePasses: r.basePasses ?? [], perturbFails: r.perturbFails, calibratedAt: new Date().toISOString() }
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
    if (rec.decision.kind !== 'next') { await notify(`${spec.id.toUpperCase()} STOPPED: ${rec.decision.kind} — ${rec.decision.why}`); return rec.decision.kind === 'pass' || rec.decision.kind === 'pass-with-survivors' ? 0 : 1 }
  }
}

async function sync(spec, state, { drain = true, holder = null } = {}) {
  const branch = `campaign/${spec.id}`
  const reach = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'main'], { encoding: 'utf8', timeout: 20_000 })
  if (reach.status !== 0) { console.log('[campaign] no network — nothing synced; pending branch ' + branch); return 0 }
  // A push can be REJECTED (non-fast-forward, protected branch) and still leave
  // --sync looking like it worked; the PR would then describe commits nobody
  // has. Say so and change nothing else.
  const push = spawnSync('git', ['push', '-u', 'origin', branch], { encoding: 'utf8' })
  if (push.stdout?.trim()) console.log(push.stdout.trimEnd())
  if (push.stderr?.trim()) console.log(push.stderr.trimEnd())
  if (push.status !== 0) { console.error(`[campaign] git push of ${branch} was rejected (exit ${push.status}) — nothing else synced; resolve it by hand and re-run --sync`); return 1 }
  const prBase = spec.prBase ?? 'main'
  const existing = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { encoding: 'utf8' })
  if (existing.status !== 0) spawnSync('gh', ['pr', 'create', '--head', branch, '--base', prBase, '--title', `${spec.id.toUpperCase()} campaign verdicts (runner)`, '--body', `Unattended wave verdicts written by scripts/cynco-campaign.mjs. Merge on GitHub.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`], { stdio: 'inherit' })
  else console.log(`[campaign] PR exists: ${existing.stdout.trim()}`)
  if (!drain) { console.log(`[campaign] a runner (pid ${holder}) is live — its queued notifications drain at its next verdict, not here`); return 0 }
  const before = state.state.pendingNotifications.length
  state.state.pendingNotifications = await drainQueued(state.state.pendingNotifications, (n) => notify(`${spec.id}: (queued) ${n.kind} — ${n.why}`))
  const left = state.state.pendingNotifications.length
  if (before) console.log(`[campaign] queued notifications: ${before - left} sent, ${left} still queued`)
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
