/**
 * Keep a held-out instrument the instrument it was dispatched as.
 *
 * F45. The seal (engine/tools/sealedPaths.ts) hides a gate's NAME and CONTENTS
 * from the run: a Read is refused, and the path is redacted out of every
 * listing, grep hit and stack trace. That is a read barrier, and it held —
 * measured on Gilded I4d2b3f, the run never saw the gate's path.
 *
 * It is not a write barrier, and nothing was. The run found
 * `patch_gate_i4d2b3f.py` sitting unsealed beside the gate — the script that
 * GENERATES the gate, naming every check it makes — read it in full, and then
 * RAN it. The script rebuilt the gate from a stale base, five minutes before the
 * driver ran it. The mission was scored by a gate it had regenerated itself,
 * carrying a previous wave's demands and a NameError that made everything after
 * it unmeasured. Five hundred turns; nothing in the record said why.
 *
 * The seal could not have caught this. `Write`, `Edit` and friends are checked
 * against the sealed set, but a shell command that spawns `python some.py` is
 * one syscall away from any path on the disk, and the executor says so in as
 * many words (engine/tools/executor.ts, WORKSPACE_MUTATING_TOOLS). Sealing the
 * generator would not have caught it either: the next mission's generator has a
 * different name, and a guard that must be told each new spelling of the danger
 * is not a guard.
 *
 * So this does not try to stop the write. It makes the write not matter: the
 * driver takes the instrument's bytes at dispatch, and puts them back
 * immediately before the check runs. Whatever route the tree took — a generator,
 * an editor, a stray `rm` — the gate that runs is the gate that was dispatched,
 * and the fact that it had to be put back is reported rather than swallowed.
 */

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { markerCheckGateAssertions } from '../engine/bridge/contractAutoCreate.js'

/**
 * The assertions the driver derives its instrument set from: the mission's
 * contract plus the marker check's channel (Phase 7 final review I1). The
 * marker check reaches the driver as CYNCO_MARKER_CHECK, not as a contract
 * assertion, so without this its instruments — the suite gate and its sealed
 * baseline — would be neither counted as sealed nor snapshotted and restored.
 * Read for paths only; the engine derives the same set the same way.
 */
export function driverInstrumentAssertions(missionAssertions, env = process.env) {
  return [...(missionAssertions ?? []), ...markerCheckGateAssertions(env)]
}

/**
 * Copy each held-out instrument into `vault`.
 *
 * The snapshot's filename is a hash of the source path, not its basename: two
 * gates called `gate.py` in different directories are two instruments, and
 * restoring one over the other is a way to score a mission against the wrong
 * check entirely.
 *
 * A path that does not exist at dispatch is recorded as missing rather than
 * skipped. It is a real condition — a check command naming a file nobody
 * created — and the record has to be able to say so later without guessing.
 *
 * So is a path that is not a regular file. F152: the live C9 authoring run was
 * handed `C:/tmp/c9_author_base`, a DIRECTORY, because its check command names
 * one; `copyFileSync` raised EPERM and took the whole driver down before the
 * model ran a single iteration — four hours of budget spent on a stack trace.
 * `withheldGatePaths` no longer offers a directory (that is the fix), and this
 * records one as unsnapshottable rather than dying on it (that is the reason
 * the fix gets a second chance to be wrong safely). Either way it is in the
 * record, never swallowed.
 */
export function snapshotHeldOut(paths, vault) {
  mkdirSync(vault, { recursive: true })
  return paths.map(path => {
    if (!existsSync(path)) return { path, snapshot: null, missing: true }
    if (!statSync(path).isFile()) {
      console.error(`[held-out] ${path} is not a regular file — it cannot be snapshotted or put back, and is not treated as an instrument`)
      return { path, snapshot: null, missing: true }
    }
    const key = createHash('sha256').update(path).digest('hex').slice(0, 16)
    const snapshot = join(vault, `${key}.heldout`)
    copyFileSync(path, snapshot)
    return { path, snapshot, missing: false }
  })
}

/**
 * Put each instrument back as it was, and return the paths that needed it.
 *
 * Bytes, not size and not mtime. A regeneration from a stale base lands on a
 * plausible length and a mtime that is merely recent, and either check would
 * have read the I4d2b3f substitution as no change at all.
 *
 * An empty return means the run left the instruments alone. That is the
 * ordinary case, and it is worth being able to state rather than assume.
 */
export function restoreHeldOut(snapshots) {
  const changed = []
  for (const s of snapshots) {
    if (s.missing || !s.snapshot) continue
    const want = readFileSync(s.snapshot)
    if (existsSync(s.path) && readFileSync(s.path).equals(want)) continue
    writeFileSync(s.path, want)
    changed.push(s.path)
  }
  return changed
}

/**
 * Run the driver's check routine and put every instrument back on EVERY exit
 * of it (Phase 7 final review M5). `gradeAtCheck` restores before each check,
 * but a routine that runs no check — the skipped-gate path — or throws used to
 * leave the snapshot unrestored for the runner's own grade, which reads the
 * same files after the driver. Returns { value, restoredAtExit } (paths, kept
 * in the driver's scope; the log line counts them and names none); a throw from
 * `work` still restores, then propagates.
 */
export async function withHeldOutRestored(snapshots, work, log = console.log) {
  let value
  let restored = []
  try {
    value = await work()
  } finally {
    restored = restoreHeldOut(snapshots)
    if (restored.length) {
      log(`[verify] HELD-OUT INSTRUMENT CHANGED UNDER THE MISSION: ${restored.length} restored at the end of the check routine `
        + 'from the dispatch snapshot — something in this run wrote to a file it was never shown.')
    }
  }
  return { value, restoredAtExit: restored }
}
