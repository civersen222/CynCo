// The progress probe's fixture repo (Phase 6 Task 3): a real git repo under a
// temp dir whose commits carry different `progress.txt` contents, graded by
// ./gate_p.py. Each entry of `contents` becomes one commit, in order; the
// shas come back in the same order. Nothing here touches a live home or repo.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const PROGRESS_GATE = fileURLToPath(new URL('./gate_p.py', import.meta.url))

const git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error?.message}`)
  return r.stdout.trim()
}

const built = []

/** Remove every repo buildProgressRepo made in this process (a test's afterAll). */
export function removeProgressRepos() {
  for (const dir of built.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function buildProgressRepo(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-progress-repo-'))
  built.push(dir)
  git(dir, ['init', '-q'])
  const shas = []
  for (const [i, text] of contents.entries()) {
    writeFileSync(join(dir, 'progress.txt'), text)
    git(dir, ['add', 'progress.txt'])
    git(dir, ['commit', '-q', '--allow-empty', '-m', `progress ${i}`])
    shas.push(git(dir, ['rev-parse', 'HEAD']))
  }
  return { dir, shas }
}
