// engine/daemon/precheck.ts
// A trigger's own gate (precheck 'command'), run contained before the model is loaded (F242).
import { basename } from 'node:path'
import { ContainmentRefusal, establishContainment, refusalText, releaseContainment, toolExec, toolSpawnRefusal } from '../containment.js'
import { toolAudit } from '../audit/toolAudit.js'
import { presenceTripwireConfirmed } from '../integrity.js'
import { ownedExec, ownProcessTree, type OwnedExecEnd } from '../processTree.js'
import { longCommandRefusal } from '../tools/impl/bash.js'

/** How long a trigger's precheck may run before its process tree is ended. */
export const PRECHECK_CAP_MS = 120_000

/**
 * precheck 'command': the trigger's own gate, run contained in the mission workspace with a two-minute cap.
 *
 * The daemon makes a `precheck` sandbox for it (no label on the mission folder: a precheck reads), runs the
 * command through the launcher, and releases the sandbox on every path out. When the command could not be
 * run contained, the answer is `skip: precheck not run: <reason>`, never a failing code: `MissionRunner.fire`
 * lets the pass run after a non-zero precheck ("a broken gate cannot silence a mission"), so a failing code
 * would start the pass although the gate did not run. `id` is the trigger id, for the run id's label.
 * `capMs` is the cap (`PRECHECK_CAP_MS`); a test shortens it.
 */
export async function runPrecheck(command: string, cwd?: string, id?: string, capMs: number = PRECHECK_CAP_MS): Promise<{ code: number | null; stdout: string }> {
  const skip = (why: string) => {
    console.log(`[daemon] precheck not run: ${why}`)
    return Promise.resolve({ code: 0, stdout: `skip: precheck not run: ${why}` })
  }
  if (!cwd) return skip('this trigger names no cwd')
  // F242 (NOW.md, the bypass sites): a precheck starts outside the executor, so it asks the presence
  // tripwire itself before anything is made or started. The daemon runs no tripwire, so there the
  // answer is null at once; in a process that lost a protected folder the precheck is not run.
  const lost = await presenceTripwireConfirmed()
  if (lost) return skip(refusalText('integrity', lost))
  // Wave 19b (`longCommandRefusal`): a command one Windows command line cannot carry made the spawn
  // throw, and one that starts Git's bash or sh with more than about 8,190 characters ran cut short and
  // exited 0, a gate answer from a command that never ran whole. Neither is started, and no sandbox is
  // made for it.
  const tooLong = longCommandRefusal(command, command)
  if (tooLong) return skip(tooLong)
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
  // The tree is owned from the moment the launcher exists and ended on the precheck's own cap, with
  // a two-second grace, and, when a Job Object holds it, on an output overrun (`ownedExec`,
  // engine/processTree.ts; a walked tree is released then, its root having ended: F255): exec's own
  // kill ended the launcher alone (NOW.md, 2026-11-24; F201, F210). A precheck that ends on its own
  // releases the handle and kills nothing. A cut precheck reads as before: no status, code 1.
  let r: OwnedExecEnd
  try {
    // PYTHONDONTWRITEBYTECODE: the mission folder is not labelled, so Python must not try to write
    // __pycache__ beside the script.
    r = await ownedExec(callback => toolExec(command, {
      cwd, windowsHide: true, encoding: 'utf-8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, callback, ctx), {
      capMs, own: ownProcessTree,
      onCut: () => console.log(`[daemon] precheck cut at its cap of ${capMs} ms; its process tree is ended`),
    })
  } catch (e) {
    done()
    const why = e instanceof ContainmentRefusal ? e.reason : e instanceof Error ? e.message : String(e)
    ended({ isError: true, exitCode: null, output: why })
    console.log(`[daemon] precheck not run: ${why}`)
    return { code: 0, stdout: `skip: precheck not run: ${why}` }
  }
  done()
  const { err, stdout, timedOut } = r
  // A launcher that could not run (exit 197 or 198) reaches the callback as a ContainmentRefusal.
  const fault: unknown = err
  if (fault instanceof ContainmentRefusal) {
    ended({ isError: true, exitCode: null, output: fault.reason })
    console.log(`[daemon] precheck not run: ${fault.reason}`)
    return { code: 0, stdout: `skip: precheck not run: ${fault.reason}` }
  }
  // A tree ended on the cap has no status of its own (the job's exit code is the kill's).
  const status = timedOut ? null : (err as { code?: unknown } | null)?.code
  const code = timedOut ? 1 : err ? (typeof status === 'number' ? status : 1) : 0
  // The record keeps what happened: a command killed by its two-minute cap (or one whose output
  // overran) has no status, null, although MissionRunner reads it as a non-zero code.
  ended({ isError: code !== 0, exitCode: timedOut ? null : err ? (typeof status === 'number' ? status : null) : 0, output: stdout })
  return { code, stdout }
}
