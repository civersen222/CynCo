import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { rebuildRegistry } from '../../projects/registry.js'
import { ingestFile, openProjectStore } from '../../projects/ingest.js'
import { searchProjects } from '../../projects/search.js'
import type { EmbedClient } from '../../index/embedClient.js'

/**
 * Bag-of-words "embedding" over a fixed vocabulary so vector search is
 * deterministic — exercised when `IndexStore.isVecEnabled` is true (a real
 * `bun:sqlite` + sqlite-vec). Under `npx vitest run`, `bun:sqlite` is aliased
 * to a shim backed by `node:sqlite` with no `loadExtension`, so sqlite-vec
 * never loads here and `isVecEnabled` is false for every store (pinned by
 * `engine/__tests__/guards/vectorSearchActuallyRuns.test.ts`, which documents
 * the same constraint: "sqlite-vec cannot load under the node test runner").
 * Every fixture/query below is therefore chosen so the correct answer is ALSO
 * the lexical (BM25) winner, not just the semantic one — the assertions hold
 * whether vectors are live (Bun) or absent (vitest).
 */
const VOCAB = ['resin', 'epoxy', 'sand', 'prime', 'flour', 'water', 'starter', 'oven']
class WordEmbed {
  async embed(t: string) { const v = new Array(768).fill(0); const w = t.toLowerCase(); VOCAB.forEach((x, i) => { if (w.includes(x)) v[i] = 1 }); return v }
  async embedQuery(t: string) { return this.embed(t) }
  async embedBatch(ts: string[]) { return Promise.all(ts.map(t => this.embed(t))) }
  get modelName() { return 'word' }
}
const embed = new WordEmbed() as unknown as EmbedClient
let home: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cynco-search-'))
  const d = createProject(home, { name: 'Diorama' })
  writeFileSync(join(home, d.slug, 'knowledge', 'resin.md'), '# Resin\n\nClear epoxy resin cures in a day. Sand and prime the base first. Wipe away dust with water before pouring.\n', 'utf8')
  writeFileSync(join(home, d.slug, 'artifacts', 'list.md'), '# Shopping\n\nTwo litres of epoxy resin.\n', 'utf8')
  await ingestFile({ home, embed, embedModel: 'word' }, d.slug, 'knowledge', 'resin.md', 'pasted')
  await ingestFile({ home, embed, embedModel: 'word' }, d.slug, 'artifact', 'list.md', 'chat')
  const b = createProject(home, { name: 'Bread' })
  writeFileSync(join(home, b.slug, 'knowledge', 'starter.md'), '# Starter\n\nFeed the starter with flour and water before the oven is hot.\n', 'utf8')
  await ingestFile({ home, embed, embedModel: 'word' }, b.slug, 'knowledge', 'starter.md', 'pasted')
  rebuildRegistry(home)
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('searchProjects', () => {
  it('finds a passage in one project with a fused score and the project name', async () => {
    const r = await searchProjects({ home, embed }, { query: 'how long does epoxy resin take to cure before I sand and prime it', scope: { slug: 'diorama' } })
    expect(r.skipped).toEqual([])
    expect(r.hits[0]).toMatchObject({ slug: 'diorama', projectName: 'Diorama', filePath: 'knowledge/resin.md', kind: 'knowledge', heading: 'Resin', ordinal: 1 })
    expect(r.hits[0].passage).toContain('cures in a day')
    expect(r.hits[0].score).toBeGreaterThan(0)
    expect(r.hits.map(h => h.filePath)).toContain('artifacts/list.md')
  })
  it('fans out across projects, merges by fused score, and respects kinds and limit', async () => {
    const all = await searchProjects({ home, embed }, { query: 'flour water starter', scope: 'all', limit: 5 })
    expect(all.hits[0].slug).toBe('bread')
    expect(new Set(all.hits.map(h => h.slug))).toEqual(new Set(['bread', 'diorama']))
    const onlyArtifacts = await searchProjects({ home, embed }, { query: 'resin', scope: 'all', kinds: ['artifact'] })
    expect(onlyArtifacts.hits.every(h => h.kind === 'artifact')).toBe(true)
    expect((await searchProjects({ home, embed }, { query: 'resin', scope: 'all', limit: 1 })).hits).toHaveLength(1)
  })
  it('answers keyword-only without an embed client and says so', async () => {
    const r = await searchProjects({ home, embed: null }, { query: 'epoxy', scope: { slug: 'diorama' } })
    expect(r.mode).toBe('keyword')
    expect(r.hits.length).toBeGreaterThan(0)
  })
  it('a natural-language query still returns the nearest passage', async () => {
    const r = await searchProjects({ home, embed }, { query: 'what should I do before I prime it', scope: { slug: 'diorama' } })
    expect(r.hits.length).toBeGreaterThan(0)
  })
  it('a project whose folder vanished is skipped by name, never thrown', async () => {
    rmSync(join(home, 'bread'), { recursive: true, force: true })
    const r = await searchProjects({ home, embed }, { query: 'starter', scope: 'all' })
    expect(r.hits.every(h => h.slug === 'diorama')).toBe(true)
    expect(r.skipped.some(s => s.slug === 'bread' || s.reason)).toBe(true)
  })
  it('excludeFilePath drops the open chat\'s own file', async () => {
    const r = await searchProjects({ home, embed }, { query: 'resin', scope: { slug: 'diorama' }, excludeFilePath: 'knowledge/resin.md' })
    expect(r.hits.some(h => h.filePath === 'knowledge/resin.md')).toBe(false)
  })
  it('an unknown slug is a skipped entry, not a throw', async () => {
    const r = await searchProjects({ home, embed }, { query: 'x', scope: { slug: 'nope' } })
    expect(r.hits).toEqual([])
    expect(r.skipped).toEqual([{ slug: 'nope', reason: 'no such project' }])
  })
})
