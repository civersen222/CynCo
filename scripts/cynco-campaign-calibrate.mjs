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

// Rule 11 (feedback_gate_authoring): run the bar against the BASE and against a
// perturbed base BEFORE dispatch. Four stages were lost to skipping this by
// hand, so the runner cannot skip it: calibrate() is the only way in.
export async function calibrate(spec, io = defaultIo) {
  const baseDir = `C:/tmp/${spec.id}_base`
  io.freshDir?.(baseDir)
  // git archive outside the repo — brief-authoring rule 14: never a worktree inside it
  const arch = io.run('bash', ['-c', `git -C ${JSON.stringify(spec.repo)} archive ${spec.base} | tar -x -C ${JSON.stringify(baseDir)}`], { cwd: process.cwd(), env: {}, timeoutMs: 300_000 })
  if (arch.status !== 0) return { ok: false, problems: [`git archive ${spec.base} failed: ${String(arch.stderr).trim()}`] }

  const env = { CYNCO_GATE_REPO: baseDir }
  const baseRun = io.run('python', [spec.gate], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS })
  const base = parseGateOutput(baseRun.stdout + '\n' + baseRun.stderr)
  const pertRun = io.run('python', [spec.perturb], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS })
  const perturbed = parseGateOutput(pertRun.stdout + '\n' + pertRun.stderr)

  let header
  try { header = parsePerturbHeader(io.readFile(spec.perturb)) } catch (e) { return { ok: false, problems: [e.message] } }
  const cmp = compareCalibration({ base, perturbed, header })
  const problems = [...cmp.problems]
  if (baseRun.timedOut) problems.push(`gate timed out after ${GATE_TIMEOUT_MS} ms at BASE`)
  if (pertRun.timedOut) problems.push(`perturb timed out after ${GATE_TIMEOUT_MS} ms`)
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
    baseFails: base.fails,
    perturbFails: perturbed.fails,
    suiteBaselineCreated,
    baseOutputTail: (baseRun.stdout + baseRun.stderr).slice(-4000),
    perturbOutputTail: (pertRun.stdout + pertRun.stderr).slice(-4000),
  }
}
