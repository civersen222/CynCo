/**
 * engine/projects/history.ts — git underneath a project, invisible.
 *
 * Every write to a project is followed by a commit with a generated message.
 * The commit never blocks the write and never throws: a failure is journaled
 * as `history.failed` with git's stderr and reported to the caller. Commits
 * for one folder are serialised through a per-dir promise chain so two
 * writes in the same tick cannot race `git add`.
 *
 * Async `execFile`, not `spawnSync`: bun's spawnSync can carry a stale
 * deadline into a later call (F155).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendJournal } from './layout.js'

const GIT_TIMEOUT_MS = 15_000
const queues = new Map<string, Promise<unknown>>()

function git(dir: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise(resolve => {
    execFile('git', args, { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, reason: (stderr || err.message).trim() })
      else resolve({ ok: true, stdout: String(stdout) })
    })
  })
}

function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(dir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(dir, next.catch(() => undefined))
  return next
}

export async function ensureHistory(dir: string): Promise<void> {
  await serial(dir, async () => {
    if (existsSync(join(dir, '.git'))) return
    const init = await git(dir, ['init', '-q'])
    if (!init.ok) { appendJournal(dir, 'history.failed', `git init: ${init.reason}`); return }
    await git(dir, ['config', 'user.email', 'cynco@localhost'])
    await git(dir, ['config', 'user.name', 'CynCo'])
  })
}

export async function commitHistory(dir: string, paths: string[], message: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  return serial(dir, async () => {
    const add = await git(dir, ['add', '--', ...paths])
    if (!add.ok) { appendJournal(dir, 'history.failed', `git add: ${add.reason}`); return { ok: false, reason: add.reason } }
    const staged = await git(dir, ['diff', '--cached', '--quiet'])
    if (staged.ok) return { ok: true } // exit 0: nothing staged, nothing to record
    const commit = await git(dir, ['commit', '-q', '-m', message])
    if (!commit.ok) { appendJournal(dir, 'history.failed', `git commit: ${commit.reason}`); return { ok: false, reason: commit.reason } }
    return { ok: true }
  })
}
