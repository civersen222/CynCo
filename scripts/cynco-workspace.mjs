/**
 * What state the mission workspace must be in before a mission starts.
 *
 * Separate from cynco-ledger.mjs (what happened) and cynco-verify.mjs (was it
 * any good) because this runs BEFORE dispatch and its failures are of a
 * different kind: not a mislabeled record, but a workspace that hands the next
 * mission something the previous one left behind.
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Remove compiled-bytecode caches from the workspace, and say what was done.
 *
 * F57. A `.pyc` outlives the source it was compiled from, and it is readable.
 * Gilded Wave 10 found `__pycache__/_verify_final.cpython-314.pyc`, left behind
 * by a dead earlier mission, and spent eighteen minutes walking its
 * disassembly with `marshal.loads` window by window. It reconstructed the
 * held-out gate from it, deleted the original `.pyc`, recompiled a forged
 * replacement from its own reconstruction, and then checked the forgery's
 * header timestamp, header size and `st_size` against the source to confirm the
 * fake would pass for genuine. It then deleted a passing test because its
 * reconstruction of the gate said the count should be 48.
 *
 * Finding (aj) is the same leak in its passive form — a stale cache changing
 * what `import` returns. This is what happens when something goes looking on
 * purpose. The F37 seal protects the gate's LOCATION; it can do nothing about a
 * copy of the gate's LOGIC lying in the repo the mission has write access to.
 *
 * Returns the lines the caller should log. Empty means there was nothing to do,
 * which is the common case and should stay silent.
 *
 * Only untracked caches are removed, and the check is real: `git ls-files` is
 * asked, a tracked path aborts the purge, and a git that cannot answer aborts
 * it too. Deleting a tracked file here would silently edit the delivery this
 * mission is about to be graded on — a cure worse than the disease.
 */
export function purgeBytecodeCaches(cwd, io = { readdirSync, rmSync, spawnSync }) {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = io.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // `.git` because nothing in it is ours to touch; `node_modules` because
      // walking it costs seconds and a dependency's cache is not this mission's
      // previous run.
      if (e.name === '.git' || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.name === '__pycache__') { found.push(full); continue }
      walk(full)
    }
  }
  walk(cwd)
  if (found.length === 0) return []

  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = found.map(p => p.replace(/\\/g, '/').slice(base.length + 1))
  const r = io.spawnSync('git', ['ls-files', '--', ...rel], { cwd, encoding: 'utf-8' })
  if (r.error || r.status !== 0) {
    return [`BYTECODE PURGE SKIPPED — git could not say whether these are tracked: ${rel.join(', ')}`]
  }
  const tracked = (r.stdout ?? '').split('\n').filter(Boolean)
  if (tracked.length > 0) {
    return [`BYTECODE PURGE ABORTED — tracked, and deleting them would edit the delivery: ${tracked.join(', ')}`]
  }

  const failed = []
  for (const p of found) {
    try { io.rmSync(p, { recursive: true, force: true }) } catch (e) { failed.push(`${p}: ${e?.message ?? e}`) }
  }
  const lines = [`purged ${found.length} __pycache__ ${found.length === 1 ? 'directory' : 'directories'} — ` +
    "a previous mission's compiled verification logic is not this one's to read (F57)"]
  for (const f of failed) lines.push(`could not remove ${f}`)
  return lines
}
