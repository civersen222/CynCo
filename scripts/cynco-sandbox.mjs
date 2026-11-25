// scripts/cynco-sandbox.mjs
// The command line over the sandbox of an unattended run (F242; engine/containment.ts).
//
// The starter of a run (scripts/dispatch-mission.sh) makes the run's sandbox with `create` and
// gives it back with `release`; the owner looks with `status` and recovers with `release` and
// `sweep`. It always makes a real, non-test sandbox: there is no way to pass `test`, so a sandbox
// made here can never coexist with LOCALCODE_CONTAINMENT_OFF.
//
//   bun scripts/cynco-sandbox.mjs mint <label>
//   bun scripts/cynco-sandbox.mjs create --run-id <id> --cwd <dir> [--also <dir>]...
//   bun scripts/cynco-sandbox.mjs release <id>
//   bun scripts/cynco-sandbox.mjs release-dead --kind <kind> [--except <run id>]
//   bun scripts/cynco-sandbox.mjs restore-acl <id>
//   bun scripts/cynco-sandbox.mjs status
//   bun scripts/cynco-sandbox.mjs sweep
//
// The sandbox root is LOCALCODE_SANDBOX_ROOT (default C:/cynco-sandbox); it is never created
// here. `release-dead` releases only a record whose holder is gone (`holderGone`, as the sweep
// asks), and prints `[sandbox] kept <id>: ...` for each one it keeps. Lines are tagged `[sandbox]`. Exit codes: 0 done, 2 bad usage, 3 refused (or, for release and
// release-dead, a folder left labelled low: a `[sandbox] NOT SET BACK:` line on stderr; for
// restore-acl, a grant still kept: a `[sandbox] NOT PUT BACK:` line). `restore-acl` puts back the access
// list a release had to leave widened (its note names this command; the sweep keeps the run folder
// and the saved copy until then).
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  containmentRecords, establishContainment, holderGone, mintRunId, operatorRefusal, releaseContainment, releaseInProgress, restoreKeptGrants,
  sandboxLeftLowWords, sweepSandboxes,
} from '../engine/containment.js'
import { sandboxRoot } from '../engine/paths.js'

const KINDS = ['mission', 'daemon-task', 'precheck', 'grader']
export const USAGE = [
  'usage: bun scripts/cynco-sandbox.mjs mint <label>',
  '       bun scripts/cynco-sandbox.mjs create --run-id <id> --cwd <dir> [--also <dir>]...',
  '       bun scripts/cynco-sandbox.mjs release <id>',
  `       bun scripts/cynco-sandbox.mjs release-dead --kind <${KINDS.join(' | ')}> [--except <run id>]`,
  '       bun scripts/cynco-sandbox.mjs restore-acl <id>',
  '       bun scripts/cynco-sandbox.mjs status',
  '       bun scripts/cynco-sandbox.mjs sweep',
].join('\n')

/** A volume refusal of establishContainment (V1, V2, V3, S3): the setup document says what to do. */
export function isVolumeRefusal(reason) {
  return /cannot be protected by integrity labels|LOCALCODE_UNPROTECTED_VOLUMES_OK is not the root|attached volumes could not be listed|a volume without integrity labels/.test(reason)
}

/** Parse `--name value` options, repeatable ones collected. Null when an option has no value or is unknown. */
function options(args, known) {
  const out = { also: [] }
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1]
    if (!known.includes(name) || value === undefined || value === '') return null
    if (name === '--also') out.also.push(value)
    else out[name.slice(2)] = value
  }
  return out
}

/**
 * A release that found a record and left a folder labelled low: said on stderr with its own tag,
 * and the verb exits 3. The next `create` for that folder refuses while it still reads low.
 * A run id with no record is not a failure (release is idempotent and the id may be gone).
 */
function releaseFailed(r, io) {
  if (r.relabelled || r.note.startsWith('no containment record for ')) return false
  io.err(`[sandbox] NOT SET BACK: ${r.note}`)
  return true
}

/** One status line for a record. */
export function statusLine(rec) {
  const state = rec.releasedAt
    ? `released ${rec.releasedAt} (${rec.releasedBy ?? 'release'})`
    : `ACTIVE (${rec.holder ? `holder pid ${rec.holder.pid}` : 'no holder yet'})`
  // P2-B4: a grant its release could not undo is shown until restore-acl puts it back. R1 (wave 19b): while
  // another live process is still releasing the run, its grants are being put back, not kept.
  const grants = rec.grantsKept ?? []
  const releaser = grants.length ? releaseInProgress(rec) : null
  const kept = releaser !== null
    ? `  RELEASE IN PROGRESS (process ${releaser}): the access list of ${grants.map(g => g.folder).join(', ')} is put back when it ends`
    : grants.length ? `  GRANT KEPT on ${grants.map(g => g.folder).join(', ')} (restore-acl ${rec.runId})` : ''
  // C9 (wave 19): a sandbox its release left low past the set-back budget, until the sweep removes it. BB-6
  // (wave 19c): or under folders whose name ends in a dot or a space, which it did not enter; the words say which.
  const low = rec.sandboxLeftLow ? `  SANDBOX LEFT LOW ${sandboxLeftLowWords(rec.sandboxLeftLow)} (the sweep removes it)` : ''
  return `[sandbox] ${rec.runId}  ${rec.kind}  ${rec.missionCwd}  created ${rec.createdAt}  ${state}${kept}${low}`
}

/**
 * Run one verb. `io` holds `out` (stdout lines) and `err` (stderr lines). Returns the exit code.
 * Everything the verbs do goes through engine/containment.ts.
 */
export function main(argv, io = { out: l => console.log(l), err: l => console.error(l) }) {
  const [verb, ...rest] = argv
  const usage = (why) => { io.err(`[sandbox] ${why}`); io.err(USAGE); return 2 }
  const log = (line) => io.err(line)

  if (verb === 'mint') {
    if (rest.length !== 1 || rest[0] === '') return usage('mint takes one label')
    io.out(mintRunId(rest[0]))
    return 0
  }

  if (verb === 'create') {
    const o = options(rest, ['--run-id', '--cwd', '--also'])
    if (!o || !o['run-id'] || !o.cwd) return usage('create needs --run-id <id> and --cwd <dir>')
    sweepSandboxes({ log })
    const r = establishContainment({ kind: 'mission', runId: o['run-id'], missionCwd: o.cwd, extraRoots: o.also })
    if (!r.ok) {
      io.err(operatorRefusal('[sandbox]', 'containment', r.reason, 'run'))
      if (isVolumeRefusal(r.reason)) io.err('[sandbox] see docs/containment-setup.md, "Volumes that cannot be protected"')
      return 3
    }
    const c = r.containment
    const labels = c.cwdLabel === 'low'
      ? `home, tmp and scratch labelled low; mission folder ${c.missionCwd} labelled low${c.extraRoots.length ? `; also ${c.extraRoots.join(', ')}` : ''}`
      : `no integrity labels on this system; mission folder ${c.missionCwd}${c.extraRoots.length ? `; also ${c.extraRoots.join(', ')}` : ''}`
    io.err(`[sandbox] run ${c.runId}: ${c.sandbox.root} ready in ${r.ms} ms (${labels})`)
    return 0
  }

  if (verb === 'release') {
    if (rest.length !== 1 || rest[0] === '') return usage('release takes one run id')
    const r = releaseContainment(rest[0])
    io.out(`[sandbox] ${r.note}`)
    return releaseFailed(r, io) ? 3 : 0
  }

  if (verb === 'release-dead') {
    const o = options(rest, ['--kind', '--except'])
    if (!o || !KINDS.includes(o.kind)) return usage(`release-dead needs --kind <${KINDS.join(' | ')}>`)
    const due = containmentRecords().filter(rec => rec.kind === o.kind && !rec.releasedAt && rec.runId !== o.except)
    if (due.length === 0) io.out(`[sandbox] no unreleased ${o.kind} record${o.except ? ` besides ${o.except}` : ''}`)
    let failed = false
    for (const rec of due) {
      // As the sweep asks (F248 list): a live holder, or a holderless record the starter has had
      // less than 15 minutes to hand to an engine, is a run that is still going; releasing it would
      // take its mission folder's write access away under it.
      const nowMs = Date.now()
      if (!holderGone(rec, nowMs)) {
        io.out(rec.holder
          ? `[sandbox] kept ${rec.runId}: its holder ${rec.holder.pid} is alive`
          : `[sandbox] kept ${rec.runId}: it has no holder yet and was created ${Math.max(0, Math.round((nowMs - Date.parse(rec.createdAt)) / 60_000))} min ago (a starter has 15 minutes to hand it to an engine)`)
        continue
      }
      const r = releaseContainment(rec.runId)
      io.out(`[sandbox] ${r.note}`)
      if (releaseFailed(r, io)) failed = true
    }
    return failed ? 3 : 0
  }

  if (verb === 'restore-acl') {
    if (rest.length !== 1 || rest[0] === '') return usage('restore-acl takes one run id')
    const r = restoreKeptGrants(rest[0])
    io.out(`[sandbox] ${r.note}`)
    if (r.done) return 0
    io.err(r.unread
      ? `[sandbox] NOT PUT BACK: the record of ${rest[0]} could not be read, so whether it keeps a grant is not known`
      : `[sandbox] NOT PUT BACK: run ${rest[0]} still keeps a grant; run restore-acl again once what kept it is gone`)
    return 3
  }

  if (verb === 'status') {
    if (rest.length) return usage('status takes no arguments')
    const recs = containmentRecords()
    if (recs.length === 0) io.out(`[sandbox] no sandbox under ${sandboxRoot()}`)
    for (const rec of recs) io.out(statusLine(rec))
    return 0
  }

  if (verb === 'sweep') {
    if (rest.length) return usage('sweep takes no arguments')
    const r = sweepSandboxes({ log: l => io.out(l) })
    io.out(`[sandbox] sweep: ${r.removed.length} removed, ${r.kept} kept`)
    return 0
  }

  return usage(verb ? `unknown verb ${verb}` : 'no verb given')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
