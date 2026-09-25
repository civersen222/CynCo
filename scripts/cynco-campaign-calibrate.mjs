// scripts/cynco-campaign-calibrate.mjs
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { parseGateOutput, parsePerturbHeader, compareCalibration } from './cynco-gate-parse.mjs'
import { GATE_TIMEOUT_MS, SUITE_TIMEOUT_MS } from './cynco-campaign-grade.mjs'
import { runSync, faultSummary } from './cynco-spawn.mjs'

export const defaultIo = {
  // F155: `runSync`, never a bare spawnSync — a timeout must be an elapsed
  // measurement and anything else spawnSync reports is a named harness fault.
  run: (cmd, args, opts = {}) => runSync(cmd, args, opts),
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

/**
 * Which instrument a `compareCalibration` problem is about — the file the fix
 * belongs in. The positive shim's own reading is the positive shim's; the cheat
 * stub's run and everything its header declares (MUST-FAIL, EXPECT-FLIP, the
 * classification of every BASE failure) is the perturb's; what the gate prints
 * at BASE (the terminator, its errors, its line count) is the gate's.
 */
export function instrumentOf(problem) {
  const p = String(problem)
  if (/^positive shim/.test(p)) return 'positive'
  if (/^perturbed run|^MUST-FAIL|^discriminator |^unclassified base fails|under the cheat stub/.test(p)) return 'perturb'
  return 'gate'
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
  // Every problem below names the instrument it is about (Phase 4 residual): a
  // resume told "BASE must MISS" had to work out that the fix lives in
  // gate_c9.py and not in the stub. `named` appends ` (<file>)` unless the text
  // already carries the name.
  const files = { gate: basename(String(spec.gate)), perturb: basename(String(spec.perturb)), positive: spec.positive ? basename(String(spec.positive)) : null }
  const named = (text, which) => (files[which] && !text.includes(files[which]) ? `${text} (${files[which]})` : text)

  let header
  try { header = parsePerturbHeader(io.readFile(spec.perturb)) } catch (e) { return { ok: false, problems: [named(e.message, 'perturb')] } }

  const env = { CYNCO_GATE_REPO: baseDir }
  const baseRun = io.run('python', [spec.gate], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS, retryImpossibleTimeout: true })
  const base = parseGateOutput(baseRun.stdout + '\n' + baseRun.stderr)
  const pertRun = io.run('python', [spec.perturb], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS, retryImpossibleTimeout: true })
  const perturbed = parseGateOutput(pertRun.stdout + '\n' + pertRun.stderr)

  // Rule 14, mechanical: the positive shim makes every graded fact true, so a
  // gate that cannot be passed even in principle (a typo'd path, an assert that
  // can never hold) is caught here rather than after a wave of GPU hours.
  let positiveRun = null, positive = null
  if (spec.positive) {
    positiveRun = io.run('python', [spec.positive], { cwd: baseDir, env, timeoutMs: GATE_TIMEOUT_MS, retryImpossibleTimeout: true })
    positive = parseGateOutput(positiveRun.stdout + '\n' + positiveRun.stderr)
  }

  // F155, before any comparison: a run that produced NOTHING measured nothing,
  // and a comparison over nothing is not a reading — it is six inventions. The
  // live C9 authoring runner's gate at BASE came back empty in 7 ms (bun's stale
  // spawnSync deadline), and `compareCalibration` dutifully reported a null
  // terminator, zero graded lines and a MUST-FAIL complaint per discriminator
  // against an empty BASE failure set. Every one of those blamed the gate for
  // the harness. A fault is reported as a fault, and nothing else is reported.
  const faults = []
  for (const [what, run, parsed, which] of [
    ['gate run at BASE', baseRun, base, 'gate'],
    ['perturb run', pertRun, perturbed, 'perturb'],
    ...(positiveRun ? [['positive shim run', positiveRun, positive, 'positive']] : []),
  ]) {
    if (run.fault) faults.push(named(`harness fault: ${what} did not run (${faultSummary(run.fault)}) — nothing was graded`, which))
    // "Produced no output" means NO output, on either stream. A child that dies at
    // import writes a traceback to stderr and nothing to stdout, and that is the
    // CHILD's failure — a model defect. Reading stdout alone called it a harness
    // fault, which blames the harness for the model's bug and, worse, drops the
    // traceback: `livePreviousCheck` would then show the resume nothing to fix.
    else if (!run.timedOut && `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() === '' && parsed?.terminator == null) {
      faults.push(named(`harness fault: ${what} produced no output (status ${run.status ?? 'null'}`
        + `${typeof run.elapsedMs === 'number' ? `, after ${run.elapsedMs} ms` : ''}) — nothing was graded`, which))
    }
  }
  if (faults.length) {
    return {
      ok: false,
      problems: faults,
      gateSha256: io.sha256(spec.gate),
      perturbSha256: io.sha256(spec.perturb),
      positiveSha256: spec.positive ? io.sha256(spec.positive) : null,
      baseFails: [], basePasses: [], perturbFails: [], positive: null,
      suiteBaselineCreated: false,
      baseOutputTail: (baseRun.stdout + baseRun.stderr).slice(-4000),
      perturbOutputTail: (pertRun.stdout + pertRun.stderr).slice(-4000),
      positiveOutputTail: positiveRun ? (positiveRun.stdout + positiveRun.stderr).slice(-4000) : null,
      harnessFault: true,
    }
  }

  const cmp = compareCalibration({ base, perturbed, positive, header })
  const problems = cmp.problems.map(p => named(p, instrumentOf(p)))
  if (baseRun.timedOut) problems.push(named(`gate timed out after ${GATE_TIMEOUT_MS} ms at BASE`, 'gate'))
  if (pertRun.timedOut) problems.push(named(`perturb timed out after ${GATE_TIMEOUT_MS} ms`, 'perturb'))
  if (positiveRun?.timedOut) problems.push(named(`positive shim timed out after ${GATE_TIMEOUT_MS} ms`, 'positive'))
  const ok = problems.length === 0

  // The suite baseline is the standing-failure set measured AT THE BASE: it is
  // only honest if the gate calibrated clean, and it is never overwritten once
  // written (a later measurement would launder regressions into "standing").
  let suiteBaselineCreated = false
  if (ok && !io.exists(spec.suiteBaseline)) {
    const py = io.run('python', ['-m', 'pytest', 'gilded/tests', '-q', '--tb=no'], { cwd: baseDir, env: { SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }, timeoutMs: SUITE_TIMEOUT_MS, retryImpossibleTimeout: true })
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
    harnessFault: false,
  }
}
