// scripts/cynco-campaign-grade.mjs
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseGateOutput } from './cynco-gate-parse.mjs'
import { runSync, faultSummary } from './cynco-spawn.mjs'
import { constraints } from '../engine/cybernetics-core/src/index.js'

export const GATE_TIMEOUT_MS = 7_200_000
export const SUITE_TIMEOUT_MS = 3_600_000
export const SWEEP_TIMEOUT_MS = 3_600_000
const SUITE_GATE = resolve(homedir(), '.cynco', 'heldout', 'common', 'g_suite_no_regression.py')

export const defaultIo = {
  // F155: the grader has exactly the same exposure as calibrate — its first
  // gate run of a wave follows a long idle gap, and a bare spawnSync would
  // report that stale deadline as a two-hour timeout. `runSync` measures.
  run(cmd, args, opts = {}) {
    return runSync(cmd, args, opts)
  },
  // I4: a failed `git diff` used to come back as an empty list, and an empty
  // list is the exact signal sweepTestsFor reads as "the diff shipped no test
  // file" — so a broken git silently widened the sweep to the whole keep-green
  // suite and the reading looked normal. `null` means "I do not know what
  // changed", and runSweep then leaves `--tests` off so the sweep's own
  // refusal is the visible finding.
  changedFiles(repo, base, head) {
    const r = spawnSync('git', ['-C', repo, 'diff', '--name-only', `${base}..${head}`], { encoding: 'utf8', windowsHide: true })
    if (r.error || r.status !== 0) {
      console.error(`[grade] git diff --name-only ${base}..${head} failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`)
      return null
    }
    return (r.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean)
  },
}

// F147: the sweep's own `--tests` default is "the test files the diff itself
// touched"; a fix-only wave delivers none, so the sweep refuses (exit 2) and
// the row goes unlabeled even though the sealed gate and suite gate both
// PASSed. `spec.keepGreen` already names the tests that own the area — hand
// those over whenever the diff shipped no test file of its own. Pure so the
// rule can be tested without a child process.
export function sweepTestsFor(spec, changedFiles) {
  const hasTestFile = (changedFiles ?? []).some(f => /(^|\/)test_[^/]*\.py$/.test(String(f).replace(/\\/g, '/')))
  if (hasTestFile) return null
  const tokens = String(spec.keepGreen ?? '').split(/\s+/).filter(t => t.endsWith('.py'))
  return tokens.length ? tokens.join(' ') : null
}

function runGate(spec, io) {
  const t0 = Date.now()
  // The gates read CYNCO_GATE_REPO for the tree they grade and fall back to
  // cwd. Both are spec.repo here, so this changes nothing today — and keeps
  // changing nothing the day a gate is run from anywhere else.
  //
  // Review I2: this is the first spawn after a wave that may have run for
  // hours, i.e. exactly the call bun's stale deadline kills (F155). The gate is
  // a read of the tree, so it is retried once on an impossible ETIMEDOUT like
  // calibrate's reads are; and a spawn that still did not run is named as the
  // fault it is — never parsed as an empty gate, which would read as 0 lines.
  const r = io.run('python', [spec.gate], { cwd: spec.repo, env: { CYNCO_GATE_REPO: spec.repo }, timeoutMs: GATE_TIMEOUT_MS, retryImpossibleTimeout: true })
  const parsed = parseGateOutput((r.stdout ?? '') + '\n' + (r.stderr ?? ''))
  let harnessFault = null
  if (r.fault) harnessFault = `gate did not run (${faultSummary(r.fault)})`
  else if (r.timedOut) harnessFault = `gate timed out after ${GATE_TIMEOUT_MS} ms`
  else if (parsed.errors.length) harnessFault = `gate printed an error: ${parsed.errors[0]}`
  else if (parsed.terminator === null) harnessFault = 'gate printed no GATE: terminator'
  return { ...parsed, exit: r.status, durationMs: Date.now() - t0, harnessFault, fault: r.fault ?? null, outputTail: ((r.stdout ?? '') + (r.stderr ?? '')).slice(-4000) }
}

function runSuiteGate(spec, io) {
  // Review I2: a read, like the gate — retried once on an impossible timeout,
  // and a spawn that did not run is a fault, not a suite reading.
  const r = io.run('python', [SUITE_GATE], { cwd: spec.repo, env: { CHK_SUITE_BASELINE: spec.suiteBaseline, CYNCO_GATE_REPO: spec.repo }, timeoutMs: SUITE_TIMEOUT_MS, retryImpossibleTimeout: true })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const pick = (label) => { const m = new RegExp(`${label} \\d+ [^\\n]*\\n((?:\\s+[-+] \\S+\\n?)+)`).exec(out); return m ? m[1].split('\n').map(s => s.trim().replace(/^[-+] /, '')).filter(Boolean) : [] }
  let harnessFault = null
  if (r.fault) harnessFault = `suite gate did not run (${faultSummary(r.fault)})`
  else if (r.timedOut) harnessFault = `suite gate timed out after ${SUITE_TIMEOUT_MS} ms`
  else if (r.status === 2) harnessFault = out.trim().split('\n').find(l => /REFUSING|printed no FAILED/.test(l)) ?? 'suite gate refused (exit 2)'
  return { exit: r.status, regressions: pick('REGRESSED'), repairs: pick('REPAIRED'), harnessFault, fault: r.fault ?? null, outputTail: out.slice(-3000) }
}

// Returns { sweep, sweepFault }: sweepFault is null when the sweep succeeded or
// was legitimately skipped (no diff), and a short human string when the sweep
// was attempted and produced nothing usable. A silent null would otherwise read
// in the verdict as "no diff" when in fact the sweep timed out or refused.
function runSweep(spec, row, io) {
  const { base, head } = row.commitRange ?? {}
  if (!base || !head || base === head) return { sweep: null, sweepFault: null }
  // resolve('scripts', …) assumes cwd = repo root: true for the campaign runner,
  // which is always invoked from the repo root (never from engine/ or tui/).
  // The sweep re-runs the KEEP-GREEN suite once per mutant: at 25 mutants a
  // wave it is the most expensive instrument in the loop and has timed out
  // where the gate did not. `spec.sweep.max` buys the campaign a reading it
  // can afford; 25 stays the default for a spec that says nothing.
  const max = spec.sweep?.max ?? 25
  const changed = (io.changedFiles ?? defaultIo.changedFiles)(spec.repo, base, head)
  // I4: `null` is "the diff could not be read" — not "the diff shipped no test
  // file". Substituting the keep-green suite here would change what the sweep
  // measures on the strength of a guess; leaving `--tests` off lets the sweep
  // refuse, and the refusal is recorded as the sweepFault it is.
  const testsArg = changed === null ? null : sweepTestsFor(spec, changed)
  const args = [resolve('scripts', 'cynco-mutation-sweep.py'), '--repo', spec.repo, '--base', base, '--head', head, '--max', String(max), '--json']
  if (testsArg) args.push('--tests', testsArg)
  const r = io.run('python', args, { cwd: process.cwd(), env: {}, timeoutMs: SWEEP_TIMEOUT_MS })
  if (r.timedOut) return { sweep: null, sweepFault: `timed out after ${SWEEP_TIMEOUT_MS} ms` }
  if (r.status === 2) return { sweep: null, sweepFault: 'sweep refused (exit 2)' }
  const last = (r.stdout + '').trim().split('\n').reverse().find(l => l.startsWith('{'))
  if (!last) return { sweep: null, sweepFault: 'unparseable sweep output' }
  try { const j = JSON.parse(last); return { sweep: { kind: 'derived', command: j.command, killed: j.killed, total: j.total, survived: j.survived ?? [] }, sweepFault: null } } catch { return { sweep: null, sweepFault: 'unparseable sweep output' } }
}

export function posiwidForRow(spec, row) {
  const commitShare = 1 / spec.posiwid.commitEvery
  const stated = new constraints.PurposeModel([
    ['sourceEdit', spec.posiwid.sourceEditShare], ['commit', commitShare], ['inspect', 1 - spec.posiwid.sourceEditShare - commitShare],
  ])
  const ts = row.toolStats ?? {}
  const counts = [
    ['sourceEdit', (ts.byClass?.sourceEdit ?? 0) + (ts.byClass?.fileWrite ?? 0)],
    ['commit', ts.commits ?? 0],
    ['inspect', ts.byClass?.inspect ?? 0],
    ['revert', ts.bashByEffect?.revert ?? 0],
  ]
  return constraints.posiwidDivergence(stated, { counts }, 0.1, 50)
}

export async function gradeWave(spec, row, io = defaultIo) {
  const gate = runGate(spec, io)
  const suite = runSuiteGate(spec, io)
  const { sweep, sweepFault } = gate.harnessFault ? { sweep: null, sweepFault: null } : runSweep(spec, row, io)
  const posiwid = posiwidForRow(spec, row)
  const verified = (gate.harnessFault || suite.harnessFault) ? null : (gate.exit === 0 && suite.exit === 0)
  // Review I2: a spawn that never ran is carried whole on the grade, so the
  // record says which instrument did not run and how — `verified: null` and
  // decide()'s `fault` follow from the harnessFault it also set.
  const fault = gate.fault || suite.fault
    ? { ...(gate.fault ? { gate: gate.fault } : {}), ...(suite.fault ? { suite: suite.fault } : {}) }
    : null
  return { sha: row.commitRange?.head ?? null, gate, suite, sweep, sweepFault, posiwid, verified, fault }
}
