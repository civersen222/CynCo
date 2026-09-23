// scripts/cynco-campaign-calibrate.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseGateOutput, parsePerturbHeader, compareCalibration } from './cynco-gate-parse.mjs'
import { GATE_TIMEOUT_MS, SUITE_TIMEOUT_MS } from './cynco-campaign-grade.mjs'

export const defaultIo = {
  run: (cmd, args, { cwd, env, timeoutMs, shell } = {}) => {
    const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' }
  },
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, s) => writeFileSync(p, s, 'utf8'),
  sha256: (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16),
  freshDir: (p) => { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }) },
}

/**
 * A fresh `git archive` of `base` from `repo`, extracted into `dest`.
 *
 * Extracted from calibrate() because the authoring verb needs the same archive
 * for a different reason (the game at BASE that a gate author reads), and two
 * spellings of "the BASE the gate was calibrated against" is exactly the kind
 * of drift Rule 11 exists to prevent. Outside the repo, always — a worktree
 * inside it would put the BASE on the same disk the mission is editing.
 */
export function archiveBase(repo, base, dest, io = defaultIo) {
  io.freshDir?.(dest)
  const arch = io.run('bash', ['-c', `git -C ${JSON.stringify(repo)} archive ${base} | tar -x -C ${JSON.stringify(dest)}`], { cwd: process.cwd(), env: {}, timeoutMs: 300_000 })
  if (arch.status !== 0) return { ok: false, problems: [`git archive ${base} failed: ${String(arch.stderr).trim()}`] }
  return { ok: true, problems: [] }
}

// Rule 11 (feedback_gate_authoring): run the bar against the BASE and against a
// perturbed base BEFORE dispatch. Four stages were lost to skipping this by
// hand, so the runner cannot skip it: calibrate() is the only way in.
// `baseDir` lets a caller that ALREADY archived the BASE hand it over instead of
// paying for a second archive of the same commit (the authoring verb's --check
// does exactly that). Omit it and calibrate archives for itself, as the runner does.
export async function calibrate(spec, io = defaultIo, { baseDir: providedBaseDir } = {}) {
  const baseDir = providedBaseDir ?? `C:/tmp/${spec.id}_base`
  // A caller-supplied baseDir replaces the archive, so nothing else would
  // notice it is missing: the gate would run against an empty cwd and report a
  // BASE that misses every line by absence — a calibration that looks perfect
  // and measured nothing.
  if (providedBaseDir && !io.exists(providedBaseDir)) return { ok: false, problems: [`provided baseDir does not exist: ${providedBaseDir}`] }
  if (!providedBaseDir) {
    const arch = archiveBase(spec.repo, spec.base, baseDir, io)
    if (!arch.ok) return arch
  }

  // Read the perturb header FIRST: it is the declaration the whole comparison
  // is judged against, it costs a file read, and a stub with no header can only
  // end in a refusal — after two gate runs of up to two hours each.
  let header
  try { header = parsePerturbHeader(io.readFile(spec.perturb)) } catch (e) { return { ok: false, problems: [e.message] } }

  const env = { CYNCO_GATE_REPO: baseDir }
  const baseRun = io.run('python', [spec.gate], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS })
  const base = parseGateOutput(baseRun.stdout + '\n' + baseRun.stderr)
  const pertRun = io.run('python', [spec.perturb], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS })
  const perturbed = parseGateOutput(pertRun.stdout + '\n' + pertRun.stderr)

  // Rule 14, mechanical: the positive shim makes every graded fact true, so a
  // gate that cannot be passed even in principle (a typo'd path, an assert that
  // can never hold) is caught here rather than after a wave of GPU hours.
  let positiveRun = null, positive = null
  if (spec.positive) {
    positiveRun = io.run('python', [spec.positive], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS })
    positive = parseGateOutput(positiveRun.stdout + '\n' + positiveRun.stderr)
  }

  const cmp = compareCalibration({ base, perturbed, positive, header })
  const problems = [...cmp.problems]
  if (baseRun.timedOut) problems.push(`gate timed out after ${GATE_TIMEOUT_MS} ms at BASE`)
  if (pertRun.timedOut) problems.push(`perturb timed out after ${GATE_TIMEOUT_MS} ms`)
  if (positiveRun?.timedOut) problems.push(`positive shim timed out after ${GATE_TIMEOUT_MS} ms`)
  const ok = problems.length === 0

  // The suite baseline is the standing-failure set measured AT THE BASE: it is
  // only honest if the gate calibrated clean, and it is never overwritten once
  // written (a later measurement would launder regressions into "standing").
  let suiteBaselineCreated = false
  if (ok && !io.exists(spec.suiteBaseline)) {
    const py = io.run('python', ['-m', 'pytest', 'gilded/tests', '-q', '--tb=no'], { cwd: baseDir, env: { SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }, timeoutMs: SUITE_TIMEOUT_MS })
    const ids = (py.stdout + py.stderr).split('\n').filter(l => l.startsWith('FAILED ')).map(l => l.slice(7).split(/\s+-\s+/)[0].trim())
    io.writeFile(spec.suiteBaseline, `# standing failures of gilded/tests at ${spec.base}, measured ${new Date().toISOString().slice(0, 10)} by cynco-campaign calibrate\n${ids.join('\n')}\n`)
    suiteBaselineCreated = true
  }

  return {
    ok,
    problems,
    gateSha256: io.sha256(spec.gate),
    perturbSha256: io.sha256(spec.perturb),
    positiveSha256: spec.positive ? io.sha256(spec.positive) : null,
    baseFails: base.fails,
    basePasses: base.passes,
    perturbFails: perturbed.fails,
    positive,
    suiteBaselineCreated,
    baseOutputTail: (baseRun.stdout + baseRun.stderr).slice(-4000),
    perturbOutputTail: (pertRun.stdout + pertRun.stderr).slice(-4000),
    positiveOutputTail: positiveRun ? (positiveRun.stdout + positiveRun.stderr).slice(-4000) : null,
  }
}
