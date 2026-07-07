// benchmark/true/polyglot/container.ts
import { spawnSync } from 'node:child_process'

const IMAGE = 'polyglot-bench'
const NAME = 'polyglot-bench-run'
// Named volumes: warm toolchain caches persist across chunks/containers.
const CACHE_VOLUMES = [
  'polyglot-gradle:/root/.gradle',
  'polyglot-cargo:/root/.cargo/registry',
  'polyglot-go:/root/go',
  'polyglot-npm:/root/.npm',
]

function docker(args: string[], timeoutMs?: number) {
  return spawnSync('docker', args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
}

/** Build the polyglot-bench image if it doesn't exist yet. */
export function ensureImage(dockerfileDir: string): void {
  if (docker(['image', 'inspect', IMAGE]).status === 0) return
  console.log(`[polyglot] building ${IMAGE} image (one-time, several minutes)...`)
  const res = spawnSync('docker', ['build', '-t', IMAGE, dockerfileDir], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`docker build failed (exit ${res.status})`)
}

/** Start one long-lived container with the scratch root mounted at /bench. */
export function startContainer(scratchRoot: string): void {
  docker(['rm', '-f', NAME]) // ignore result: may not exist
  const args = ['run', '-d', '--name', NAME, '-v', `${scratchRoot}:/bench`]
  for (const vol of CACHE_VOLUMES) args.push('-v', vol)
  args.push(IMAGE)
  const res = docker(args, 120_000)
  if (res.status !== 0) {
    throw new Error(`failed to start ${NAME}: ${res.stderr || res.stdout}`)
  }
}

export function stopContainer(): void {
  docker(['rm', '-f', NAME])
}

export interface ExecResult {
  code: number
  output: string // stdout + stderr interleaved-ish (stdout first)
  timedOut: boolean
  durationMs: number
}

/** Run a test command inside /bench/<workdirName> with a hard timeout. */
export function execInContainer(workdirName: string, command: string, timeoutMs: number): ExecResult {
  const start = Date.now()
  const res = docker(
    ['exec', '-w', `/bench/${workdirName}`, NAME, 'bash', '-lc', command],
    timeoutMs,
  )
  const timedOut = res.error?.name === 'Error' && /ETIMEDOUT/.test(String((res.error as any).code ?? res.error.message))
  return {
    code: res.status ?? -1,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    timedOut: timedOut || (res.status === null && !!res.error),
    durationMs: Date.now() - start,
  }
}

/**
 * Environmental-failure taxonomy (spec): infra problems, not model failures.
 * Still counted as failures in the headline; flagged for --resume re-runs.
 */
export function isEnvFailure(res: ExecResult): boolean {
  if (res.timedOut) return true
  if ([125, 126, 127].includes(res.code)) return true // docker/daemon/toolchain-missing
  if (/command not found|No such container|error during connect/i.test(res.output)) return true
  return false
}
