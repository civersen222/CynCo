import { execSync } from 'child_process'
import { ContainmentRefusal, toolExecSync, toolSpawnRefusal } from '../containment.js'
import { harnessGitEnv } from '../harnessGit.js'
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
  if (refusal) return { passed: 0, total: 0, output: '', refused: refusal }
  let output = ''
  try {
    const result = toolExecSync(testInfo.command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    output = result.toString()
  } catch (err: unknown) {
    if (err instanceof ContainmentRefusal) return { passed: 0, total: 0, output: '', refused: err.message }
    // Non-zero exit (tests failed) — parse anyway
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = e.stdout ? e.stdout.toString() : ''
    const stderr = e.stderr ? e.stderr.toString() : ''
    output = stdout + stderr
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
