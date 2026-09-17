// scripts/cynco-campaign-grade.mjs
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseGateOutput } from './cynco-gate-parse.mjs'
import { constraints } from '../engine/cybernetics-core/src/index.js'

export const GATE_TIMEOUT_MS = 7_200_000
export const SUITE_TIMEOUT_MS = 3_600_000
export const SWEEP_TIMEOUT_MS = 3_600_000
const SUITE_GATE = resolve(homedir(), '.cynco', 'heldout', 'common', 'g_suite_no_regression.py')

export const defaultIo = {
  run(cmd, args, { cwd, env, timeoutMs }) {
    const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' }
  },
}

function runGate(spec, io) {
  const t0 = Date.now()
  const r = io.run('python', [spec.gate], { cwd: spec.repo, env: {}, timeoutMs: GATE_TIMEOUT_MS })
  const parsed = parseGateOutput(r.stdout + '\n' + r.stderr)
  let harnessFault = null
  if (r.timedOut) harnessFault = `gate timed out after ${GATE_TIMEOUT_MS} ms`
  else if (parsed.errors.length) harnessFault = `gate printed an error: ${parsed.errors[0]}`
  else if (parsed.terminator === null) harnessFault = 'gate printed no GATE: terminator'
  return { ...parsed, exit: r.status, durationMs: Date.now() - t0, harnessFault, outputTail: (r.stdout + r.stderr).slice(-4000) }
}

function runSuiteGate(spec, io) {
  const r = io.run('python', [SUITE_GATE], { cwd: spec.repo, env: { CHK_SUITE_BASELINE: spec.suiteBaseline }, timeoutMs: SUITE_TIMEOUT_MS })
  const out = r.stdout + r.stderr
  const pick = (label) => { const m = new RegExp(`${label} \\d+ [^\\n]*\\n((?:\\s+[-+] \\S+\\n?)+)`).exec(out); return m ? m[1].split('\n').map(s => s.trim().replace(/^[-+] /, '')).filter(Boolean) : [] }
  let harnessFault = null
  if (r.timedOut) harnessFault = `suite gate timed out after ${SUITE_TIMEOUT_MS} ms`
  else if (r.status === 2) harnessFault = out.trim().split('\n').find(l => /REFUSING|printed no FAILED/.test(l)) ?? 'suite gate refused (exit 2)'
  return { exit: r.status, regressions: pick('REGRESSED'), repairs: pick('REPAIRED'), harnessFault, outputTail: out.slice(-3000) }
}

function runSweep(spec, row, io) {
  const { base, head } = row.commitRange ?? {}
  if (!base || !head || base === head) return null
  // resolve('scripts', …) assumes cwd = repo root: true for the campaign runner,
  // which is always invoked from the repo root (never from engine/ or tui/).
  const r = io.run('python', [resolve('scripts', 'cynco-mutation-sweep.py'), '--repo', spec.repo, '--base', base, '--head', head, '--json'], { cwd: process.cwd(), env: {}, timeoutMs: SWEEP_TIMEOUT_MS })
  if (r.timedOut || r.status === 2) return null
  const last = (r.stdout + '').trim().split('\n').reverse().find(l => l.startsWith('{'))
  if (!last) return null
  try { const j = JSON.parse(last); return { kind: 'derived', command: j.command, killed: j.killed, total: j.total, survived: j.survived ?? [] } } catch { return null }
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
  const sweep = gate.harnessFault ? null : runSweep(spec, row, io)
  const posiwid = posiwidForRow(spec, row)
  const verified = (gate.harnessFault || suite.harnessFault) ? null : (gate.exit === 0 && suite.exit === 0)
  return { sha: row.commitRange?.head ?? null, gate, suite, sweep, posiwid, verified }
}
