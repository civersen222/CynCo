/**
 * The page's side of the inbox: the Inbox tab of a project, the count on the
 * project list, and "drafts waiting" on the phone's Away tab. Pure page
 * functions (string in, HTML out), lifted by text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
function scripts(): string {
  const out: string[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1]!)
  return out.join('\n')
}
function fnSource(name: string): string {
  const js = scripts()
  const start = js.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found`).toBeGreaterThan(-1)
  const close = /\r?\n\}\r?\n/.exec(js.slice(start))
  expect(close).not.toBeNull()
  return js.slice(start, start + close!.index + close![0].length)
}
function lift<T>(name: string, deps: string[] = []): T {
  const src = deps.map(fnSource).join('\n') + '\n' + fnSource(name)
  return new Function(`${src}; return ${name};`)() as T
}

const DRAFT = { name: '20261111-184500-planting-plan.md', bytes: 2048, addedAt: '2026-11-11T18:45:00.000Z', from: 'yard-weekly · planting-plan', summary: 'A plan for the bed by the fence.', readable: true }

describe('inboxTabLabel', () => {
  const inboxTabLabel = lift<(n: number) => string>('inboxTabLabel')
  it('says how many wait, and nothing when none do', () => {
    expect(inboxTabLabel(0)).toBe('Inbox')
    expect(inboxTabLabel(3)).toBe('Inbox (3)')
  })
})

describe('inboxListHtml', () => {
  const inboxListHtml = lift<(data: unknown) => string>('inboxListHtml', ['escHtml'])
  it('an empty inbox says what an inbox is for', () => {
    const out = inboxListHtml({ drafts: [], full: false })
    expect(out).toContain('No drafts')
    expect(out).toContain('while you were away')
  })
  it('a draft row: its name, where it came from, its summary, and Read / Accept / Discard', () => {
    const out = inboxListHtml({ drafts: [DRAFT], full: false })
    expect(out).toContain('20261111-184500-planting-plan.md')
    expect(out).toContain('yard-weekly · planting-plan')
    expect(out).toContain('A plan for the bed by the fence.')
    expect(out).toMatch(/onclick="readDraft\(this\.getAttribute\('data-name'\)\)"[^>]*>Read</)
    expect(out).toMatch(/onclick="acceptDraft\(this\.getAttribute\('data-name'\)\)"[^>]*>Accept</)
    expect(out).toMatch(/onclick="discardDraft\(this\.getAttribute\('data-name'\)\)"[^>]*>Discard</)
  })
  it('a draft that is not text has no Read button', () => {
    const out = inboxListHtml({ drafts: [{ ...DRAFT, name: 'photo.jpg', readable: false }], full: false })
    expect(out).not.toContain('>Read<')
    expect(out).toContain('>Accept<')
  })
  it('everything a run or a hand wrote is escaped: a name or summary is data, not markup', () => {
    const out = inboxListHtml({ drafts: [{ ...DRAFT, name: 'a"onmouseover="x.md', summary: '<img src=x onerror=alert(1)>', from: '<b>m</b> · t' }], full: false })
    expect(out).not.toContain('<img src=x')
    expect(out).not.toContain('<b>m</b>')
    expect(out).not.toContain('a"onmouseover="x.md')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
  it('a full inbox says so', () => {
    expect(inboxListHtml({ drafts: [DRAFT], full: true })).toContain('The inbox is full')
    expect(inboxListHtml({ drafts: [DRAFT], full: false })).not.toContain('The inbox is full')
  })
})

describe('draftBadgeHtml: the project list', () => {
  const draftBadgeHtml = lift<(n: unknown) => string>('draftBadgeHtml')
  it('nothing for none, a count otherwise', () => {
    expect(draftBadgeHtml(0)).toBe('')
    expect(draftBadgeHtml(undefined)).toBe('')
    expect(draftBadgeHtml(1)).toContain('1 draft<')
    expect(draftBadgeHtml(4)).toContain('4 drafts<')
  })
})

describe('awayDraftsHtml: the phone\'s Away tab', () => {
  const awayDraftsHtml = lift<(projects: unknown[]) => string>('awayDraftsHtml', ['escHtml'])
  it('says nothing when nothing waits', () => {
    expect(awayDraftsHtml([])).toBe('')
    expect(awayDraftsHtml([{ slug: 'yard', name: 'Yard', drafts: 0 }])).toBe('')
  })
  it('names each project with drafts, linked to it, with the count', () => {
    const out = awayDraftsHtml([{ slug: 'yard', name: 'Front <Yard>', drafts: 2 }, { slug: 'cookbook', name: 'Cookbook', drafts: 0 }, { slug: 'boat', name: 'Boat', drafts: 1 }])
    expect(out).toContain('Drafts waiting')
    expect(out).toContain('href="#projects/yard"')
    expect(out).toContain('Front &lt;Yard&gt;')
    expect(out).toContain('(2)')
    expect(out).toContain('href="#projects/boat"')
    expect(out).not.toContain('cookbook')
  })
})

describe('wiring', () => {
  it('a project view loads its inbox, the tab and its panel exist, and the Away tab asks for drafts', () => {
    expect(fnSource('showProject')).toContain('loadInbox(slug)')
    expect(html).toContain('data-ptab="inbox"')
    expect(html).toContain('data-ppanel="inbox"')
    expect(html).toContain('id="inboxList"')
    expect(html).toContain('id="awayDrafts"')
    expect(fnSource('loadAway')).toContain("'/api/projects'")
    expect(fnSource('loadProjectsList')).toContain('draftBadgeHtml(p.drafts)')
  })
  it('accept and discard go to the inbox routes and say what happened', () => {
    const accept = fnSource('acceptDraft')
    expect(accept).toContain("'/inbox/' + encodeURIComponent(name) + '/accept'")
    expect(accept).toContain("method: 'POST'")
    expect(accept).toContain('loadArtifacts(slug)')
    const discard = fnSource('discardDraft')
    expect(discard).toContain("method: 'DELETE'")
    expect(discard).toContain('window.confirm(')
  })
  it('a draft is shown as text, never as markup', () => {
    const read = fnSource('readDraft')
    expect(read).toContain('.textContent = ')
    expect(read).not.toContain('innerHTML = r.text')
  })
})
