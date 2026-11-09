// Attach a file or a photo to the bound project from the chat (wakefulness slice 5).
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

describe('chat attach', () => {
  it('accepts exactly what the extractors and the image store take', () => {
    const chatAttachAccept = new Function(`${fnSource('chatAttachAccept')}; return chatAttachAccept;`)() as () => string
    expect(chatAttachAccept()).toBe('.md,.markdown,.txt,.pdf,.epub,.docx,.xlsx,image/*')
  })

  it('the button is shown only while a project is bound', () => {
    const showChatAttach = new Function(`${fnSource('showChatAttach')}; return showChatAttach;`)() as (bound: boolean) => void
    const btn: any = { hidden: true }
    ;(globalThis as any).document = { getElementById: (id: string) => (id === 'chatAttachBtn' ? btn : null) }
    try {
      showChatAttach(true); expect(btn.hidden).toBe(false)
      showChatAttach(false); expect(btn.hidden).toBe(true)
    } finally { delete (globalThis as any).document }
  })

  it('markup: a hidden file input that feeds uploadKnowledgeFiles with a chat status sink, camera allowed', () => {
    expect(html).toMatch(/<input type="file" id="chatAttach"[^>]*multiple[^>]*onchange="uploadKnowledgeFiles\(this\.files, chatAttachStatus, projectsState\.active && projectsState\.active\.slug\)"/)
    expect(html).toMatch(/id="chatAttachBtn"[^>]*hidden/)
    const js = scripts()
    expect(js).toContain("function uploadKnowledgeFiles(files, onStatus, slugOverride)")
    expect(js).toContain('function chatAttachStatus(')
  })

  it('the project strip and the attach button move together', () => {
    const js = scripts()
    const shows = js.match(/chatProjectStrip'\)\.classList\.add\('visible'\)/g) || []
    const hides = js.match(/chatProjectStrip'\)\.classList\.remove\('visible'\)/g) || []
    expect(shows.length + hides.length).toBeGreaterThan(0)
    expect((js.match(/showChatAttach\((true|false|[a-zA-Z!]+)\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

// The image box (design §3 + Review Focus 1): a photo's row says it is being looked
// at, a refused type keeps the server's words, and big photos shrink before upload.
describe('image attachments on the page', () => {
  const js = scripts()
  const lift = (name: string) => new Function(`${fnSource(name)}; return ${name};`)()
  it('indexedLabel says "kept, looking…" for the pending record and keeps the old form otherwise', () => {
    const indexedLabel = lift('indexedLabel')
    expect(indexedLabel({ indexed: false, reason: 'looking at the picture…' })).toBe('kept, looking…')
    expect(indexedLabel({ indexed: false, reason: 'unsupported file type .heic' })).toBe('kept but not indexed: unsupported file type .heic')
    expect(indexedLabel({ indexed: true, chunks: 2 })).toBe('indexed (2 chunks)')
  })
  it('needsDownscale: 12 MP or 20 MB is the line', () => {
    const needsDownscale = lift('needsDownscale')
    expect(needsDownscale(4000, 3000, 1e6)).toBe(false)
    expect(needsDownscale(6000, 4000, 1e6)).toBe(true)
    expect(needsDownscale(100, 100, 21 * 1024 * 1024)).toBe(true)
  })
  it('uploadKnowledgeFiles shrinks image files first and onProjectIngest neither toasts the pending record nor stays silent when the look lands', () => {
    const up = fnSource('uploadKnowledgeFiles')
    expect(up).toContain('downscaleImage(')
    expect(up).toMatch(/image\//)
    const ing = fnSource('onProjectIngest')
    expect(ing).toContain('looking at the picture…')
    expect(ing).toContain('Looked at ')
    expect(js).toContain('function downscaleImage(')
  })
})
