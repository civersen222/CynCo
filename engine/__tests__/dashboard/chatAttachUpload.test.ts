// Review fix (slice 5, critical): Attach from the chat must upload to the project
// the CHAT is bound to (projectsState.active.slug), not the one the Projects tab
// shows (projectsState.slug), and must say so when nothing is bound.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
function scripts(): string {
  const out: string[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1])
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

function lifted(projectsState: any) {
  const calls: { url: string }[] = []
  const statuses: [string, string][] = []
  const fakes = {
    projectsState,
    projFetch: async (url: string) => { calls.push({ url }); return { name: 'n.txt', event: { indexed: true } } },
    projUrl: (slug: string) => '/api/projects/' + slug,
    projStatus: () => {},
    indexedLabel: () => 'indexed',
    loadKnowledge: () => {},
    document: { getElementById: () => null },
    FormData: class { append() {} },
    console: { warn: () => {} },
  }
  const fn = new Function(...Object.keys(fakes), `${fnSource('uploadKnowledgeFiles')}; return uploadKnowledgeFiles;`)(...Object.values(fakes)) as (files: any[], onStatus?: (k: string, t: string) => void, slug?: string) => void
  return { fn, calls, statuses }
}

describe('uploadKnowledgeFiles from the chat', () => {
  it('uploads to the bound chat project when told its slug, even if the Projects tab shows none', async () => {
    const { fn, calls } = lifted({ slug: null, active: { slug: 'fantasy-football' } })
    fn([{ name: 'a.txt' }], () => {}, 'fantasy-football')
    await new Promise(r => setTimeout(r, 10))
    expect(calls.map(c => c.url)).toEqual(['/api/projects/fantasy-football/knowledge'])
  })
  it('the Projects tab path is unchanged (no slug argument → the tab project)', async () => {
    const { fn, calls } = lifted({ slug: 'diorama', active: null })
    fn([{ name: 'a.txt' }])
    await new Promise(r => setTimeout(r, 10))
    expect(calls.map(c => c.url)).toEqual(['/api/projects/diorama/knowledge'])
  })
  it('says "no project bound" instead of silently doing nothing', async () => {
    const { fn, calls } = lifted({ slug: null, active: null })
    const statuses: string[] = []
    fn([{ name: 'a.txt' }], (k, t) => statuses.push(k + ':' + t))
    await new Promise(r => setTimeout(r, 10))
    expect(calls.length).toBe(0)
    expect(statuses).toEqual(['err:no project bound — open a project chat first'])
  })
  it('the chat input passes the bound slug', () => {
    expect(html).toMatch(/id="chatAttach"[^>]*onchange="uploadKnowledgeFiles\(this\.files, chatAttachStatus, projectsState\.active && projectsState\.active\.slug\)"/)
  })
})
