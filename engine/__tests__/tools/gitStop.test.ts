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
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTool } from '../../tools/impl/git.js'

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

/** A repository with one staged file and a pre-commit hook that starts the late process. */
function repoWithSlowHook(name: string): string {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) => expect(spawnSync('git', args, { cwd: repo, encoding: 'utf-8' }).status).toBe(0)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'late.js'),
    `require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => require('fs').writeFileSync('marker.txt', 'x'), ${LATE_MS})\n`)
  writeFileSync(join(repo, '.gitignore'), 'pid.txt\nmarker.txt\n')
  git('add', '-A')
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnode late.js\n', { mode: 0o755 })
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
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = (pid: number) => waitFor(() => !alive(pid), `pid ${pid} to be gone`, 10_000)

describe.skipIf(!HAS_GIT)('the Git tool, Stop and its cap', () => {
  it('a Stop while a hook runs returns at once, says stopped, and kills what the hook started', async () => {
    const repo = repoWithSlowHook('stop')
    const ac = new AbortController()
    const call = gitTool.execute({ subcommand: 'commit', args: '-m "held by a hook"' }, repo, ac.signal)
    const pid = await hookPid(repo)
    const stoppedAt = Date.now()
    ac.abort()
    const result = await call
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/^git commit stopped/)
    expect(Date.now() - stoppedAt).toBeLessThan(LATE_MS / 2)
    await gone(pid)
    expect(existsSync(join(repo, 'marker.txt'))).toBe(false)
  }, 60_000)

  it('a hook that outlives the cap is ended by it, and the result says timeout', async () => {
    const repo = repoWithSlowHook('cap')
    process.env.CYNCO_BASH_TIMEOUT_MS = '3000'
    try {
      const call = gitTool.execute({ subcommand: 'commit', args: '-m "held by a hook"' }, repo, new AbortController().signal)
      const pid = await hookPid(repo)
      const result = await call
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/^git commit timeout after 3000ms/)
      await gone(pid)
    } finally {
      delete process.env.CYNCO_BASH_TIMEOUT_MS
    }
  }, 60_000)

  it('a call asked for after the Stop is not started', async () => {
    const repo = repoWithSlowHook('after-stop')
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
