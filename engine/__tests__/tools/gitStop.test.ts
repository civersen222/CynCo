/**
 * The Git tool and the turn's abort signal (F201, F210; review finding of slice S2).
 *
 * Since slice S2 the Git tool runs the mission's own git with the repository's own hooks and
 * settings, by design (it is the run's git, started contained). So a hook, a filter or a program a
 * setting names can hold the call: before this, the tool took no signal, had no cap and did not own
 * what it started, and a hook that never returned held the turn with no Stop. Here a pre-commit hook
 * starts a node process that writes its pid at once and a marker after LATE_MS. Stopped or timed
 * out, the call returns long before that and the process is dead. And a commit with no message
 * waits on no editor.
 *
 * Wave 24 (F255): the hook's process carries a mark in its command line (an extra argument of late.js) and
 * "gone" is asked of the mark, never of the number alone: a pid whose process has ended may be given to
 * another process, which `process.kill(pid, 0)` would answer for. A watcher asks for the mark while the call
 * runs, and each case asserts it saw the process's pid carrying it, so "gone" is never the answer of a mark
 * that named nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTool } from '../../tools/impl/git.js'
import { endMarked, goneWithin, newMark, watchMarked, type MarkWatch } from '../helpers/markedProcesses.js'

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0
const LATE_MS = 60_000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const PINNED = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_EDITOR', 'CYNCO_BASH_TIMEOUT_MS', 'CYNCO_CHECK_TIMEOUT_MS']
const saved: Record<string, string | undefined> = {}
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cynco-git-stop-'))
  writeFileSync(join(root, 'gitconfig-global'), '')
  for (const k of PINNED) saved[k] = process.env[k]
  for (const k of PINNED) delete process.env[k]
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig-global'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'git stop test', GIT_AUTHOR_EMAIL: 'stop@localhost',
    GIT_COMMITTER_NAME: 'git stop test', GIT_COMMITTER_EMAIL: 'stop@localhost',
  })
})

afterAll(() => {
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const marks: string[] = []
const watches: MarkWatch[] = []
/** A mark for one case's late process, and a watcher already listing for it. */
async function marking(label: string): Promise<{ mark: string; watch: MarkWatch }> {
  const mark = newMark(label)
  marks.push(mark)
  const watch = watchMarked(mark)
  watches.push(watch)
  await watch.ready
  return { mark, watch }
}
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop().catch(() => undefined)
  // A survivor (the defect) is ended by its mark, so the suite does not leave it running.
  for (const m of marks.splice(0)) endMarked(m)
})

/** A repository with one staged file and a pre-commit hook that starts the late process, which carries `mark`. */
function repoWithSlowHook(name: string, mark = ''): string {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) => expect(spawnSync('git', args, { cwd: repo, encoding: 'utf-8' }).status).toBe(0)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'late.js'),
    `require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => require('fs').writeFileSync('marker.txt', 'x'), ${LATE_MS})\n`)
  writeFileSync(join(repo, '.gitignore'), 'pid.txt\nmarker.txt\n')
  git('add', '-A')
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nnode late.js ${mark}\n`, { mode: 0o755 })
  return repo
}

async function waitFor<T>(read: () => T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = read()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(25)
  }
}
const hookPid = (cwd: string) => waitFor(() => {
  if (!existsSync(join(cwd, 'pid.txt'))) return 0
  const n = Number(readFileSync(join(cwd, 'pid.txt'), 'utf-8'))
  return Number.isInteger(n) && n > 0 ? n : 0
}, 'the hook to start its child')
/** The hook's process, seen carrying its mark while it ran, is gone (asked of the mark, never of the number alone). */
async function gone(pid: number, mark: string, watch: MarkWatch): Promise<void> {
  const seen = await watch.stop()
  expect(seen, `the hook's process ${pid} was never seen carrying its mark while it ran (${JSON.stringify(seen)})`).toContain(pid)
  expect(await goneWithin(pid, mark, 10_000), `pid ${pid} is still the hook's process that carries its mark`).toBe(true)
}

describe.skipIf(!HAS_GIT)('the Git tool, Stop and its cap', () => {
  it('a Stop while a hook runs returns at once, says stopped, and kills what the hook started', async () => {
    const { mark, watch } = await marking('gitStopStop')
    const repo = repoWithSlowHook('stop', mark)
    const ac = new AbortController()
    const call = gitTool.execute({ subcommand: 'commit', args: '-m "held by a hook"' }, repo, ac.signal)
    const pid = await hookPid(repo)
    // Stopped once the watcher has seen it running: the process lives long enough to be seen.
    await watch.saw(pid, 15_000)
    const stoppedAt = Date.now()
    ac.abort()
    const result = await call
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/^git commit stopped/)
    expect(Date.now() - stoppedAt).toBeLessThan(LATE_MS / 2)
    await gone(pid, mark, watch)
    expect(existsSync(join(repo, 'marker.txt'))).toBe(false)
  }, 60_000)

  it('a hook that outlives the cap is ended by it, and the result says timeout', async () => {
    // The hook's process lives about two seconds before the cap ends it: several of the watcher's listings.
    const { mark, watch } = await marking('gitStopCap')
    const repo = repoWithSlowHook('cap', mark)
    process.env.CYNCO_BASH_TIMEOUT_MS = '3000'
    try {
      const call = gitTool.execute({ subcommand: 'commit', args: '-m "held by a hook"' }, repo, new AbortController().signal)
      const pid = await hookPid(repo)
      const result = await call
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/^git commit timeout after 3000ms/)
      await gone(pid, mark, watch)
    } finally {
      delete process.env.CYNCO_BASH_TIMEOUT_MS
    }
  }, 60_000)

  it('a call asked for after the Stop is not started', async () => {
    // Marked like the others: if a regression did start the commit, its hook's program would be ended after the case.
    const { mark } = await marking('gitStopAfterStop')
    const repo = repoWithSlowHook('after-stop', mark)
    const ac = new AbortController()
    ac.abort()
    const result = await gitTool.execute({ subcommand: 'commit', args: '-m "never"' }, repo, ac.signal)
    expect(result.output).toMatch(/stopped/)
    expect(existsSync(join(repo, 'pid.txt'))).toBe(false)
  })

  it('a commit with no message is refused at once instead of waiting on an editor', async () => {
    const repo = join(root, 'no-message')
    mkdirSync(repo, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    spawnSync('git', ['add', 'a.txt'], { cwd: repo })
    const t0 = Date.now()
    const result = await gitTool.execute({ subcommand: 'commit' }, repo, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/Aborting commit due to empty commit message/)
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 30_000)
})
