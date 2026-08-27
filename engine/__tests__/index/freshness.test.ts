import { describe, it, expect, afterEach } from 'bun:test'
import { ProjectIndexer } from '../../index/indexer.js'
import { IndexStore } from '../../index/store.js'
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })

async function gitProject(): Promise<{ root: string; indexer: ProjectIndexer }> {
  const root = mkdtempSync(join(tmpdir(), 'ci-fresh-'))
  git(root, 'init')
  git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't')
  writeFileSync(join(root, 'a.py'), 'def old_sym():\n    pass\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'init')
  globalThis.fetch = (async () => new Response('down', { status: 500 })) as any
  const indexer = new ProjectIndexer(root)
  await indexer.index()
  return { root, indexer }
}

describe('refreshFromGitStatus', () => {
  it('reindexes a modified tracked file before answering', async () => {
    const { root, indexer } = await gitProject()
    appendFileSync(join(root, 'a.py'), '\ndef fresh_sym():\n    pass\n')
    await indexer.refreshFromGitStatus()
    const store = (indexer as any).store as IndexStore
    expect(store.findByName('fresh_sym').length).toBeGreaterThan(0)
    indexer.close()
  })

  it('indexes an untracked new file', async () => {
    const { root, indexer } = await gitProject()
    writeFileSync(join(root, 'b.py'), 'def untracked_sym():\n    pass\n')
    await indexer.refreshFromGitStatus()
    const store = (indexer as any).store as IndexStore
    expect(store.findByName('untracked_sym').length).toBeGreaterThan(0)
    indexer.close()
  })

  it('non-git project resolves without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-nogit-'))
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as any
    const indexer = new ProjectIndexer(root)
    await indexer.refreshFromGitStatus()   // must not throw
    indexer.close()
    expect(true).toBe(true)
  })
})
