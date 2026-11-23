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
//   bun scripts/cynco-sandbox.mjs status
//   bun scripts/cynco-sandbox.mjs sweep
//
// The sandbox root is LOCALCODE_SANDBOX_ROOT (default C:/cynco-sandbox); it is never created
// here. Lines are tagged `[sandbox]`. Exit codes: 0 done, 2 bad usage, 3 refused (or, for release and
// release-dead, a folder left labelled low: a `[sandbox] NOT SET BACK:` line on stderr).
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  containmentRecords, establishContainment, mintRunId, operatorRefusal, releaseContainment, sweepSandboxes,
} from '../engine/containment.js'
import { sandboxRoot } from '../engine/paths.js'

const KINDS = ['mission', 'daemon-task', 'precheck', 'grader']
export const USAGE = [
  'usage: bun scripts/cynco-sandbox.mjs mint <label>',
  '       bun scripts/cynco-sandbox.mjs create --run-id <id> --cwd <dir> [--also <dir>]...',
  '       bun scripts/cynco-sandbox.mjs release <id>',
  `       bun scripts/cynco-sandbox.mjs release-dead --kind <${KINDS.join(' | ')}> [--except <run id>]`,
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
  return `[sandbox] ${rec.runId}  ${rec.kind}  ${rec.missionCwd}  created ${rec.createdAt}  ${state}`
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
      const r = releaseContainment(rec.runId)
      io.out(`[sandbox] ${r.note}`)
      if (releaseFailed(r, io)) failed = true
    }
    return failed ? 3 : 0
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
