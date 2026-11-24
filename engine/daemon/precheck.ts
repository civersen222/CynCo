// engine/daemon/precheck.ts
// A trigger's own gate (precheck 'command'), run contained before the model is loaded (F242).
import { basename } from 'node:path'
import { ContainmentRefusal, establishContainment, releaseContainment, toolExec, toolSpawnRefusal } from '../containment.js'
import { toolAudit } from '../audit/toolAudit.js'

/**
 * precheck 'command': the trigger's own gate, run contained in the mission workspace with a two-minute cap.
 *
 * The daemon makes a `precheck` sandbox for it (no label on the mission folder: a precheck reads), runs the
 * command through the launcher, and releases the sandbox on every path out. When the command could not be
 * run contained, the answer is `skip: precheck not run: <reason>`, never a failing code: `MissionRunner.fire`
 * lets the pass run after a non-zero precheck ("a broken gate cannot silence a mission"), so a failing code
 * would start the pass although the gate did not run. `id` is the trigger id, for the run id's label.
 */
export function runPrecheck(command: string, cwd?: string, id?: string): Promise<{ code: number | null; stdout: string }> {
  const skip = (why: string) => {
    console.log(`[daemon] precheck not run: ${why}`)
    return Promise.resolve({ code: 0, stdout: `skip: precheck not run: ${why}` })
  }
  if (!cwd) return skip('this trigger names no cwd')
  const est = establishContainment({ kind: 'precheck', label: `precheck-${id ?? basename(cwd)}`, missionCwd: cwd, labelCwd: false })
  if (!est.ok) return skip(est.reason)
  const ctx = est.containment
  const done = () => {
    const r = releaseContainment(ctx)
    if (!r.relabelled && r.note) console.log(`[daemon] ${r.note}`)
  }
  // F242: the record of the command is on disk before it runs (src precheck, the command verbatim);
  // a command the containment refuses first has its refused record.
  const audit = toolAudit(ctx)
  const refusal = toolSpawnRefusal({ ctx, required: true })
  if (refusal) {
    audit?.refused({ src: 'precheck', by: 'site', input: { command }, cwd, layer: 'containment', reason: refusal })
    done()
    return skip(refusal)
  }
  const t0 = Date.now()
  const started = audit ? audit.start({ src: 'precheck', command, cwd }) : null
  if (started && !started.ok) { done(); return skip(`audit: ${started.reason}`) }
  const ended = (r: { isError: boolean; exitCode: number | null; output: string }) => {
    if (audit && started) audit.end(started.call, { ...r, ms: Date.now() - t0 })
  }
  return new Promise((resolve) => {
    try {
      // PYTHONDONTWRITEBYTECODE: the mission folder is not labelled, so Python must not try to write
      // __pycache__ beside the script.
      toolExec(command, {
        cwd, timeout: 120000, windowsHide: true, encoding: 'utf-8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      }, (err, stdout) => {
        done()
        // A launcher that could not run (exit 197 or 198) reaches the callback as a ContainmentRefusal.
        const fault: unknown = err
        if (fault instanceof ContainmentRefusal) {
          ended({ isError: true, exitCode: null, output: fault.reason })
          console.log(`[daemon] precheck not run: ${fault.reason}`)
          resolve({ code: 0, stdout: `skip: precheck not run: ${fault.reason}` })
          return
        }
        const status = (err as { code?: unknown } | null)?.code
        const code = err ? (typeof status === 'number' ? status : 1) : 0
        // The record keeps what happened: a command killed by its two-minute cap (or one whose output
        // overran) has no status, null, although MissionRunner reads it as a non-zero code.
        ended({ isError: code !== 0, exitCode: err ? (typeof status === 'number' ? status : null) : 0, output: String(stdout ?? '') })
        resolve({ code, stdout: String(stdout ?? '') })
      }, ctx)
    } catch (e) {
      done()
      const why = e instanceof ContainmentRefusal ? e.reason : e instanceof Error ? e.message : String(e)
      ended({ isError: true, exitCode: null, output: why })
      console.log(`[daemon] precheck not run: ${why}`)
      resolve({ code: 0, stdout: `skip: precheck not run: ${why}` })
    }
  })
}
