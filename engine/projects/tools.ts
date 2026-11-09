/**
 * engine/projects/tools.ts — ProjectSearch, SaveArtifact, AddToKnowledge, LookAt.
 *
 * Tools see only `(input, cwd)`; the project context (home, slug, embed
 * client, event sink) is module state the loop sets when a project session
 * starts and clears when it ends. Outside a project session every tool
 * refuses by name. Files are only ever written inside the project folder.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ToolImpl } from '../tools/types.js'
import type { EmbedClient } from '../index/embedClient.js'
import { fetchGuarded } from '../tools/impl/webFetch.js'
import { appendJournal, isInside, isReservedFileName, projectDir, readProject, realInside, slugify, RESERVED_FILE_NAME } from './layout.js'
import { commitHistory, ensureHistory } from './history.js'
import { ingestFile, type IngestEvent } from './ingest.js'
import { searchProjects } from './search.js'
import { htmlToText } from './extract/epub.js'
import { IMAGE_EXTS } from './extract/index.js'
import { imageMime } from '../vision/lookRunner.js'
import type { AskResult } from '../vision/lookClient.js'
import { imageDimensions } from '../vision/imageSize.js'
import { BOX_MAX_PIXELS, cropTiles, tileGrid } from '../vision/tiles.js'

/** `ask`: the image box's aimed look (`LookRunner.ask`), for LookAt; absent = no vision model configured. */
export type ProjectToolContext = { home: string; slug: string; embed: EmbedClient | null; embedModel: string; emit?: (e: IngestEvent) => void; ask?: (bytes: Uint8Array, mime: string, question: string) => Promise<AskResult> }
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
    // A typed extension ("crane-and-resin.md") is the user's own kind, not part
    // of the name: slugified whole it became `crane-and-resin-md.md`.
    const typed = typeof input.name === 'string' ? input.name.trim().match(/^(.*)\.(md|txt|json)$/i) : null
    const n = safeName(typed ? typed[1] : input.name)
    if (!n.ok) return { output: n.reason, isError: true }
    const content = String(input.content ?? '')
    if (!content.trim()) return { output: 'content is empty', isError: true }
    const kind = ['md', 'txt', 'json'].includes(String(input.kind)) ? String(input.kind) : typed ? typed[2].toLowerCase() : 'md'
    const dir = projectDir(context.home, context.slug)
    const rel = `${n.name}.${kind}`
    // artifacts/index.json is the area's own record; an artifact named that
    // would overwrite it and empty the artifact list.
    if (isReservedFileName(rel)) return { output: `"${RESERVED_FILE_NAME}" is reserved for the project's own file index; choose another name`, isError: true }
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
      // The real path: a link inside the project pointing outside it is outside.
      const where = realInside(dir, abs)
      if (!where.inside) return { output: `path must be inside this project: ${where.real}`, isError: true }
      if (!existsSync(abs)) return { output: `no such file: ${input.path}`, isError: true }
      if (!statSync(abs).isFile()) return { output: `not a file: ${input.path}`, isError: true }
      if (isReservedFileName(abs)) return { output: `"${RESERVED_FILE_NAME}" is the project's own file index, not a file to add`, isError: true }
      const n = safeName(input.name ?? basename(abs).replace(/\.[^.]+$/, ''))
      if (!n.ok) return { output: n.reason, isError: true }
      const ext = basename(abs).includes('.') ? basename(abs).slice(basename(abs).lastIndexOf('.')) : '.md'
      const rel = `${n.name}${ext}`
      // knowledge/index.json is the area's own record; a copy named that would replace it.
      if (isReservedFileName(rel)) return { output: `"${RESERVED_FILE_NAME}" is reserved for the project's own file index; choose another name`, isError: true }
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

/**
 * LookAt — the text-only model asks the image box one question about a picture
 * in this project (F191: the upload-time look reads text and describes, but
 * "which item is selected" on a dense screen came back empty four times out
 * of four; aimed, the box answered in under 4 s). Replaces the role ImageView
 * could not fill here: it returned bytes to a model that cannot see.
 *
 * The zoom (F192): the box keeps ~4 MP of any picture, so on a 12 MP photo of
 * a table the checkboxes, bold names and small marks were read wrong. With
 * `zoom` auto (the default) a picture larger than that is cut into two to four
 * tiles (`engine/vision/tiles.ts`) and each tile is asked the question at full
 * detail; the answers come back labelled by place and the model puts them
 * together. One look per tile is the cost; the grid depends on the picture's
 * size, never on the question.
 */
export const lookAtTool: ToolImpl = {
  name: 'LookAt',
  description: 'Ask the image box one question about a picture in this project (a photo or screenshot in knowledge/ or artifacts/): what is selected, a value, a colour, a detail the attached-image block did not give. Returns the box\'s answer in words. You cannot see pictures yourself; this is how you look. A large picture is looked at in 2–4 full-detail tiles (zoom auto); say zoom "on" when small things matter — checkboxes, bold vs plain, little marks, small numbers — and "off" for one quick look at the whole.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'The picture\'s project path, e.g. knowledge/photo.jpg (a bare name means knowledge/)' },
      question: { type: 'string', description: 'One specific question about the picture, in plain words' },
      zoom: { type: 'string', enum: ['auto', 'on', 'off'], description: 'auto (default): tiles when the picture is larger than the box keeps (~4 MP); on: tiles anyway; off: one look at the whole picture' },
    },
    required: ['file', 'question'],
  },
  tier: 'auto', core: false,
  execute: async (input) => {
    if (!context) return NOT_IN_PROJECT('LookAt')
    if (!context.ask) return { output: 'LookAt: no image box is configured (LOCALCODE_VISION_URL unset); pictures cannot be read in this chat.', isError: true }
    const raw = String(input.file ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    const rel = raw.startsWith('knowledge/') || raw.startsWith('artifacts/') ? raw : `knowledge/${raw}`
    const dir = projectDir(context.home, context.slug)
    const abs = resolve(dir, rel)
    if (!raw || raw.includes('..') || !(isInside(join(dir, 'knowledge'), abs) || isInside(join(dir, 'artifacts'), abs))) {
      return { output: 'LookAt: the file must be a picture inside this project (knowledge/… or artifacts/…).', isError: true }
    }
    const ext = rel.toLowerCase().slice(rel.lastIndexOf('.'))
    if (!IMAGE_EXTS.has(ext)) return { output: `LookAt: ${rel} is not a picture (${[...IMAGE_EXTS].join(', ')}).`, isError: true }
    if (!existsSync(abs) || !statSync(abs).isFile()) return { output: `LookAt: ${rel} is not in this project.`, isError: true }
    const real = realInside(dir, abs)
    if (!real.inside) return { output: 'LookAt: the file must be a picture inside this project (knowledge/… or artifacts/…).', isError: true }
    const question = String(input.question ?? '').trim()
    if (!question) return { output: 'LookAt: question is required.', isError: true }
    const bytes = new Uint8Array(readFileSync(real.real)), mime = imageMime(rel)
    const zoom = input.zoom === 'on' ? 'on' : input.zoom === 'off' ? 'off' : 'auto'
    const dims = zoom === 'off' ? null : imageDimensions(bytes)
    const grid = dims && (zoom === 'on' || dims.width * dims.height > BOX_MAX_PIXELS) ? tileGrid(dims.width, dims.height) : null
    let note = ''
    if (grid && grid.length > 1) {
      let tiles: Array<{ label: string; bytes: Uint8Array }> | null = null
      try { tiles = cropTiles(bytes, mime, grid) } catch (e) { note = `(zoom unavailable: ${e instanceof Error ? e.message : String(e)}; looked at the whole picture)\n` }
      if (tiles) {
        // One tile at a time: the box runs one model, and the order of the answers is the order of the places.
        const answers: string[] = []; let ms = 0; let model = ''; let ok = 0
        for (const t of tiles) {
          const r = await context.ask(t.bytes, 'image/jpeg', `${question}\n(This is the ${t.label} of a larger picture; answer for what this part shows.)`)
          if (r.ok) { ok++; ms += r.ms; model = r.model; answers.push(`[${t.label}] ${r.answer}`) } else answers.push(`[${t.label}] ${r.reason}`)
        }
        if (ok === 0) return { output: `LookAt: ${answers.join('; ')}`, isError: true }
        return { output: `Looked closely: ${tiles.length} tiles (${tiles.map(t => t.label).join(', ')}), each answered for its part.\n${answers.join('\n')}\n(image box, ${model}, ${(ms / 1000).toFixed(1)} s total)`, isError: false }
      }
    }
    const r = await context.ask(bytes, mime, question)
    if (!r.ok) return { output: `LookAt: ${r.reason}`, isError: true }
    return { output: `${note}${r.answer}\n(image box, ${r.model}, ${(r.ms / 1000).toFixed(1)} s)`, isError: false }
  },
}
