/**
 * engine/projects/tools.ts — ProjectSearch, SaveArtifact, AddToKnowledge.
 *
 * Tools see only `(input, cwd)`; the project context (home, slug, embed
 * client, event sink) is module state the loop sets when a project session
 * starts and clears when it ends. Outside a project session every tool
 * refuses by name. Files are only ever written inside the project folder.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ToolImpl } from '../tools/types.js'
import type { EmbedClient } from '../index/embedClient.js'
import { fetchGuarded } from '../tools/impl/webFetch.js'
import { appendJournal, isInside, projectDir, readProject, slugify } from './layout.js'
import { commitHistory, ensureHistory } from './history.js'
import { ingestFile, type IngestEvent } from './ingest.js'
import { searchProjects } from './search.js'
import { htmlToText } from './extract/epub.js'

export type ProjectToolContext = { home: string; slug: string; embed: EmbedClient | null; embedModel: string; emit?: (e: IngestEvent) => void }
let context: ProjectToolContext | null = null
let fetchImpl: typeof fetch | null = null
export function setProjectToolContext(ctx: ProjectToolContext | null): void { context = ctx }
export function getProjectToolContext(): ProjectToolContext | null { return context }
/** Test seam for AddToKnowledge by URL. */
export function setProjectFetch(f: typeof fetch | null): void { fetchImpl = f }

const NOT_IN_PROJECT = (tool: string) => ({ output: `${tool} is only available inside a project chat.`, isError: true })

function safeName(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, reason: 'name is required' }
  if (/[\\/]/.test(s) || s.includes('..')) return { ok: false, reason: 'name must not contain path separators or ".."' }
  return { ok: true, name: slugify(s) }
}

export const projectSearchTool: ToolImpl = {
  name: 'ProjectSearch',
  description: 'Search this project\'s knowledge, artifacts and past chats (or every project with allProjects). Returns passages with their file and heading.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, in plain words' },
      allProjects: { type: 'boolean', description: 'Search every project instead of this one (default false)' },
      kinds: { type: 'array', items: { type: 'string', enum: ['knowledge', 'artifact', 'chat'] }, description: 'Restrict to these kinds' },
      limit: { type: 'number', description: 'Max hits (default 8, max 20)' },
    },
    required: ['query'],
  },
  tier: 'auto', core: false,
  execute: async (input) => {
    if (!context) return NOT_IN_PROJECT('ProjectSearch')
    const query = String(input.query ?? '').trim()
    if (!query) return { output: 'query is required', isError: true }
    const r = await searchProjects({ home: context.home, embed: context.embed }, {
      query, scope: input.allProjects === true ? 'all' : { slug: context.slug },
      kinds: Array.isArray(input.kinds) ? (input.kinds as ('knowledge' | 'artifact' | 'chat')[]) : undefined,
      limit: Math.min(Number(input.limit) || 8, 20),
    })
    const lines = r.hits.map(h => `${h.projectName} › ${h.filePath} › ${h.heading} (${h.ordinal}): ${h.passage.replace(/\s+/g, ' ').slice(0, 400)}`)
    const skipped = r.skipped.length ? `\n(skipped: ${r.skipped.map(s => `${s.slug}: ${s.reason}`).join('; ')})` : ''
    return { output: (lines.length ? lines.join('\n') : `No passages found for "${query}" (${r.mode} search).`) + skipped, isError: false }
  },
}

export const saveArtifactTool: ToolImpl = {
  name: 'SaveArtifact',
  description: 'Save a named artifact (spec, plan, list, draft) into this project\'s artifacts folder so the user keeps it. Returns the saved path.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short name; becomes the file name' },
      content: { type: 'string', description: 'The full content' },
      kind: { type: 'string', enum: ['md', 'txt', 'json'], description: 'File kind (default md)' },
    },
    required: ['name', 'content'],
  },
  tier: 'auto', core: false,
  execute: async (input) => {
    if (!context) return NOT_IN_PROJECT('SaveArtifact')
    const n = safeName(input.name)
    if (!n.ok) return { output: n.reason, isError: true }
    const content = String(input.content ?? '')
    if (!content.trim()) return { output: 'content is empty', isError: true }
    const kind = ['md', 'txt', 'json'].includes(String(input.kind)) ? String(input.kind) : 'md'
    const dir = projectDir(context.home, context.slug)
    const rel = `${n.name}.${kind}`
    mkdirSync(join(dir, 'artifacts'), { recursive: true })
    writeFileSync(join(dir, 'artifacts', rel), content.endsWith('\n') ? content : content + '\n', 'utf8')
    await ingestFile({ home: context.home, embed: context.embed, embedModel: context.embedModel, emit: context.emit }, context.slug, 'artifact', rel, 'chat')
    await ensureHistory(dir)
    await commitHistory(dir, [`artifacts/${rel}`, 'artifacts/index.json', 'journal.md'], `artifact: save ${rel}`)
    return { output: `Saved artifacts/${rel}`, isError: false }
  },
}

export const addToKnowledgeTool: ToolImpl = {
  name: 'AddToKnowledge',
  description: 'File something into this project\'s knowledge: an artifact or project file by path, or a web page by url (saved as text with its source). It is indexed for ProjectSearch.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A file inside this project (e.g. artifacts/plan.md)' },
      url: { type: 'string', description: 'A web page to fetch and keep' },
      name: { type: 'string', description: 'Name for the knowledge file (default: from the path or page title)' },
    },
  },
  tier: 'auto', core: false,
  execute: async (input) => {
    if (!context) return NOT_IN_PROJECT('AddToKnowledge')
    const dir = projectDir(context.home, context.slug)
    const meta = readProject(context.home, context.slug)
    if (!meta) return { output: 'project is gone', isError: true }
    const deps = { home: context.home, embed: context.embed, embedModel: context.embedModel, emit: context.emit }
    if (typeof input.url === 'string' && input.url.trim()) {
      const url = input.url.trim()
      const got = await fetchGuarded(url, fetchImpl ?? fetch)
      if (!got.ok) return { output: `URL blocked: ${got.reason}`, isError: true }
      if (!got.response.ok) return { output: `fetch failed: HTTP ${got.response.status}`, isError: true }
      const html = await got.response.text()
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? basename(new URL(url).pathname) ?? 'page'
      const n = safeName(input.name ?? title)
      if (!n.ok) return { output: n.reason, isError: true }
      const rel = `${n.name}.md`
      const text = /<html|<body|<p[\s>]/i.test(html) ? htmlToText(html) : html
      writeFileSync(join(dir, 'knowledge', rel), `Source: ${url}\n\n# ${title}\n\n${text.trim()}\n`, 'utf8')
      const ev = await ingestFile(deps, context.slug, 'knowledge', rel, 'research')
      await ensureHistory(dir)
      await commitHistory(dir, [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: add ${rel} (research)`)
      return { output: `Added knowledge/${rel}${ev.indexed ? '' : ` (kept but not indexed: ${ev.reason})`}`, isError: false }
    }
    if (typeof input.path === 'string' && input.path.trim()) {
      const abs = resolve(dir, input.path.trim())
      if (!isInside(dir, abs)) return { output: `path must be inside this project: ${abs}`, isError: true }
      if (!existsSync(abs)) return { output: `no such file: ${input.path}`, isError: true }
      const n = safeName(input.name ?? basename(abs).replace(/\.[^.]+$/, ''))
      if (!n.ok) return { output: n.reason, isError: true }
      const ext = basename(abs).includes('.') ? basename(abs).slice(basename(abs).lastIndexOf('.')) : '.md'
      const rel = `${n.name}${ext}`
      copyFileSync(abs, join(dir, 'knowledge', rel))
      const fromArtifacts = isInside(join(dir, 'artifacts'), abs)
      const ev = await ingestFile(deps, context.slug, 'knowledge', rel, fromArtifacts ? 'artifact' : 'uploaded')
      if (fromArtifacts) {
        appendJournal(dir, 'artifact.promoted', `${basename(abs)} → knowledge/${rel}`)
      }
      await ensureHistory(dir)
      await commitHistory(dir, [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: add ${rel}`)
      return { output: `Added knowledge/${rel}${ev.indexed ? '' : ` (kept but not indexed: ${ev.reason})`}`, isError: false }
    }
    return { output: 'give either path or url', isError: true }
  },
}
