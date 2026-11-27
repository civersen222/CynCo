/**
 * engine/print3d/run.ts — start OpenSCAD or Bambu Studio the way every
 * harness child is started: through the containment layer (the low-integrity
 * launcher in a contained run on Windows, the program itself otherwise), with
 * its process tree owned from the moment it exists, ended on its cap and on
 * the turn's Stop (`ownedExec`, `engine/processTree.ts`; F201, F210).
 */
import { execFile } from 'node:child_process'
import { ContainmentRefusal, containedCommand, launcherFaultOf, toolSpawnRefusal } from '../containment.js'
import { ownedExec, ownProcessTree } from '../processTree.js'

export type RunEnd = {
  /** The exit status; null when the program was killed (cap, Stop) or never started. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  stopped: boolean
  /** Why nothing ran (a containment refusal, a program that could not start), or null. */
  refused: string | null
  ms: number
}

export type Runner = (file: string, args: string[], o: { cwd: string; capMs: number; signal?: AbortSignal; env?: Record<string, string | undefined> }) => Promise<RunEnd>

const MAX_BUFFER = 16 * 1024 * 1024

export const runProgram: Runner = async (file, args, o) => {
  const started = Date.now()
  const notRun = (why: string): RunEnd => ({ code: null, stdout: '', stderr: '', timedOut: false, stopped: false, refused: why, ms: Date.now() - started })
  const refusal = toolSpawnRefusal()
  if (refusal) return notRun(refusal)
  let c: ReturnType<typeof containedCommand>
  try {
    c = containedCommand({ file, args }, { cwd: o.cwd, ...(o.env ? { env: o.env } : {}) })
  } catch (e) {
    return notRun(e instanceof Error ? e.message : String(e))
  }
  try {
    const r = await ownedExec(
      callback => execFile(c.file, c.args, { cwd: c.cwd, env: c.env, encoding: 'utf-8', windowsHide: true, maxBuffer: MAX_BUFFER }, callback),
      { capMs: o.capMs, own: ownProcessTree, ...(o.signal ? { signal: o.signal } : {}) },
    )
    const err = r.err as (Error & { code?: unknown }) | null
    if (err instanceof ContainmentRefusal) return notRun(err.message)
    const status = err && typeof err.code === 'number' ? err.code : null
    if (c.viaLauncher && err && !r.timedOut && !r.stopped) {
      const fault = launcherFaultOf(status, r.stderr, c.seal)
      if (fault) return notRun(fault.text)
    }
    if (r.overran) return notRun(`its output passed ${MAX_BUFFER / 1024 / 1024} MiB and it was ended`)
    // The program could not be started at all (ENOENT, EACCES): no exit status, no output.
    if (err && typeof err.code === 'string' && !r.timedOut && !r.stopped) return notRun(`${file} could not be started (${err.code})`)
    return {
      code: r.timedOut || r.stopped ? null : err ? status : 0,
      stdout: r.stdout ?? '', stderr: r.stderr ?? '',
      timedOut: r.timedOut, stopped: r.stopped, refused: null, ms: Date.now() - started,
    }
  } catch (e) {
    return notRun(e instanceof Error ? e.message : String(e))
  }
}
