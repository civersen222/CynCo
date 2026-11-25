// scripts/cynco-guard.mjs
// The command line over the integrity layer of unattended runs (F242; engine/integrity.ts).
//
// The starter of a run takes the integrity baseline with `pre` before its engine starts and settles
// it with `post` once the engine is confirmed dead; a change writes the integrity latch in the guard
// folder (LOCALCODE_GUARD_DIR, default C:/cynco-guard), pages the owner, and stops every unattended
// starter until the owner types `clear` at a terminal. `status --quiet` is what the service script
// asks before it starts the daemon: one line, no network, exit 0 or 3.
//
//   bun scripts/cynco-guard.mjs status [--quiet]
//   bun scripts/cynco-guard.mjs pre <runId> (--cwd <dir> | --no-cwd) [--also <dir>]... [--by <who>] [--max-seconds <n>] [--holder-pid <pid>]
//   bun scripts/cynco-guard.mjs post <runId> [--by <who>] [--engine-not-confirmed-dead <why>]
//   bun scripts/cynco-guard.mjs hash-models [--all]
//   bun scripts/cynco-guard.mjs verify [--deep]
//   bun scripts/cynco-guard.mjs clear
//
// Lines are tagged `[guard]`. Exit codes: 0 done; 2 bad usage; 3 a refusal, a change, a latch or a
// mismatch. This script starts no process and never creates the guard folder itself.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { operatorRefusal } from '../engine/containment.js'
import { guardDir, modelsDir } from '../engine/paths.js'
import {
  checkModelsRecord, clearHalt, flushUnsentPages, haltRefusal, haltState, hashModels, LATCH_FILE, ManifestError,
  openBaselines, orphanedBaselines, orphanRefusal, readModelsRecord, settleRun, takeBaseline, verifyModelsDeep,
} from '../engine/integrity.js'

export const USAGE = [
  'usage: bun scripts/cynco-guard.mjs status [--quiet]',
  '       bun scripts/cynco-guard.mjs pre <runId> (--cwd <dir> | --no-cwd) [--also <dir>]... [--by <who>] [--max-seconds <n>] [--holder-pid <pid>]',
  '       bun scripts/cynco-guard.mjs post <runId> [--by <who>] [--engine-not-confirmed-dead <why>]',
  '       bun scripts/cynco-guard.mjs hash-models [--all]',
  '       bun scripts/cynco-guard.mjs verify [--deep]',
  '       bun scripts/cynco-guard.mjs clear',
].join('\n')

/**
 * Splits `rest` into positionals and flags. `spec` names each flag and whether it takes a value and
 * may repeat. Returns null on an unknown flag or a flag without its value.
 */
function parse(rest, spec) {
  const pos = []
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const s = spec[a]
    if (!s) return null
    if (!s.value) { flags[a] = true; continue }
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) return null
    i++
    if (s.many) (flags[a] ??= []).push(v)
    else if (flags[a] !== undefined) return null
    else flags[a] = v
  }
  return { pos, flags }
}

function readLine(input) {
  return new Promise(res => {
    const rl = createInterface({ input, terminal: false })
    let done = false
    rl.once('line', l => { done = true; rl.close(); res(l) })
    rl.once('close', () => { if (!done) res('') })
  })
}

function tail(file, n) {
  try {
    return readFileSync(file, 'utf-8').split(/\r?\n/).filter(l => l.trim() !== '').slice(-n)
  } catch (e) {
    return e?.code === 'ENOENT' ? [] : [`(could not be read: ${e?.code ?? e?.message ?? e})`]
  }
}

function unsentPages(guard) {
  try {
    return readdirSync(join(guard, 'unsent')).filter(n => n.endsWith('.json')).sort()
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? [] : null
  }
}

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 120) return `${s} s`
  if (s < 7200) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

function printLatch(st, out) {
  if (st.state !== 'latched') return
  const l = st.latch
  out(`[guard] latch file: ${st.latchPath}`)
  if (!l) { out('[guard] the latch record cannot be read; it stands all the same'); return }
  out(`[guard] set ${l.at} by ${l.by} (pid ${l.pid} on ${l.host}), run ${l.run}, reason ${l.reason}${l.detail ? ` (${l.detail})` : ''}`)
  if (l.campaignId || l.wave !== null || l.cwd) out(`[guard] campaign ${l.campaignId ?? '-'}, wave ${l.wave ?? '-'}, folder ${l.cwd ?? '-'}`)
  out(`[guard] ${l.summary}`)
  for (const c of (l.changes ?? []).slice(0, 10)) {
    out(`[guard]   ${c.class} ${c.path ? `${c.root}/${c.path}` : c.root} ${c.kind}${c.detail ? ` (${c.detail})` : ''}`)
  }
  if (l.changeCount > 10) out(`[guard]   ... and ${l.changeCount - 10} more`)
  if (l.baseline) out(`[guard] baseline: ${l.baseline}`)
}

function printBaselines(guard, out, withPost) {
  let open
  try {
    open = openBaselines(guard)
  } catch (e) {
    out(`[guard] ${e?.message ?? e}`)
    return
  }
  if (open.length === 0) { out('[guard] open baselines: none'); return }
  for (const b of open) {
    const line = `[guard] open baseline ${b.runId}: taken ${b.takenAt} by ${b.by}, ${ago(b.ageMs)} ago`
    out(withPost ? `${line}; if that run is not running, compare it BEFORE you change anything: bun scripts/cynco-guard.mjs post ${b.runId}` : line)
  }
}

/** The orphaned baselines, and the run of a not-confirmed-dead latch, are compared at `clear` with no page. */
async function settleAtClear(guard, guardArg, latch, out, err, page) {
  let orphans = []
  try {
    orphans = orphanedBaselines(guard)
  } catch (e) {
    err(`[guard] ${e?.message ?? e}; no open baseline was compared`)
    return
  }
  const runs = new Map(orphans.map(o => [o.runId, o.why]))
  if (latch?.reason === 'engine-not-confirmed-dead' && latch.run && !runs.has(latch.run)) {
    let open = []
    try { open = openBaselines(guard) } catch (e) { err(`[guard] ${e?.message ?? e}`) }
    if (open.some(b => b.runId === latch.run)) runs.set(latch.run, 'the latch you cleared said its engine was not confirmed dead')
  }
  for (const [runId, why] of runs) {
    const c = await settleRun(runId, { by: 'the owner, at clear', page, guard: guardArg, noLatch: true })
    if (!c.changed) out(`[guard] run ${runId} (${why}): compared now, no change in protected folders; its baseline is closed`)
    else {
      out(`[guard] run ${runId} (${why}): compared now, ${c.summary}`)
      for (const ch of (c.changes ?? []).slice(0, 10)) out(`[guard]   ${ch.class} ${ch.path ? `${ch.root}/${ch.path}` : ch.root} ${ch.kind}${ch.detail ? ` (${ch.detail})` : ''}`)
      out(c.settled ? `[guard] nothing was latched: you are at the desk; look at these before the next run` : `[guard] its baseline could not be closed; bun scripts/cynco-guard.mjs post ${runId} compares it again`)
    }
  }
}

/**
 * `deps`: `{ env, guard, home, stdin, out, err, page, now }`, each defaulting to the process's, plus
 * two test seams: `fetch` (what the default sender posts with) and `volumes` (the volume listing
 * `pre` would otherwise run).
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env
  const out = deps.out ?? (l => console.log(l))
  const err = deps.err ?? (l => console.error(l))
  const now = deps.now ?? (() => new Date())
  const stdin = deps.stdin ?? process.stdin
  const home = deps.home
  // Undefined lets the integrity module name LOCALCODE_GUARD_DIR in its refusal.
  const guardArg = deps.guard ?? (deps.env ? guardDir(deps.env) : undefined)
  const guard = guardArg ?? guardDir()
  const page = deps.page ?? (async p => {
    const { notify } = await import('./cynco-campaign-verdict.mjs')
    return notify(p.message, env, deps.fetch ?? globalThis.fetch, { title: p.title, priority: p.priority })
  })
  const usage = (why) => { err(`[guard] ${why}`); err(USAGE); return 2 }

  const [verb, ...rest] = argv

  if (verb === 'status') {
    const a = parse(rest, { '--quiet': {} })
    if (!a || a.pos.length) return usage('status takes only --quiet')
    const why = haltRefusal(guardArg, home)
    out(why ?? 'clear')
    // --quiet answers the latch alone: the service script asks it before it starts the daemon, and the
    // daemon is what compares an orphaned baseline.
    if (a.flags['--quiet']) return why ? 3 : 0
    const st = haltState(guardArg, home)
    printLatch(st, out)
    printBaselines(guard, out, false)
    const orphan = orphanRefusal(guard)
    if (orphan) out(`[guard] ${orphan}`)
    const unsent = unsentPages(guard)
    out(unsent === null ? '[guard] unsent pages: the folder cannot be listed' : `[guard] unsent pages: ${unsent.length}`)
    const checks = tail(join(guard, 'checks.jsonl'), 5)
    out(checks.length ? '[guard] last checks:' : '[guard] last checks: none')
    for (const l of checks) out(`[guard]   ${l}`)
    // Wave 15 (NOW.md:67): the allowance notes of those checks, one line each, readable.
    for (const l of checks) {
      let line
      try { line = JSON.parse(l) } catch { continue } // a line that is not JSON was printed as it is above
      for (const n of Array.isArray(line?.allowed) ? line.allowed : []) out(`[guard] allowed in the ${line.kind} of run ${line.run}: ${n}`)
    }
    const models = checkModelsRecord({ guard: guardArg })
    if (models === null) {
      const r = readModelsRecord(guard)
      out(`[guard] models record: ok (${r?.files.length ?? 0} files, taken ${r?.taken ?? '?'})`)
    } else {
      out(`[guard] models record: ${models}`)
    }
    if (env.CYNCO_NTFY_URL) {
      // Re-sending moves files; nothing is moved in a folder that cannot be used.
      if (st.state === 'unusable') {
        out('[guard] unsent pages were not re-sent: the guard folder cannot be used')
      } else {
        const f = await flushUnsentPages(guard, page)
        out(`[guard] re-sent ${f.sent} page(s), ${f.left} left`)
      }
    }
    return why ? 3 : 0
  }

  if (verb === 'pre') {
    const a = parse(rest, { '--cwd': { value: true }, '--no-cwd': {}, '--also': { value: true, many: true }, '--by': { value: true }, '--max-seconds': { value: true }, '--holder-pid': { value: true } })
    // --no-cwd (wave 15): the daemon's task that names no folder; its run is refused later, when no sandbox can be made for it.
    if (!a || a.pos.length !== 1 || (!a.flags['--cwd']) === (a.flags['--no-cwd'] !== true)) return usage('pre needs <runId> and either --cwd <dir> or --no-cwd')
    const runId = a.pos[0]
    const maxS = a.flags['--max-seconds'] === undefined ? undefined : Number(a.flags['--max-seconds'])
    if (maxS !== undefined && !(Number.isInteger(maxS) && maxS > 0)) return usage('--max-seconds takes a whole number of seconds above 0')
    // --holder-pid (wave 15): the process that will settle this baseline when it is not this one (the daemon).
    const holder = a.flags['--holder-pid'] === undefined ? undefined : Number(a.flags['--holder-pid'])
    if (holder !== undefined && !(Number.isInteger(holder) && holder > 0)) return usage('--holder-pid takes a process id above 0')
    try {
      const r = takeBaseline({
        runId, cwd: a.flags['--cwd'] ?? null, also: a.flags['--also'] ?? [], by: a.flags['--by'] ?? 'cynco-guard pre',
        guard: guardArg, home, now, ...(deps.volumes ? { volumes: deps.volumes } : {}),
        ...(maxS !== undefined ? { maxRunMs: maxS * 1000 } : {}),
        ...(holder !== undefined ? { holderPid: holder } : {}),
      })
      out(`[guard] integrity baseline ${r.runId}: ${r.frozenEntries} frozen entries, ${r.presenceEntries} presence entries, ${r.ms} ms`)
      for (const n of r.notes) out(`[guard] note: ${n}`)
      return 0
    } catch (e) {
      const msg = e?.message ?? String(e)
      const reason = e instanceof ManifestError && e.kind === 'refusal' ? msg : `no integrity baseline could be taken (${msg})`
      err(operatorRefusal('[guard]', 'integrity', reason, 'dispatched'))
      return 3
    }
  }

  if (verb === 'post') {
    const a = parse(rest, { '--by': { value: true }, '--engine-not-confirmed-dead': { value: true } })
    if (!a || a.pos.length !== 1) return usage('post needs <runId>')
    const runId = a.pos[0]
    const dead = a.flags['--engine-not-confirmed-dead']
    // The settle runs all the same (a change must still latch); the log says why the folder is wrong.
    const st = haltState(guardArg, home)
    if (st.state === 'unusable') err(`[guard] ${st.summary}`)
    const c = await settleRun(runId, { by: a.flags['--by'] ?? 'cynco-guard post', page, guard: guardArg, notConfirmedDead: dead, now })
    if (dead !== undefined) {
      out(`[guard] INTEGRITY: the engine of run ${runId} is not confirmed dead (${dead}); the integrity latch is set and the baseline stays open`)
      if (c.latchPath) out(`[guard] latch: ${c.latchPath}`)
      return 3
    }
    // Wave 15 (NOW.md:67): what the allowance let pass (APPDATA_LOSS_AT) is said here, not only in checks.jsonl.
    const allowed = () => { for (const n of c.allowed ?? []) out(`[guard] allowed: ${n}`) }
    if (!c.changed) {
      out(`[guard] integrity unchanged for ${runId} (${c.entries} entries, ${c.ms} ms)`)
      allowed()
      return 0
    }
    out(`[guard] INTEGRITY: ${c.summary}`)
    out(`[guard] latch: ${c.latchPath ?? join(guard, LATCH_FILE)}`)
    allowed()
    return 3
  }

  if (verb === 'hash-models') {
    const a = parse(rest, { '--all': {} })
    if (!a || a.pos.length) return usage('hash-models takes only --all')
    const st = haltState(guardArg, home)
    if (st.state === 'unusable') { err(`[guard] the models record was not written: ${st.summary}`); return 3 }
    out(`[guard] models folder: ${resolve(modelsDir())}`)
    try {
      const r = await hashModels({ guard: guardArg, all: a.flags['--all'] === true, onFile: (rel, bytes) => out(`[guard] hashing ${rel} (${bytes} bytes)`) })
      const bytes = r.files.reduce((n, f) => n + f.bytes, 0)
      out(`[guard] models record written: ${r.files.length} files, ${bytes} bytes, ${join(guard, 'models-hashes.json')}`)
      return 0
    } catch (e) {
      err(`[guard] the models record was not written: ${e?.message ?? e}`)
      return 3
    }
  }

  if (verb === 'verify') {
    const a = parse(rest, { '--deep': {} })
    if (!a || a.pos.length) return usage('verify takes only --deep')
    const why = checkModelsRecord({ guard: guardArg })
    if (why !== null) { out(`[guard] models record: ${why}`); return 3 }
    if (a.flags['--deep']) {
      const r = await verifyModelsDeep({ guard: guardArg })
      if (!r.ok) {
        out(`[guard] models record: ${r.mismatches.length} file(s) do not match`)
        for (const m of r.mismatches) out(`[guard]   ${m.rel}: ${m.why}`)
        return 3
      }
    }
    out('[guard] models record: ok')
    return 0
  }

  if (verb === 'clear') {
    if (rest.length) return usage('clear takes no arguments')
    const st = haltState(guardArg, home)
    printLatch(st, out)
    const log = tail(join(guard, 'halt-log.jsonl'), 5)
    out(log.length ? '[guard] last latch log lines:' : '[guard] latch log: empty')
    for (const l of log) out(`[guard]   ${l}`)
    const unsent = unsentPages(guard)
    if (unsent === null) out('[guard] unsent pages: the folder cannot be listed')
    else {
      out(`[guard] unsent pages: ${unsent.length}`)
      for (const n of unsent) out(`[guard]   ${join(guard, 'unsent', n)}`)
    }
    printBaselines(guard, out, true)
    if (st.state !== 'latched') {
      out(st.state === 'clear' ? '[guard] there is no integrity latch; nothing was changed' : `[guard] ${st.summary}; nothing was changed`)
      return st.state === 'clear' ? 0 : 3
    }
    if (!stdin || stdin.isTTY !== true) {
      err('[guard] clear needs a person at a terminal; nothing was changed')
      err('[guard] (its input is not a console here: in a Git Bash window run it as winpty bun scripts/cynco-guard.mjs clear, or run it from PowerShell or Windows Terminal)')
      return 3
    }
    out('Type CLEAR to remove the integrity latch:')
    const answer = (await readLine(stdin)).trim()
    if (answer !== 'CLEAR') { err('[guard] nothing was changed'); return 3 }
    // The only caller of clearHalt; it checks the terminal and the typed word again itself.
    try {
      const r = clearHalt(guard, { by: 'the owner, at a terminal (cynco-guard clear)', now, terminal: stdin, typed: answer })
      if (!r.cleared) { out('[guard] the latch was already gone; nothing was changed'); return 0 }
      if (r.pagesWithdrawn) out(`[guard] ${r.pagesWithdrawn} unsent page(s) about this latch withdrawn (kept in ${join(guard, 'cleared', 'pages')})`)
      await settleAtClear(guard, guardArg, r.latch, out, err, page)
      out(`[guard] cleared; the latch is kept at ${r.archivedTo}`)
      return 0
    } catch (e) {
      err(`[guard] the latch could not be cleared (${e?.code ?? e?.message ?? e}); it stands`)
      return 3
    }
  }

  return usage(verb ? `unknown verb ${verb}` : 'no verb given')
}

// bun sets import.meta.main; node 24 does too. The argv comparison is the
// fallback for a runtime that sets neither, and fileURLToPath is the only
// correct file:// → Windows path conversion.
const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => { console.error(`[guard] ${e?.stack ?? e}`); process.exit(1) })
}
