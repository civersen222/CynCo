import { execSync } from 'child_process'
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

export function runTests(
  cwd: string,
  testInfo: TestInfo
): { passed: number; total: number; output: string } {
  let output = ''
  try {
    const result = execSync(testInfo.command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    output = result.toString()
  } catch (err: unknown) {
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

  try {
    execSync('git apply --check -', {
      cwd: repoRoot,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return false
  }

  try {
    execSync('git apply -', {
      cwd: repoRoot,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}
