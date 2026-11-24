import { execSync } from 'child_process'
import { ContainmentRefusal, refusalReasonOf, toolExecSync, toolSpawnRefusal } from '../containment.js'
import { harnessGitEnv } from '../harnessGit.js'
import { toolAudit, containmentFault } from '../audit/toolAudit.js'
import type { CandidateResult, TestInfo } from './types.js'
import { parseTestSummary } from '../bridge/testSummary.js'

export function selectWinner(candidates: CandidateResult[]): CandidateResult | null {
  const valid = candidates.filter((c) => c.patch.trim().length > 0)
  if (valid.length === 0) return null

  valid.sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    return a.totalTurns - b.totalTurns
  })

  return valid[0]
}

export function parseTestOutput(
  output: string,
  framework: string
): { passed: number; total: number } {
  const summary = parseTestSummary(framework, output)
  return summary ? { passed: summary.passed, total: summary.total } : { passed: 0, total: 0 }
}

/**
 * Runs a candidate's tests. They are the candidate's own code, so in an unattended run they start
 * through the containment (F242); `refused` is set, and nothing was run, when the run's launcher
 * cannot run. A refused run is not a score: the caller applies no candidate.
 */
export function runTests(
  cwd: string,
  testInfo: TestInfo
): { passed: number; total: number; output: string; refused?: string } {
  const refusal = toolSpawnRefusal()
  if (refusal) {
    toolAudit()?.refused({ src: 'best-of-n', by: 'site', input: { command: testInfo.command }, cwd, layer: 'containment', reason: refusal })
    containmentFault('containment', refusalReasonOf(refusal))
    return { passed: 0, total: 0, output: '', refused: refusal }
  }
  // F242: the record of the run is on disk before the candidate's tests start (src best-of-n).
  const audit = toolAudit()
  const started = audit ? audit.start({ src: 'best-of-n', command: testInfo.command, cwd }) : null
  if (started && !started.ok) return { passed: 0, total: 0, output: '', refused: started.reason }
  const t0 = Date.now()
  let output = ''
  try {
    const result = toolExecSync(testInfo.command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    output = result.toString()
    if (audit && started) audit.end(started.call, { isError: false, exitCode: 0, ms: Date.now() - t0, output })
  } catch (err: unknown) {
    if (err instanceof ContainmentRefusal) {
      if (audit && started) audit.end(started.call, { isError: true, exitCode: null, ms: Date.now() - t0, output: err.message })
      containmentFault('containment', refusalReasonOf(err.message))
      return { passed: 0, total: 0, output: '', refused: err.message }
    }
    // Non-zero exit (tests failed) — parse anyway
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = e.stdout ? e.stdout.toString() : ''
    const stderr = e.stderr ? e.stderr.toString() : ''
    output = stdout + stderr
    if (audit && started) {
      const status = (err as { status?: unknown }).status
      audit.end(started.call, { isError: true, exitCode: typeof status === 'number' ? status : null, ms: Date.now() - t0, output })
    }
  }
  const { passed, total } = parseTestOutput(output, testInfo.framework)
  return { passed, total, output }
}

export function applyPatch(repoRoot: string, patch: string): boolean {
  if (!patch.trim()) return false

  const input = Buffer.from(patch)
  // Harness git in a folder a run wrote (F242): no hooks, monitor, repository filters or pager.
  const env = harnessGitEnv(process.env, { repo: repoRoot })

  try {
    execSync('git apply --check -', {
      cwd: repoRoot,
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return false
  }

  try {
    execSync('git apply -', {
      cwd: repoRoot,
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}
