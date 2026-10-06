import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createProject, readJournal } from '../../projects/layout.js'
import { ensureHistory, commitHistory } from '../../projects/history.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-history-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('invisible history', () => {
  it('initialises a repo once and commits the paths it is given', async () => {
    const meta = createProject(home, { name: 'H' })
    const dir = join(home, meta.slug)
    await ensureHistory(dir)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    await ensureHistory(dir) // idempotent
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n', 'utf8')
    const r = await commitHistory(dir, ['knowledge/a.md', 'journal.md'], 'knowledge: add a.md')
    expect(r).toEqual({ ok: true })
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' })
    expect(log.trim().split('\n')[0]).toBe('knowledge: add a.md')
    // .cynco/ is ignored
    writeFileSync(join(dir, '.cynco', 'index', 'project.db'), 'x', 'utf8')
    const status = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: dir, encoding: 'utf8' })
    expect(status).toMatch(/!! \.cynco\//)
  })
  it('never throws: a non-repo dir reports the failure and journals it', async () => {
    const meta = createProject(home, { name: 'NoRepo' })
    const dir = join(home, meta.slug)
    const r = await commitHistory(dir, ['journal.md'], 'x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a git repository|fatal/i)
    expect(readJournal(dir)[0]).toMatchObject({ event: 'history.failed' })
  })
  it('a commit with nothing staged is ok (nothing to record is not a failure)', async () => {
    const meta = createProject(home, { name: 'Empty' })
    const dir = join(home, meta.slug)
    await ensureHistory(dir)
    await commitHistory(dir, ['journal.md'], 'first')
    const r = await commitHistory(dir, ['journal.md'], 'again, unchanged')
    expect(r).toEqual({ ok: true })
  })
})
