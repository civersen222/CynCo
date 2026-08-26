import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { purgeStaleAgentState, AGENT_STATE_FILES } from '../cynco-workspace.mjs'

let repo

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ws-repo-'))
  spawnSync('git', ['init'], { cwd: repo })
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repo })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('purgeStaleAgentState', () => {
  it('removes untracked scratch files and says so', () => {
    for (const f of AGENT_STATE_FILES) writeFileSync(join(repo, f), 'stale\n')
    const lines = purgeStaleAgentState(repo)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('.cynco-plan.md')
    expect(lines[0]).toContain('.cynco-state.md')
    expect(lines[0]).toContain('F129')
    for (const f of AGENT_STATE_FILES) expect(existsSync(join(repo, f))).toBe(false)
  })

  it('stays silent when there is nothing to purge', () => {
    expect(purgeStaleAgentState(repo)).toEqual([])
  })

  it('removes only the file that exists', () => {
    writeFileSync(join(repo, '.cynco-state.md'), 'stale\n')
    const lines = purgeStaleAgentState(repo)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('.cynco-state.md')
    expect(lines[0]).not.toContain('.cynco-plan.md')
    expect(existsSync(join(repo, '.cynco-state.md'))).toBe(false)
  })

  it('aborts without deleting when a scratch file is tracked', () => {
    writeFileSync(join(repo, '.cynco-plan.md'), 'committed on purpose\n')
    spawnSync('git', ['add', '.cynco-plan.md'], { cwd: repo })
    spawnSync('git', ['commit', '-m', 'track it'], { cwd: repo })
    const lines = purgeStaleAgentState(repo)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ABORTED')
    expect(existsSync(join(repo, '.cynco-plan.md'))).toBe(true)
  })

  it('skips when git cannot answer the tracked question', () => {
    writeFileSync(join(repo, '.cynco-plan.md'), 'stale\n')
    const io = {
      existsSync,
      rmSync,
      spawnSync: () => ({ status: 128, stdout: '' }),
    }
    const lines = purgeStaleAgentState(repo, io)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('SKIPPED')
    expect(existsSync(join(repo, '.cynco-plan.md'))).toBe(true)
  })

  it('reports a file it could not remove instead of throwing', () => {
    writeFileSync(join(repo, '.cynco-plan.md'), 'stale\n')
    const io = {
      existsSync,
      spawnSync,
      rmSync: () => { throw new Error('EBUSY') },
    }
    const lines = purgeStaleAgentState(repo, io)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('EBUSY')
  })
})
