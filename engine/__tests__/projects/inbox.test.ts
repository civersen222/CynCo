/**
 * A project's inbox (docs/decisions/2026-11-11-phone-uploads-and-inbox.md).
 *
 * Work done for a project while nobody was in the chat lands in the project's
 * `inbox/` folder as a draft: a plain file, with a small record beside it of
 * where it came from. A draft is not knowledge and not an artifact; the chat
 * does not search it. The owner reads it and accepts it (it becomes an
 * artifact, through the same checks an upload meets) or discards it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, readFileIndex, readJournal } from '../../projects/layout.js'
import { addDraft, listDrafts, readDraft, discardDraft, draftCount, fileRunDraft, finalAnswerText, INBOX_MAX_DRAFTS, DRAFT_MAX_CHARS } from '../../projects/inbox.js'
import { listInboxApi, getDraftApi, acceptDraftApi, discardDraftApi, listProjects, type ProjectsDeps } from '../../projects/api.js'
import type { IngestEvent } from '../../projects/ingest.js'

let home: string, outside: string, events: IngestEvent[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-inbox-'))
  outside = mkdtempSync(join(tmpdir(), 'cynco-inbox-outside-'))
  events = []
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
const deps = (): ProjectsDeps => ({ home, embed: null, embedModel: 'none', emit: (e) => events.push(e), contextLength: 8192 })
const project = (name = 'Yard') => { const m = createProject(home, { name }); return { slug: m.slug, dir: join(home, m.slug) } }
const T0 = new Date('2026-11-11T18:45:00Z')
const FROM = { mission: 'yard-weekly', triggerId: 'planting-plan' }
const inboxFiles = (dir: string) => readdirSync(join(dir, 'inbox')).filter(n => !n.startsWith('.')).sort()

describe('addDraft', () => {
  it('writes the draft as a plain file named for when and what, with a record of where it came from, and journals it', () => {
    const { dir } = project()
    const r = addDraft(dir, { stem: 'planting-plan', text: '# Planting plan\n\nTulips by the fence.\n', from: FROM, summary: 'A plan for the bed by the fence.', now: T0 })
    expect(r).toEqual({ ok: true, name: '20261111-184500-planting-plan.md' })
    expect(readFileSync(join(dir, 'inbox', '20261111-184500-planting-plan.md'), 'utf8')).toBe('# Planting plan\n\nTulips by the fence.\n')
    expect(listDrafts(dir).drafts).toEqual([{
      name: '20261111-184500-planting-plan.md', bytes: 38, addedAt: T0.toISOString(),
      from: 'yard-weekly · planting-plan', summary: 'A plan for the bed by the fence.', readable: true,
    }])
    expect(readJournal(dir).some(l => l.event === 'draft.added' && l.detail.includes('20261111-184500-planting-plan.md'))).toBe(true)
  })

  it('two drafts in the same second get two names; nothing is overwritten', () => {
    const { dir } = project()
    const a = addDraft(dir, { stem: 'plan', text: 'first\n', from: FROM, now: T0 })
    const b = addDraft(dir, { stem: 'plan', text: 'second\n', from: FROM, now: T0 })
    expect([a.ok && a.name, b.ok && b.name]).toEqual(['20261111-184500-plan.md', '20261111-184500-plan-2.md'])
    expect(readFileSync(join(dir, 'inbox', '20261111-184500-plan.md'), 'utf8')).toBe('first\n')
  })

  it('an empty draft is not a draft', () => {
    const { dir } = project()
    expect(addDraft(dir, { stem: 'plan', text: '  \n ', from: FROM, now: T0 })).toEqual({ ok: false, reason: 'nothing to file: the draft is empty' })
    expect(inboxFiles(dir)).toEqual([])
  })

  it('a very long draft is cut at the cap, and says so at its end', () => {
    const { dir } = project()
    const r = addDraft(dir, { stem: 'long', text: 'x'.repeat(DRAFT_MAX_CHARS + 500), from: FROM, now: T0 })
    expect(r.ok).toBe(true)
    const text = readFileSync(join(dir, 'inbox', (r as { name: string }).name), 'utf8')
    expect(text.length).toBeLessThan(DRAFT_MAX_CHARS + 200)
    expect(text).toMatch(/\[cut here: the run wrote 500 more characters than a draft keeps\]\n$/)
  })

  it('a full inbox takes no more: an unattended run must not fill the disk', () => {
    const { dir } = project()
    for (let i = 0; i < INBOX_MAX_DRAFTS; i++) writeFileSync(join(dir, 'inbox', `d${i}.md`), 'x\n')
    const r = addDraft(dir, { stem: 'one-more', text: 'y\n', from: FROM, now: T0 })
    expect(r).toEqual({ ok: false, reason: `the inbox holds ${INBOX_MAX_DRAFTS} drafts; accept or discard some to let new work in` })
    expect(listDrafts(dir).full).toBe(true)
    expect(draftCount(dir)).toBe(INBOX_MAX_DRAFTS)
  })

  it('inbox/ linked out of the project: refused, and the folder it points at is untouched', () => {
    const { dir } = project()
    rmSync(join(dir, 'inbox'), { recursive: true, force: true })
    symlinkSync(outside, join(dir, 'inbox'), 'junction')
    const r = addDraft(dir, { stem: 'plan', text: 'words\n', from: FROM, now: T0 })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/inbox.*not a folder inside this project/)
    expect(readdirSync(outside)).toEqual([])
    expect(listDrafts(dir).drafts).toEqual([])
  })
})

describe('listDrafts', () => {
  it('newest first; a file put there by hand is a draft too, and says it has no record', () => {
    const { dir } = project()
    addDraft(dir, { stem: 'older', text: 'a\n', from: FROM, now: new Date('2026-11-10T08:00:00Z') })
    addDraft(dir, { stem: 'newer', text: 'b\n', from: FROM, now: T0 })
    writeFileSync(join(dir, 'inbox', 'by-hand.txt'), 'dropped in from the desk\n')
    const names = listDrafts(dir).drafts.map(d => d.name)
    expect(names.slice(-2)).toEqual(['20261111-184500-newer.md', '20261110-080000-older.md'])
    const hand = listDrafts(dir).drafts.find(d => d.name === 'by-hand.txt')!
    expect(hand.from).toBe('put here by hand')
    expect(hand.summary).toBe('')
    expect(listDrafts(dir).full).toBe(false)
  })

  it('folders, dot files and the project\'s own index name are not drafts', () => {
    const { dir } = project()
    mkdirSync(join(dir, 'inbox', 'a-folder'))
    writeFileSync(join(dir, 'inbox', '.hidden.md'), 'x')
    writeFileSync(join(dir, 'inbox', 'index.json'), '{}')
    writeFileSync(join(dir, 'inbox', 'real.md'), 'x\n')
    expect(listDrafts(dir).drafts.map(d => d.name)).toEqual(['real.md'])
    expect(draftCount(dir)).toBe(1)
  })

  it('a project made before inbox/ existed simply has no drafts', () => {
    const { dir } = project()
    rmSync(join(dir, 'inbox'), { recursive: true, force: true })
    expect(listDrafts(dir)).toEqual({ drafts: [], full: false })
    expect(draftCount(dir)).toBe(0)
  })

  it('says which drafts can be read on the page: text, not pictures or PDFs', () => {
    const { dir } = project()
    writeFileSync(join(dir, 'inbox', 'notes.md'), 'x\n')
    writeFileSync(join(dir, 'inbox', 'photo.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    const by = Object.fromEntries(listDrafts(dir).drafts.map(d => [d.name, d.readable]))
    expect(by).toEqual({ 'notes.md': true, 'photo.jpg': false })
  })
})

describe('readDraft', () => {
  it('returns a text draft\'s words; a name that is not a draft here is refused before any read', () => {
    const { dir } = project()
    const r = addDraft(dir, { stem: 'plan', text: '# Plan\n', from: FROM, now: T0 }) as { name: string }
    expect(readDraft(dir, r.name)).toEqual({ ok: true, text: '# Plan\n', truncated: false })
    for (const bad of ['../project.json', '..\\project.json', 'index.json', '.meta/x.json', 'nope.md', '', 'a/b.md']) {
      expect(readDraft(dir, bad).ok, bad).toBe(false)
    }
  })
  it('a picture has no words to show', () => {
    const { dir } = project()
    writeFileSync(join(dir, 'inbox', 'photo.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    expect(readDraft(dir, 'photo.jpg')).toEqual({ ok: false, status: 415, reason: 'photo.jpg is not text; accept it to keep it, or open the project folder to look at it' })
  })
})

describe('the API: accept', () => {
  it('an accepted draft becomes an artifact, indexed and journaled, and leaves the inbox', async () => {
    const { slug, dir } = project()
    const { name } = addDraft(dir, { stem: 'planting-plan', text: '# Planting plan\n\nTulips by the fence.\n', from: FROM, now: T0 }) as { name: string }
    const r = await acceptDraftApi(deps(), slug, name)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ accepted: name, artifact: name })
    expect(readFileSync(join(dir, 'artifacts', name), 'utf8')).toBe('# Planting plan\n\nTulips by the fence.\n')
    expect(readFileIndex(dir, 'artifacts').files[name]).toMatchObject({ origin: 'draft' })
    expect(inboxFiles(dir)).toEqual([])
    expect(existsSync(join(dir, 'inbox', '.meta', name + '.json'))).toBe(false)
    expect(readJournal(dir).some(l => l.event === 'draft.accepted' && l.detail.includes(name))).toBe(true)
    expect(events.map(e => e.filePath)).toEqual([`artifacts/${name}`])
  })

  it('never over an artifact already there: the draft is kept under a name of its own', async () => {
    const { slug, dir } = project()
    writeFileSync(join(dir, 'artifacts', 'plan.md'), 'the plan the owner already accepted\n')
    writeFileSync(join(dir, 'inbox', 'plan.md'), 'a newer draft\n')
    const r = await acceptDraftApi(deps(), slug, 'plan.md')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ accepted: 'plan.md', artifact: 'plan-2.md' })
    expect(readFileSync(join(dir, 'artifacts', 'plan.md'), 'utf8')).toBe('the plan the owner already accepted\n')
    expect(readFileSync(join(dir, 'artifacts', 'plan-2.md'), 'utf8')).toBe('a newer draft\n')
  })

  it('a draft meets the checks an upload meets: an unsupported type or content that is not what its name says stays in the inbox, said', async () => {
    const { slug, dir } = project()
    writeFileSync(join(dir, 'inbox', 'tool.exe'), 'MZ')
    writeFileSync(join(dir, 'inbox', 'photo.jpg'), '<html>')
    const exe = await acceptDraftApi(deps(), slug, 'tool.exe')
    expect(exe.status).toBe(415)
    const jpg = await acceptDraftApi(deps(), slug, 'photo.jpg')
    expect(jpg.status).toBe(415)
    expect((jpg.body as { error: string }).error).toMatch(/not a \.jpg/)
    expect(inboxFiles(dir)).toEqual(['photo.jpg', 'tool.exe'])
    expect(readdirSync(join(dir, 'artifacts')).filter(n => n !== 'index.json')).toEqual([])
  })

  it('404s a draft that is not there, an unknown project, and a name that reaches outside', async () => {
    const { slug } = project()
    expect((await acceptDraftApi(deps(), slug, 'nope.md')).status).toBe(404)
    expect((await acceptDraftApi(deps(), 'no-such', 'x.md')).status).toBe(404)
    expect((await acceptDraftApi(deps(), slug, '../project.json')).status).toBe(404)
    expect((await acceptDraftApi(deps(), slug, 'index.json')).status).toBe(404)
  })

  it('artifacts/ linked out of the project: refused, the draft stays, nothing lands outside', async () => {
    const { slug, dir } = project()
    writeFileSync(join(dir, 'inbox', 'plan.md'), 'words\n')
    rmSync(join(dir, 'artifacts'), { recursive: true, force: true })
    symlinkSync(outside, join(dir, 'artifacts'), 'junction')
    const r = await acceptDraftApi(deps(), slug, 'plan.md')
    expect(r.status).toBe(409)
    expect(readdirSync(outside)).toEqual([])
    expect(inboxFiles(dir)).toEqual(['plan.md'])
  })
})

describe('the API: list, read, discard', () => {
  it('lists drafts for a project; reads one; discards one, journaled', async () => {
    const { slug, dir } = project()
    const { name } = addDraft(dir, { stem: 'plan', text: '# Plan\n', from: FROM, summary: 'a plan', now: T0 }) as { name: string }
    const list = listInboxApi(deps(), slug)
    expect(list.status).toBe(200)
    expect((list.body as { drafts: { name: string }[]; full: boolean }).drafts.map(d => d.name)).toEqual([name])
    expect(getDraftApi(deps(), slug, name)).toEqual({ status: 200, body: { name, text: '# Plan\n', truncated: false } })
    expect(getDraftApi(deps(), slug, 'nope.md').status).toBe(404)
    const gone = discardDraftApi(deps(), slug, name)
    expect(gone).toEqual({ status: 200, body: { discarded: name } })
    expect(inboxFiles(dir)).toEqual([])
    expect(readJournal(dir).some(l => l.event === 'draft.discarded' && l.detail.includes(name))).toBe(true)
    expect(discardDraftApi(deps(), slug, name).status).toBe(404)
    expect(listInboxApi(deps(), 'no-such').status).toBe(404)
  })

  it('the project list says how many drafts wait in each project', () => {
    const a = project('Yard'); const b = project('Cookbook')
    addDraft(a.dir, { stem: 'one', text: 'x\n', from: FROM, now: T0 })
    addDraft(a.dir, { stem: 'two', text: 'y\n', from: FROM, now: T0 })
    const list = (listProjects(deps()).body as { projects: { slug: string; drafts: number }[] }).projects
    expect(Object.fromEntries(list.map(p => [p.slug, p.drafts]))).toEqual({ [a.slug]: 2, [b.slug]: 0 })
  })
})

describe('finalAnswerText: what a run\'s draft is', () => {
  const asst = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }] })
  it('the last message that says something, without the outcome block the daemon asked for, thinking or tool fragments', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Plan the bed.' }] },
      asst('Let me read the notes first.'),
      asst('<think>tulips or daffodils</think># Planting plan\n\nTulips by the fence.\n\n```json\n{"summary": "A plan for the bed.", "recommendations": []}\n```'),
    ]
    expect(finalAnswerText(messages as never)).toBe('# Planting plan\n\nTulips by the fence.')
  })
  it('a fenced block that is not the outcome contract stays: it is part of the work', () => {
    const text = 'Use this:\n\n```json\n{"rows": 3}\n```\n\n```json\n{"summary": "s", "recommendations": []}\n```'
    expect(finalAnswerText([asst(text)] as never)).toBe('Use this:\n\n```json\n{"rows": 3}\n```')
  })
  it('a final message that was only the outcome block falls back to the last message with words', () => {
    const messages = [asst('# The plan\n\nDaffodils.'), asst('```json\n{"summary": "done", "recommendations": []}\n```')]
    expect(finalAnswerText(messages as never)).toBe('# The plan\n\nDaffodils.')
  })
  it('no words at all is an empty string', () => {
    expect(finalAnswerText([asst('```json\n{"summary": "done", "recommendations": []}\n```')] as never)).toBe('')
    expect(finalAnswerText([] as never)).toBe('')
  })
})

describe('fileRunDraft: a run in a project folder files its answer; any other run files nothing', () => {
  const asst = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }] })
  const run = (cwd: string | undefined, text = '# Planting plan\n\nTulips.\n\n```json\n{"summary": "A plan.", "recommendations": []}\n```', summary = 'A plan.') =>
    fileRunDraft({ home, cwd, missionId: 'yard-weekly', triggerId: 'planting-plan', messages: [asst(text)] as never, summary, now: T0 })

  it('cwd is a project folder: one draft, from that mission and trigger', () => {
    const { slug, dir } = project()
    expect(run(dir)).toEqual({ slug, name: '20261111-184500-planting-plan.md' })
    const d = listDrafts(dir).drafts[0]!
    expect(d).toMatchObject({ from: 'yard-weekly · planting-plan', summary: 'A plan.' })
    expect(readFileSync(join(dir, 'inbox', d.name), 'utf8')).toBe('# Planting plan\n\nTulips.\n')
  })
  it('cwd is anything else — no cwd, the home itself, a folder inside a project, a folder elsewhere: nothing is filed', () => {
    const { dir } = project()
    expect(run(undefined)).toBeNull()
    expect(run(home)).toBeNull()
    expect(run(join(dir, 'knowledge'))).toBeNull()
    expect(run(outside)).toBeNull()
    expect(inboxFiles(dir)).toEqual([])
  })
  it('a run that left only its outcome block files its summary: that is all the work there is', () => {
    const { dir } = project()
    const r = run(dir, '```json\n{"summary": "Nothing needs planting this week.", "recommendations": []}\n```', 'Nothing needs planting this week.')
    expect(r).not.toBeNull()
    expect(readFileSync(join(dir, 'inbox', r!.name), 'utf8')).toBe('Nothing needs planting this week.\n')
  })
  it('never throws: a project whose inbox cannot be written is logged and the run goes on', () => {
    const { dir } = project()
    rmSync(join(dir, 'inbox'), { recursive: true, force: true })
    writeFileSync(join(dir, 'inbox'), 'a file where the folder should be')
    expect(() => run(dir)).not.toThrow()
    expect(run(dir)).toBeNull()
  })
})
