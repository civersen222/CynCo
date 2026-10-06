import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, readFileIndex, readJournal } from '../../projects/layout.js'
import { ingestFile } from '../../projects/ingest.js'
import { projectSearchTool, saveArtifactTool, addToKnowledgeTool, setProjectToolContext, setProjectFetch } from '../../projects/tools.js'
import { ALL_TOOLS, getToolByName } from '../../tools/registry.js'
import type { EmbedClient } from '../../index/embedClient.js'

class StubEmbed { async embed() { return new Array(768).fill(0.01) } async embedQuery(t: string) { return this.embed() } async embedBatch(ts: string[]) { return ts.map(() => new Array(768).fill(0.01)) } get modelName() { return 'stub' } }
let home: string, slug: string, dir: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cynco-tools-'))
  slug = createProject(home, { name: 'T' }).slug
  dir = join(home, slug)
  setProjectToolContext({ home, slug, embed: new StubEmbed() as unknown as EmbedClient, embedModel: 'stub' })
  writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n\nEpoxy resin needs a day to cure.\n', 'utf8')
  await ingestFile({ home, embed: new StubEmbed() as unknown as EmbedClient, embedModel: 'stub' }, slug, 'knowledge', 'a.md', 'pasted')
})
afterEach(() => { setProjectToolContext(null); setProjectFetch(null); rmSync(home, { recursive: true, force: true }) })

describe('registry', () => {
  it('registers the three tools as extended auto tools', () => {
    for (const n of ['ProjectSearch', 'SaveArtifact', 'AddToKnowledge']) {
      const t = getToolByName(n)!
      expect(t).toBeTruthy(); expect(t.tier).toBe('auto'); expect(t.core).toBe(false)
    }
    expect(ALL_TOOLS.filter(t => ['ProjectSearch', 'SaveArtifact', 'AddToKnowledge'].includes(t.name))).toHaveLength(3)
  })
})

describe('ProjectSearch', () => {
  it('returns one line per hit, scoped to the project', async () => {
    const r = await projectSearchTool.execute({ query: 'epoxy cure' }, dir)
    expect(r.isError).toBe(false)
    expect(r.output).toMatch(/T › knowledge\/a\.md › A \(1\): Epoxy resin needs a day to cure\./)
  })
  it('refuses outside a project session by name', async () => {
    setProjectToolContext(null)
    const r = await projectSearchTool.execute({ query: 'x' }, dir)
    expect(r).toEqual({ output: 'ProjectSearch is only available inside a project chat.', isError: true })
  })
})

describe('SaveArtifact', () => {
  it('writes artifacts/<name>.<kind>, records, indexes, journals, returns the path', async () => {
    const r = await saveArtifactTool.execute({ name: 'shopping list', content: '# Shopping\n\n- 2 L epoxy\n' }, dir)
    expect(r.isError).toBe(false)
    expect(r.output).toBe('Saved artifacts/shopping-list.md')
    expect(readFileSync(join(dir, 'artifacts', 'shopping-list.md'), 'utf8')).toContain('2 L epoxy')
    expect(readFileIndex(dir, 'artifacts').files['shopping-list.md']).toMatchObject({ origin: 'chat', indexed: true })
    expect(readJournal(dir)[0].event).toBe('artifact.saved')
  })
  it('refuses path separators and empty content', async () => {
    expect((await saveArtifactTool.execute({ name: '../x', content: 'y' }, dir)).output).toMatch(/name must not contain/)
    expect((await saveArtifactTool.execute({ name: 'x', content: '  ' }, dir)).isError).toBe(true)
  })
})

describe('AddToKnowledge', () => {
  it('files an artifact into knowledge with origin artifact and promotes the journal', async () => {
    await saveArtifactTool.execute({ name: 'plan', content: '# Plan\n\nsteps\n' }, dir)
    const r = await addToKnowledgeTool.execute({ path: 'artifacts/plan.md' }, dir)
    expect(r.isError).toBe(false)
    expect(existsSync(join(dir, 'knowledge', 'plan.md'))).toBe(true)
    expect(readFileIndex(dir, 'knowledge').files['plan.md']).toMatchObject({ origin: 'artifact', indexed: true })
    expect(readJournal(dir).some(e => e.event === 'artifact.promoted')).toBe(true)
  })
  it('fetches a URL through the SSRF guard, saves markdown with the URL on line 1, origin research', async () => {
    setProjectFetch(async () => new Response('<html><head><title>Resin FAQ</title></head><body><h1>FAQ</h1><p>Cure time 24h.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const r = await addToKnowledgeTool.execute({ url: 'https://example.com/resin', name: 'resin faq' }, dir)
    expect(r.isError).toBe(false)
    const saved = readFileSync(join(dir, 'knowledge', 'resin-faq.md'), 'utf8')
    expect(saved.split('\n')[0]).toBe('Source: https://example.com/resin')
    expect(saved).toContain('Cure time 24h.')
    expect(readFileIndex(dir, 'knowledge').files['resin-faq.md']).toMatchObject({ origin: 'research' })
  })
  it('refuses a loopback URL by the guard\'s reason and a path outside the project', async () => {
    const r = await addToKnowledgeTool.execute({ url: 'http://127.0.0.1:9161/' }, dir)
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/blocked/i)
    const p = await addToKnowledgeTool.execute({ path: '../../etc/passwd' }, dir)
    expect(p.isError).toBe(true)
    expect(p.output).toMatch(/inside this project/)
  })
})
