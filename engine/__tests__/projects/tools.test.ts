import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, readFileIndex, readJournal } from '../../projects/layout.js'
import { ingestFile } from '../../projects/ingest.js'
import { projectSearchTool, saveArtifactTool, addToKnowledgeTool, lookAtTool, setProjectToolContext, setProjectFetch } from '../../projects/tools.js'
import { ALL_TOOLS, getToolByName } from '../../tools/registry.js'
import type { EmbedClient } from '../../index/embedClient.js'
import { PNG } from 'pngjs'
import { imageDimensions } from '../../vision/imageSize.js'

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
  it('registers the four tools as extended auto tools', () => {
    for (const n of ['ProjectSearch', 'SaveArtifact', 'AddToKnowledge', 'LookAt']) {
      const t = getToolByName(n)!
      expect(t).toBeTruthy(); expect(t.tier).toBe('auto'); expect(t.core).toBe(false)
    }
    expect(ALL_TOOLS.filter(t => ['ProjectSearch', 'SaveArtifact', 'AddToKnowledge', 'LookAt'].includes(t.name))).toHaveLength(4)
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

describe('LookAt (F191: the text-only model asks the image box a question about a picture)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  function withAsk() {
    const asks: Array<{ bytes: Uint8Array; mime: string; question: string }> = []
    setProjectToolContext({ home, slug, embed: null, embedModel: 'none', ask: async (bytes, mime, question) => { asks.push({ bytes, mime, question }); return { ok: true, answer: 'The second item, "Resume", is highlighted.', model: 'qwen3-vl:8b-instruct', ms: 1234 } } })
    writeFileSync(join(dir, 'knowledge', 'shot.png'), png)
    return asks
  }
  it('refuses outside a project session by name', async () => {
    setProjectToolContext(null)
    expect(await lookAtTool.execute({ file: 'knowledge/shot.png', question: 'q' }, dir)).toEqual({ output: 'LookAt is only available inside a project chat.', isError: true })
  })
  it('without an image box it says so, naming the switch', async () => {
    writeFileSync(join(dir, 'knowledge', 'shot.png'), png)
    const r = await lookAtTool.execute({ file: 'knowledge/shot.png', question: 'q' }, dir)
    expect(r).toEqual({ output: 'LookAt: no image box is configured (LOCALCODE_VISION_URL unset); pictures cannot be read in this chat.', isError: true })
  })
  it('asks the box the question about the project picture and returns the answer with the box\'s name and time', async () => {
    const asks = withAsk()
    const r = await lookAtTool.execute({ file: 'knowledge/shot.png', question: 'which item is selected?' }, dir)
    expect(r.isError).toBe(false)
    expect(r.output).toBe('The second item, "Resume", is highlighted.\n(image box, qwen3-vl:8b-instruct, 1.2 s)')
    expect(asks).toHaveLength(1)
    expect(Array.from(asks[0].bytes)).toEqual(Array.from(png)); expect(asks[0].mime).toBe('image/png'); expect(asks[0].question).toBe('which item is selected?')
  })
  it('a bare file name means knowledge/; artifacts/ is allowed too', async () => {
    const asks = withAsk()
    writeFileSync(join(dir, 'artifacts', 'render.jpg'), png)
    expect((await lookAtTool.execute({ file: 'shot.png', question: 'q' }, dir)).isError).toBe(false)
    expect((await lookAtTool.execute({ file: 'artifacts/render.jpg', question: 'q' }, dir)).isError).toBe(false)
    expect(asks.map(a => a.mime)).toEqual(['image/png', 'image/jpeg'])
  })
  it('refuses a path outside the project, a file that is not a picture, a missing file and an empty question — without calling the box', async () => {
    const asks = withAsk()
    expect(await lookAtTool.execute({ file: '../elsewhere/x.png', question: 'q' }, dir)).toEqual({ output: 'LookAt: the file must be a picture inside this project (knowledge/… or artifacts/…).', isError: true })
    expect(await lookAtTool.execute({ file: 'knowledge/a.md', question: 'q' }, dir)).toEqual({ output: 'LookAt: knowledge/a.md is not a picture (.png, .jpg, .jpeg, .webp, .gif).', isError: true })
    expect(await lookAtTool.execute({ file: 'knowledge/missing.png', question: 'q' }, dir)).toEqual({ output: 'LookAt: knowledge/missing.png is not in this project.', isError: true })
    expect(await lookAtTool.execute({ file: 'knowledge/shot.png', question: '  ' }, dir)).toEqual({ output: 'LookAt: question is required.', isError: true })
    expect(asks).toEqual([])
  })
  /** A flat PNG of the given size (the zoom decides by pixel count, not content). */
  function flatPng(w: number, h: number): Uint8Array {
    const png = new PNG({ width: w, height: h }); png.data.fill(200); return new Uint8Array(PNG.sync.write(png))
  }
  it('zoom auto: a picture larger than the box keeps is cut into tiles, each asked the question with its place named; the answers come back labelled (F192)', async () => {
    const asks = withAsk()
    writeFileSync(join(dir, 'knowledge', 'wide.png'), flatPng(2200, 2000))  // 4.4 MP > BOX_MAX_PIXELS
    const r = await lookAtTool.execute({ file: 'knowledge/wide.png', question: 'which boxes are ticked?' }, dir)
    expect(r.isError).toBe(false)
    expect(asks.map(a => a.mime)).toEqual(['image/jpeg', 'image/jpeg'])
    expect(asks[0].question).toContain('which boxes are ticked?'); expect(asks[0].question).toMatch(/top half of a larger picture/)
    expect(asks[1].question).toMatch(/bottom half of a larger picture/)
    expect(imageDimensions(asks[0].bytes)).toEqual({ width: 2200, height: 1040 })
    expect(r.output).toMatch(/^Looked closely: 2 tiles \(top half, bottom half\), each answered for its part\./)
    expect(r.output).toContain('[top half] The second item'); expect(r.output).toContain('[bottom half] The second item')
    expect(r.output).toMatch(/\(image box, qwen3-vl:8b-instruct, 2\.5 s total\)$/)
  })
  it('zoom auto leaves a small picture whole; zoom off keeps one look of a large one; zoom on tiles anyway', async () => {
    const asks = withAsk()
    writeFileSync(join(dir, 'knowledge', 'wide.png'), flatPng(2200, 2000))
    expect((await lookAtTool.execute({ file: 'knowledge/shot.png', question: 'q' }, dir)).output).not.toContain('Looked closely')
    expect(asks).toHaveLength(1)
    const off = await lookAtTool.execute({ file: 'knowledge/wide.png', question: 'q', zoom: 'off' }, dir)
    expect(off.output).not.toContain('Looked closely'); expect(asks).toHaveLength(2); expect(asks[1].mime).toBe('image/png')
    const on = await lookAtTool.execute({ file: 'knowledge/shot.png', question: 'q', zoom: 'on' }, dir)
    expect(on.output).not.toContain('Looked closely')  // too small to cut: one tile is the whole picture
    expect(asks).toHaveLength(3)
  })
  it('a tile the box refuses is reported in its place; the other tiles still answer', async () => {
    let n = 0
    setProjectToolContext({ home, slug, embed: null, embedModel: 'none', ask: async () => (++n === 1 ? { ok: false, reason: 'image box did not answer: HTTP 503' } : { ok: true, answer: 'Two ticked.', model: 'm', ms: 1000 }) })
    writeFileSync(join(dir, 'knowledge', 'wide.png'), flatPng(2200, 2000))
    const r = await lookAtTool.execute({ file: 'knowledge/wide.png', question: 'q' }, dir)
    expect(r.isError).toBe(false)
    expect(r.output).toContain('[top half] image box did not answer: HTTP 503')
    expect(r.output).toContain('[bottom half] Two ticked.')
  })
  it('a box that does not answer is the reason, as an error', async () => {
    setProjectToolContext({ home, slug, embed: null, embedModel: 'none', ask: async () => ({ ok: false, reason: 'image box did not answer: HTTP 503' }) })
    writeFileSync(join(dir, 'knowledge', 'shot.png'), png)
    expect(await lookAtTool.execute({ file: 'knowledge/shot.png', question: 'q' }, dir)).toEqual({ output: 'LookAt: image box did not answer: HTTP 503', isError: true })
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
  it('keeps a typed name: a .md/.txt/.json extension is stripped before slugifying and picks the kind', async () => {
    // Found in the Task 9 hand check: "crane-and-resin.md" saved as crane-and-resin-md.md.
    expect((await saveArtifactTool.execute({ name: 'crane-and-resin.md', content: '# Crane\n' }, dir)).output).toBe('Saved artifacts/crane-and-resin.md')
    expect(readFileSync(join(dir, 'artifacts', 'crane-and-resin.md'), 'utf8')).toContain('# Crane')
    expect((await saveArtifactTool.execute({ name: 'Paint List.TXT', content: 'rust red\n' }, dir)).output).toBe('Saved artifacts/paint-list.txt')
    expect((await saveArtifactTool.execute({ name: 'parts.json', content: '{"a":1}' }, dir)).output).toBe('Saved artifacts/parts.json')
    // an explicit kind still wins over the typed extension
    expect((await saveArtifactTool.execute({ name: 'notes.md', kind: 'txt', content: 'x\n' }, dir)).output).toBe('Saved artifacts/notes.txt')
    // an extension that is not a kind stays part of the name
    expect((await saveArtifactTool.execute({ name: 'photo.png', content: 'x\n' }, dir)).output).toBe('Saved artifacts/photo-png.md')
    // the path refusal still holds when an extension is typed
    expect((await saveArtifactTool.execute({ name: '../x.md', content: 'y' }, dir)).output).toMatch(/name must not contain/)
    expect((await saveArtifactTool.execute({ name: 'a/b.txt', content: 'y' }, dir)).output).toMatch(/name must not contain/)
    // Five saves, each three git spawns: under full-suite load on Windows this
    // ran past the 5 s default (final review M5), not a product defect.
  }, 30000)
  it('refuses path separators and empty content', async () => {
    expect((await saveArtifactTool.execute({ name: '../x', content: 'y' }, dir)).output).toMatch(/name must not contain/)
    expect((await saveArtifactTool.execute({ name: 'x', content: '  ' }, dir)).isError).toBe(true)
  })
  it('refuses the name index.json in any spelling, leaving the artifact index intact (final review I1)', async () => {
    await saveArtifactTool.execute({ name: 'plan', content: '# Plan\n' }, dir)
    const before = readFileSync(join(dir, 'artifacts', 'index.json'), 'utf8')
    for (const input of [{ name: 'index', kind: 'json' }, { name: 'index.json' }, { name: 'INDEX.JSON' }]) {
      const r = await saveArtifactTool.execute({ ...input, content: '{"files":{}}' }, dir)
      expect(r.isError, JSON.stringify(input)).toBe(true)
      expect(r.output).toMatch(/"index\.json" is reserved/)
    }
    expect(readFileSync(join(dir, 'artifacts', 'index.json'), 'utf8')).toBe(before)
    expect(Object.keys(readFileIndex(dir, 'artifacts').files)).toEqual(['plan.md'])
    // index as an md is an ordinary artifact
    expect((await saveArtifactTool.execute({ name: 'index', content: '# Index\n' }, dir)).output).toBe('Saved artifacts/index.md')
  }, 30000)
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
  it('refuses an area index, a copy named index.json, and a directory, leaving knowledge/index.json intact (final review I1)', async () => {
    const before = readFileSync(join(dir, 'knowledge', 'index.json'), 'utf8')
    const own = await addToKnowledgeTool.execute({ path: 'artifacts/index.json' }, dir)
    expect(own).toEqual({ output: '"index.json" is the project\'s own file index, not a file to add', isError: true })
    writeFileSync(join(dir, 'artifacts', 'parts.json'), '{"a":1}\n', 'utf8')
    const renamed = await addToKnowledgeTool.execute({ path: 'artifacts/parts.json', name: 'Index' }, dir)
    expect(renamed.isError).toBe(true)
    expect(renamed.output).toMatch(/"index\.json" is reserved/)
    const folder = await addToKnowledgeTool.execute({ path: 'artifacts' }, dir)
    expect(folder).toEqual({ output: 'not a file: artifacts', isError: true })
    expect(readFileSync(join(dir, 'knowledge', 'index.json'), 'utf8')).toBe(before)
  })
  it('refuses a path through a junction that points outside the project, naming the real path (final review I2)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cynco-outside-'))
    writeFileSync(join(outside, 'secret.md'), '# Secret\n', 'utf8')
    symlinkSync(outside, join(dir, 'knowledge', 'h'), 'junction')
    const r = await addToKnowledgeTool.execute({ path: 'knowledge/h/secret.md' }, dir)
    expect(r).toEqual({ output: `path must be inside this project: ${join(realpathSync.native(outside), 'secret.md')}`, isError: true })
    expect(existsSync(join(dir, 'knowledge', 'secret.md'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })
})
