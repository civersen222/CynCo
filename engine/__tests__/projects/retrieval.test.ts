import { describe, it, expect } from 'bun:test'
import { buildRetrievalBlock, citationsUsed, retrievalShare, RETRIEVAL_TAG, MAX_PASSAGES } from '../../projects/retrieval.js'
import { IngestNotes, attachedImages, formatLookBlock, formatNoLookBlock, formatNotes } from '../../projects/retrieval.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SearchHit } from '../../projects/search.js'

const hit = (n: number, words = 50): SearchHit => ({ slug: 'p', projectName: 'P', filePath: `knowledge/f${n}.md`, kind: 'knowledge', heading: `H${n}`, ordinal: n, passage: Array.from({ length: words }, (_, i) => `w${n}_${i}`).join(' '), score: 1 / n })

describe('retrievalShare', () => {
  it('defaults to 0.15 and clamps', () => {
    expect(retrievalShare({})).toBe(0.15)
    expect(retrievalShare({ LOCALCODE_PROJECTS_RETRIEVAL_SHARE: '0.3' })).toBe(0.3)
    expect(retrievalShare({ LOCALCODE_PROJECTS_RETRIEVAL_SHARE: '9' })).toBe(0.5)
    expect(retrievalShare({ LOCALCODE_PROJECTS_RETRIEVAL_SHARE: 'x' })).toBe(0.15)
  })
})

describe('buildRetrievalBlock', () => {
  it('numbers passages, cites file › heading (ordinal) and stops at the budget', () => {
    const b = buildRetrievalBlock([hit(1), hit(2), hit(3)], 1000)
    if (!b) throw new Error('expected a block')
    expect(b.text.startsWith(RETRIEVAL_TAG)).toBe(true)
    expect(b.text).toContain('[1] knowledge/f1.md › H1 (1)')
    expect(b.citations).toEqual([
      { n: 1, filePath: 'knowledge/f1.md', heading: 'H1', ordinal: 1 },
      { n: 2, filePath: 'knowledge/f2.md', heading: 'H2', ordinal: 2 },
      { n: 3, filePath: 'knowledge/f3.md', heading: 'H3', ordinal: 3 },
    ])
    const tight = buildRetrievalBlock([hit(1, 300), hit(2, 300), hit(3, 300)], 500)
    if (!tight) throw new Error('expected a block')
    expect(tight.citations.length).toBe(1)
  })
  it('caps at MAX_PASSAGES and returns null for no hits', () => {
    expect(MAX_PASSAGES).toBe(8)
    const many = buildRetrievalBlock(Array.from({ length: 12 }, (_, i) => hit(i + 1, 5)), 100_000)
    expect(many?.citations).toHaveLength(8)
    expect(buildRetrievalBlock([], 1000)).toBeNull()
  })
})

describe('citationsUsed', () => {
  it('returns the citations whose [n] appears in the reply, in order, once each', () => {
    const cits = buildRetrievalBlock([hit(1), hit(2), hit(3)], 10_000)!.citations
    expect(citationsUsed('Use epoxy [2]. Sand first [1] and again [2].', cits).map(c => c.n)).toEqual([2, 1])
    expect(citationsUsed('no citations here', cits)).toEqual([])
  })
})

// A file attached from the phone must be a fact the model is told, not something
// it guesses from an Ls of the wrong folder (2026-11-08: 'nothing landed' while the
// docx sat in knowledge/).
describe('IngestNotes', () => {
  const ev = (over: Partial<Parameters<IngestNotes['add']>[0]> = {}) => ({ slug: 'pc', filePath: 'knowledge/cv.docx', kind: 'knowledge' as const, indexed: false, reason: 'embeddings unavailable: ECONNREFUSED — kept for keyword search', ...over })
  it('collects this project\'s knowledge/artifact events only, and drains on take', () => {
    const n = new IngestNotes('pc')
    n.add(ev()); n.add(ev({ slug: 'other' })); n.add(ev({ kind: 'chat', filePath: 'chats/x.jsonl' }))
    const text = n.take()!
    expect(text.startsWith('[Project knowledge]')).toBe(true)
    expect(text).toContain('knowledge/cv.docx')
    expect(text).toContain('kept, not vector-indexed: embeddings unavailable')
    expect(text).not.toContain('chats/x.jsonl')
    expect(n.take()).toBeNull()
  })
  it('names an indexed file with its passage count and keeps only the last 20', () => {
    const n = new IngestNotes('pc')
    for (let i = 0; i < 25; i++) n.add(ev({ filePath: `knowledge/f${i}.md`, indexed: true, reason: undefined, chunks: 3 }))
    const text = n.take()!
    expect(text).toContain('knowledge/f24.md — indexed (3 passage(s))')
    expect(text).not.toContain('knowledge/f4.md')
  })
})

// The turn sees an attached photo (image box design §2): the loop reads image
// entries out of the same notes, waits on an in-flight look, and tells the model.
describe('IngestNotes.takeEvents / attachedImages / formatLookBlock', () => {
  const ev = (filePath: string, over: Partial<Parameters<IngestNotes['add']>[0]> = {}) => ({ slug: 'pc', filePath, kind: 'knowledge' as const, indexed: true, chunks: 1, ...over })
  it('takeEvents drains the same events take() would format', () => {
    const n = new IngestNotes('pc')
    n.add(ev('knowledge/a.jpg')); n.add(ev('knowledge/b.docx')); n.add(ev('chats/x.jsonl', { kind: 'chat' }))
    const events = n.takeEvents()
    expect(events.map(e => e.filePath)).toEqual(['knowledge/a.jpg', 'knowledge/b.docx'])
    expect(n.takeEvents()).toEqual([])
    expect(formatNotes(events)).toContain('knowledge/b.docx')
    expect(formatNotes([])).toBeNull()
    expect(formatNotes([ev('knowledge/p.jpg', { indexed: false, reason: 'looking at the picture…' })])).toBeNull()
    expect(formatNotes([ev('knowledge/p.jpg', { indexed: false, reason: 'looking at the picture…' }), ev('knowledge/n.md')])).not.toContain('looking at the picture')
  })
  it('attachedImages keeps knowledge pictures, in order, once each', () => {
    expect(attachedImages([ev('knowledge/a.jpg'), ev('knowledge/b.docx'), ev('knowledge/c.PNG'), ev('knowledge/a.jpg'), ev('artifacts/d.webp')]))
      .toEqual(['knowledge/a.jpg', 'knowledge/c.PNG'])
  })
  it('both blocks point the model at LookAt: the look block for a specific question, the no-look block saying it will not help yet (F191)', () => {
    const b = formatLookBlock('knowledge/boot.jpg', { text: 'UEFI: USB', state: '', description: 'A boot menu.', model: 'm', ms: 1 })
    expect(b).toMatch(/call LookAt with file "knowledge\/boot\.jpg" and your question/)
    const n = formatNoLookBlock('knowledge/dark.jpg', 'image box did not answer: HTTP 503')
    expect(n).toMatch(/LookAt will not answer either until the image box does/)
  })
  it('formatNoLookBlock names the picture, the reason, and forbids the text-only model from trying to see it (F190)', () => {
    const b = formatNoLookBlock('knowledge/dark.jpg', 'image box did not answer: HTTP 400 context')
    expect(b.startsWith(RETRIEVAL_TAG)).toBe(true)
    expect(b).toContain('[Attached image] knowledge/dark.jpg')
    expect(b).toContain('could not look at it: image box did not answer: HTTP 400 context')
    expect(b).toMatch(/cannot see pictures/i)
    expect(b).toMatch(/do not open, convert, tile or analyse/i)
    expect(b).toMatch(/tell the user/i)
  })
  it('formatLookBlock carries the tag, the path and the non-empty parts', () => {
    const b = formatLookBlock('knowledge/boot.jpg', { text: 'UEFI: USB', state: '', description: 'A boot menu.', model: 'qwen3-vl:8b-instruct', ms: 900 })
    expect(b.startsWith('[Project knowledge]')).toBe(true)
    expect(b).toContain('[Attached image] knowledge/boot.jpg')
    expect(b).toContain('text: UEFI: USB')
    expect(b).not.toContain('state:')
    expect(b).toContain('description: A boot menu.')
  })
})

describe('attachment notes wiring', () => {
  it('the loop looks up each attached image and waits on an in-flight look; main.ts hands the runner to the binding', () => {
    const loop = readFileSync(join(here, '../../bridge/conversationLoop.ts'), 'utf8')
    const fn = loop.slice(loop.indexOf('private async injectProjectRetrieval('))
    expect(fn).toContain('attachedImages(')
    expect(fn).toContain('formatLookBlock(')
    expect(fn).toContain('.pending(')
    const main = readFileSync(join(here, '../../main.ts'), 'utf8')
    expect(main).toContain('looks: projectsDeps.looks')
  })
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  it('the loop drains the notes into the per-turn block and main.ts feeds it every project.ingest', () => {
    const loop = readFileSync(join(here, '../../bridge/conversationLoop.ts'), 'utf8')
    expect(loop).toContain('this.ingestNotes')
    expect(loop).toContain('noteProjectIngest(')
    const main = readFileSync(join(here, '../../main.ts'), 'utf8')
    expect(main).toContain('loop.noteProjectIngest(e)')
  })
})
