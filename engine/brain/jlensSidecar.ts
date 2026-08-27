/**
 * Auto-start for the jlens sidecar (the J-Space readout service, port 9163).
 *
 * The sidecar existed for six weeks and nothing ever started it: the README
 * documented a four-step manual ritual, so the brain workspace read
 * "jlens sidecar down" on every session that skipped the ritual — which was
 * all of them. The engine owns the dependency now: if the lens artifacts are
 * on disk, the engine starts the sidecar; if they are not, it says exactly
 * which prerequisite is missing instead of degrading silently.
 *
 * Stale processes are killed, never adopted (feedback_zombie_servers: on
 * Windows children outlive their parent, and a sidecar from a dead engine is
 * a process whose state nobody can account for). The kill matches on the
 * module name in the command line, so a foreign process squatting on the
 * port is left alone — the fresh sidecar will fail to bind and say so.
 */
import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SIDECAR_MODULE = 'jlens_service.server'

export type JlensSidecarHandle = {
  proc: ChildProcess
  stop(): void
}

export type SidecarDecision =
  | { start: true }
  | { start: false; reason: string }

/**
 * Whether the engine should manage a sidecar at all. Pure, for tests.
 *
 * - LOCALCODE_JLENS_URL pointing anywhere but loopback:9163 means the user
 *   runs their own lens (another box, another port) — do not compete with it.
 * - Missing artifacts means the sidecar would die on load; name the fix
 *   instead of spawning a corpse.
 */
export function sidecarDecision(env: {
  jlensUrl?: string
  artifactsPresent: boolean
}): SidecarDecision {
  const url = env.jlensUrl
  if (url && !/^https?:\/\/(127\.0\.0\.1|localhost):9163\/?$/.test(url)) {
    return { start: false, reason: `LOCALCODE_JLENS_URL=${url} — externally managed lens, not starting one` }
  }
  if (!env.artifactsPresent) {
    return {
      start: false,
      reason: 'lens artifacts missing — run `cd jlens && python -m jlens_service.download` once to enable the J-Space readout',
    }
  }
  return { start: true }
}

export function jlensArtifactsDir(): string {
  return process.env.JLENS_DIR ?? join(homedir(), '.cynco', 'jlens')
}

function killStaleSidecars(log: (msg: string) => void): void {
  try {
    if (process.platform === 'win32') {
      const pids = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='python.exe'\\" | Where-Object { $_.CommandLine -like '*${SIDECAR_MODULE}*' } | Select-Object -ExpandProperty ProcessId"`,
        { timeout: 15000 },
      ).toString().split(/\s+/).filter(Boolean)
      for (const pid of pids) {
        log(`[jlens] killing stale sidecar pid ${pid}`)
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 10000 })
        } catch (e) {
          log(`[jlens] stale pid ${pid} already gone: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
        }
      }
    } else {
      execSync(`pkill -f ${SIDECAR_MODULE}`, { stdio: 'ignore', timeout: 10000 })
    }
  } catch (e) {
    // No stale processes found (pkill exits 1) or the probe itself failed —
    // either way the spawn below is the source of truth.
    log(`[jlens] stale-sidecar probe: nothing to kill (${e instanceof Error ? e.message.split('\n')[0] : e})`)
  }
}

/**
 * Kill any stale sidecar and start a fresh one. Returns null (with the reason
 * logged) when the sidecar should not or cannot be managed. Non-blocking: the
 * ActivationsConsumer re-probes the lens, so the tier upgrades on its own
 * once the artifacts finish loading (~20s).
 */
export function startJlensSidecar(opts: {
  /** Defaults to <repo>/jlens, resolved from this module's location. */
  jlensRepoDir?: string
  log?: (msg: string) => void
} = {}): JlensSidecarHandle | null {
  const log = opts.log ?? console.log
  const jlensRepoDir = opts.jlensRepoDir ?? join(import.meta.dir, '..', '..', 'jlens')
  const decision = sidecarDecision({
    jlensUrl: process.env.LOCALCODE_JLENS_URL,
    artifactsPresent: existsSync(join(jlensArtifactsDir(), 'wu.pt')),
  })
  if (!decision.start) {
    log(`[jlens] sidecar not started: ${decision.reason}`)
    return null
  }
  if (!existsSync(jlensRepoDir)) {
    log(`[jlens] sidecar not started: service source missing at ${jlensRepoDir}`)
    return null
  }

  killStaleSidecars(log)

  const python = process.env.LOCALCODE_JLENS_PYTHON ?? 'python'
  const proc = spawn(python, ['-m', SIDECAR_MODULE], {
    cwd: jlensRepoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line) log(`[jlens] ${line}`)
  })
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line) log(`[jlens] ${line}`)
  })
  proc.on('exit', (code) => {
    // An exit is always worth a line: 0 means stop() ran; anything else is
    // the dependency the workspace status will blame going down for real.
    log(`[jlens] sidecar exited with code ${code}`)
  })
  proc.on('error', (err) => {
    log(`[jlens] sidecar failed to spawn: ${err.message} — is python on PATH? (LOCALCODE_JLENS_PYTHON overrides)`)
  })
  log(`[jlens] sidecar starting (pid ${proc.pid ?? '?'}, ${python} -m ${SIDECAR_MODULE})`)

  return {
    proc,
    stop() {
      if (process.platform === 'win32' && proc.pid) {
        // proc.kill() only signals the direct child; taskkill /T takes the
        // tree, which is what actually releases the port on Windows.
        try {
          execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore', timeout: 10000 })
        } catch (e) {
          console.log(`[jlens] sidecar pid ${proc.pid} already gone: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
        }
      } else {
        proc.kill('SIGTERM')
      }
    },
  }
}
