/**
 * engine/projects/api.ts — the dashboard's project routes as plain functions.
 *
 * Every function returns { status, body } and never throws for a user
 * mistake: unknown project 404, bad input 400, unsupported type 415, too
 * large 413. The server (Task 8) only parses the request and mounts these.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { validateSpec, isSurfaceId } from '../genui/spec.js'
import { basename, extname, join } from 'node:path'
import { EmbedClient } from '../index/embedClient.js'
import { ACCEPTED_EXTS, IMAGE_EXTS } from './extract/index.js'
import { LookRunner, PENDING_REASON, imageMime } from '../vision/lookRunner.js'
import { makeLookClient } from '../vision/lookClient.js'
import { commitHistory, ensureHistory } from './history.js'
import { ingestFile, makeProseEmbedClient, proseEmbedModel, removeFromIndex, rescanProject, type IngestEvent } from './ingest.js'
import { appendJournal, createProject, isReservedFileName, projectDir, readFileIndex, readInstructions, readJournal, readProject, realInside, sha256Of, slugify, writeBytesAtomic, writeFileIndex, writeInstructions, writeProject, RESERVED_FILE_NAME, SLUG_RE } from './layout.js'
import { contentFault, landingName, safeStem } from './upload.js'
import { readRegistry, upsertRegistry } from './registry.js'
import { listChats, readTranscript, renameChat } from './chat.js'
import { searchProjects, type SearchKind } from './search.js'
import { annotateFileImages, originKey, pictureRequests, readOrigins, storedImageState } from '../imagegen/store.js'

/** `looks`: the image box's look runner (engine/vision); absent or null = no vision model configured, images are refused as before. */
export type ProjectsDeps = { home: string; embed: EmbedClient | null; embedModel: string; emit: (e: IngestEvent) => void; contextLength: number; looks?: LookRunner | null }
export type ApiResult = { status: number; body: unknown }
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export { SLUG_RE }

export function makeProjectsDeps(args: { home: string; embedBaseUrl: string; emitEvent: (e: { type: 'project.ingest' } & IngestEvent) => void; contextLength: number; env?: NodeJS.ProcessEnv }): ProjectsDeps {
  const d: ProjectsDeps = { home: args.home, embed: makeProseEmbedClient(args.embedBaseUrl), embedModel: proseEmbedModel(), emit: (e) => args.emitEvent({ type: 'project.ingest', ...e }), contextLength: args.contextLength, looks: null }
  // The image box: a look finishes as an ordinary ingest of the uploaded file, then a history commit.
  const client = makeLookClient(args.env)
  if (client) {
    d.looks = new LookRunner({
      client,
      finish: async (slug, rel, input) => {
        const ev = await ingestFile(d, slug, 'knowledge', rel, 'uploaded', { lookInput: input })
        await commitHistory(projectDir(d.home, slug), [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: look at ${rel}`)
        return ev
      },
      log: (line) => console.log(line),
    })
  }
  return d
}

/** The content hash of the regular file at `path`; null when nothing readable as a file is there (free, a folder, a dangling link). */
function heldSha(path: string): string | null {
  try {
    const st = lstatSync(path)
    // A link is not this project's file, whatever it points at: the name counts as free and the write replaces the link.
    if (!st.isFile()) return null
    return sha256Of(readFileSync(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.log(`[projects] could not read ${path}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * Null when `knowledge/` really is a folder of this project; otherwise the
 * refusal. A junction planted there would carry the write, and the index
 * beside it, out of the project.
 */
function knowledgeAreaFault(dir: string, slug: string): ApiResult | null {
  const area = join(dir, 'knowledge')
  mkdirSync(area, { recursive: true })
  const real = realInside(dir, area)
  if (real.inside && lstatSync(area).isDirectory()) return null
  console.warn(`[projects] write refused: knowledge/ of ${slug} resolves to ${real.real}`)
  return { status: 409, body: { error: 'knowledge/ is not a folder inside this project; the file was not kept' } }
}

/**
 * Put `bytes` at `knowledge/<rel>`: never through a link (the fresh file
 * replaces whatever sat at the name), never over a folder. Null when written;
 * otherwise the refusal or the failure, said.
 */
function landInKnowledge(dir: string, slug: string, rel: string, bytes: Uint8Array): ApiResult | null {
  const target = join(dir, 'knowledge', rel)
  if (isFolder(target)) return { status: 409, body: { error: `a folder named ${rel} is in the way; the file was not kept` } }
  try {
    writeBytesAtomic(target, bytes)
    return null
  } catch (e) {
    console.error(`[projects] ${rel} could not be written into knowledge/ of ${slug}: ${e instanceof Error ? e.message : String(e)}`)
    return { status: 500, body: { error: `the file could not be written: ${e instanceof Error ? e.message : String(e)}` } }
  }
}

function isFolder(path: string): boolean {
  try { return lstatSync(path).isDirectory() } catch { return false }
}

const notFound = (what: string): ApiResult => ({ status: 404, body: { error: `no such ${what}` } })
const bad = (reason: string): ApiResult => ({ status: 400, body: { error: reason } })
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {})

export function listProjects(d: ProjectsDeps): ApiResult {
  const { registry, rebuilt } = readRegistry(d.home)
  return { status: 200, body: { projects: registry.projects, rebuilt } }
}

export async function createProjectApi(d: ProjectsDeps, body: unknown): Promise<ApiResult> {
  const b = obj(body)
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return bad('name is required')
  const meta = createProject(d.home, { name, description: typeof b.description === 'string' ? b.description : '', instructions: typeof b.instructions === 'string' ? b.instructions : '', tags: Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string') : [] })
  const dir = projectDir(d.home, meta.slug)
  await ensureHistory(dir)
  await commitHistory(dir, ['.'], 'project: create')
  upsertRegistry(d.home, { slug: meta.slug, name: meta.name, description: meta.description, tags: meta.tags, createdAt: meta.createdAt, lastOpenedAt: null, path: dir })
  return { status: 201, body: meta }
}

export function getProjectApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!SLUG_RE.test(slug)) return bad('bad slug')
  const meta = readProject(d.home, slug)
  if (!meta) return notFound('project')
  const dir = projectDir(d.home, slug)
  const knowledge = readFileIndex(dir, 'knowledge').files, artifacts = readFileIndex(dir, 'artifacts').files
  return { status: 200, body: { ...meta, instructions: readInstructions(d.home, slug), counts: { knowledge: Object.keys(knowledge).length, artifacts: Object.keys(artifacts).length, chats: listChats(dir).length }, plan: existsSync(join(dir, 'plan.md')) ? readFileSync(join(dir, 'plan.md'), 'utf8') : '', journal: readJournal(dir, 50) } }
}

export async function patchProjectApi(d: ProjectsDeps, slug: string, body: unknown): Promise<ApiResult> {
  const meta = readProject(d.home, slug)
  if (!meta) return notFound('project')
  const b = obj(body)
  if (typeof b.name === 'string' && b.name.trim()) meta.name = b.name.trim()
  if (typeof b.description === 'string') meta.description = b.description.trim()
  if (Array.isArray(b.tags)) meta.tags = b.tags.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean)
  writeProject(d.home, meta)
  const paths = ['project.json']
  if (typeof b.instructions === 'string') { writeInstructions(d.home, slug, b.instructions); paths.push('instructions.md') }
  const dir = projectDir(d.home, slug)
  await commitHistory(dir, paths, 'project: update')
  const existing = readRegistry(d.home).registry.projects.find(p => p.slug === slug)
  upsertRegistry(d.home, { slug, name: meta.name, description: meta.description, tags: meta.tags, createdAt: meta.createdAt, lastOpenedAt: existing?.lastOpenedAt ?? null, path: dir })
  return { status: 200, body: { ...meta, instructions: readInstructions(d.home, slug) } }
}

export async function searchApi(d: ProjectsDeps, slug: string | null, q: string, kinds: string | null, limit: string | null): Promise<ApiResult> {
  if (!q.trim()) return bad('q is required')
  const ks = kinds ? kinds.split(',').filter((k): k is SearchKind => ['knowledge', 'artifact', 'chat'].includes(k)) : undefined
  const r = await searchProjects({ home: d.home, embed: d.embed }, { query: q, scope: slug ? { slug } : 'all', kinds: ks, limit: limit ? Number(limit) || 10 : 10 })
  return { status: 200, body: r }
}

export function listKnowledgeApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!readProject(d.home, slug)) return notFound('project')
  return { status: 200, body: readFileIndex(projectDir(d.home, slug), 'knowledge') }
}

export async function addKnowledgeApi(d: ProjectsDeps, slug: string, item: { name: string; text?: string; bytes?: Uint8Array }): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const rawName = basename(item.name || '').trim()
  if (!rawName) return bad('name is required')
  const ext = extname(rawName).toLowerCase() || (item.text !== undefined ? '.md' : '')
  if (!ACCEPTED_EXTS.has(ext)) return { status: 415, body: { error: `unsupported file type ${ext || '(none)'}` } }
  const bytes = item.bytes ?? new TextEncoder().encode(item.text ?? '')
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return { status: 413, body: { error: `file is larger than ${UPLOAD_MAX_BYTES} bytes` } }
  if (bytes.byteLength === 0) return bad('empty file')
  // The bytes are what the name says (upload.ts): a `.jpg` that is HTML is not kept, looked at or listed as a picture.
  const fault = contentFault(ext, bytes)
  if (fault) return { status: 415, body: { error: `${rawName}: ${fault}` } }
  const dir = projectDir(d.home, slug)
  const area = join(dir, 'knowledge')
  const areaFault = knowledgeAreaFault(dir, slug)
  if (areaFault) return areaFault
  const sha = sha256Of(bytes)
  const stem = safeStem(slugify(rawName.slice(0, rawName.length - extname(rawName).length)))
  // A photo's name is the camera's: a different picture under a taken name
  // goes beside it, and the same picture sent twice is one file. A document
  // sent again under its name is its new version, as before.
  const landing = landingName(stem, ext, sha, (name) => heldSha(join(area, name)))
  const rel = landing.name
  if (landing.kind === 'duplicate') {
    const held = readFileIndex(dir, 'knowledge').files[rel]
    if (held) return { status: 200, body: { name: rel, ...held, duplicate: true, event: null } }
    // The bytes are there but were never recorded (a write that died before its index): record them now, below.
  } else {
    const writeFault = landInKnowledge(dir, slug, rel, bytes)
    if (writeFault) return writeFault
  }
  if (IMAGE_EXTS.has(ext) && d.looks) {
    // The look runs behind the answer: the phone's Attach must not wait a minute on a cold box.
    const index = readFileIndex(dir, 'knowledge')
    index.files[rel] = { sha256: sha, addedAt: index.files[rel]?.addedAt ?? new Date().toISOString(), origin: 'uploaded', indexed: false, reason: PENDING_REASON }
    writeFileIndex(dir, 'knowledge', index)
    // The loop hears of the picture now (IngestNotes), so the next turn can wait on the look (design §2); the look's own event follows.
    d.emit({ slug, filePath: `knowledge/${rel}`, kind: 'knowledge', indexed: false, reason: PENDING_REASON })
    d.looks.start(slug, rel, bytes, imageMime(rel))
    return { status: 201, body: { name: rel, ...index.files[rel], event: null } }
  }
  const ev = await ingestFile(d, slug, 'knowledge', rel, item.bytes ? 'uploaded' : 'pasted')
  await commitHistory(dir, [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: add ${rel}`)
  return { status: 201, body: { name: rel, ...readFileIndex(dir, 'knowledge').files[rel], event: ev } }
}

export async function removeKnowledgeApi(d: ProjectsDeps, slug: string, name: string): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const rel = basename(name)
  const dir = projectDir(d.home, slug)
  if (!readFileIndex(dir, 'knowledge').files[rel]) return notFound('knowledge file')
  await removeFromIndex(d, slug, 'knowledge', rel)
  rmSync(join(dir, 'knowledge', rel), { force: true })
  await commitHistory(dir, ['knowledge', 'journal.md'], `knowledge: remove ${rel}`)
  return { status: 200, body: { removed: rel } }
}

export function listArtifactsApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!readProject(d.home, slug)) return notFound('project')
  return { status: 200, body: readFileIndex(projectDir(d.home, slug), 'artifacts') }
}

export async function promoteArtifactApi(d: ProjectsDeps, slug: string, name: string): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const rel = basename(name)
  if (!rel || rel === '.' || rel === '..') return bad(`not an artifact name: "${name}"`)
  // Each area's index.json is its own record: promoting artifacts/index.json
  // would copy the artifact records over knowledge/index.json.
  if (isReservedFileName(rel)) return bad(`"${RESERVED_FILE_NAME}" is the project's own file index, not an artifact`)
  const dir = projectDir(d.home, slug)
  const src = join(dir, 'artifacts', rel)
  if (!existsSync(src)) return notFound('artifact')
  // The artifact itself, not what a link at its name points to: promoting a
  // link would copy a file from anywhere on this machine into knowledge, where
  // the chat can search it. `lstat`, and the real path inside the project.
  const srcReal = realInside(dir, src)
  const srcStat = lstatSync(src)
  if (srcStat.isSymbolicLink() || !srcReal.inside) {
    console.warn(`[projects] promote refused: artifacts/${rel} of ${slug} resolves to ${srcReal.real}`)
    return bad(`not a file of this project: artifacts/${rel}`)
  }
  if (!srcStat.isFile()) return bad(`not a file: artifacts/${rel}`)
  const areaFault = knowledgeAreaFault(dir, slug)
  if (areaFault) return areaFault
  const writeFault = landInKnowledge(dir, slug, rel, readFileSync(src))
  if (writeFault) return writeFault
  const ev = await ingestFile(d, slug, 'knowledge', rel, 'artifact')
  appendJournal(dir, 'artifact.promoted', `${rel} → knowledge/${rel}`)
  await commitHistory(dir, [`knowledge/${rel}`, 'knowledge/index.json', 'journal.md'], `knowledge: promote ${rel}`)
  return { status: 200, body: { promoted: rel, event: ev } }
}

export function listChatsApi(d: ProjectsDeps, slug: string): ApiResult {
  if (!readProject(d.home, slug)) return notFound('project')
  return { status: 200, body: { chats: listChats(projectDir(d.home, slug)) } }
}

/** One chat's transcript — the page renders it when a chat is reopened. */
export function getChatApi(d: ProjectsDeps, slug: string, file: string): ApiResult {
  if (!SLUG_RE.test(slug)) return bad('bad slug')
  if (!readProject(d.home, slug)) return notFound('project')
  const dir = projectDir(d.home, slug)
  const chatFile = basename(file)
  const t = readTranscript(dir, chatFile)
  if (!t) return notFound('chat')
  return { status: 200, body: withValidatedSurfaces(t, { dir, slug, chatFile }) }
}

/** Where a transcript lives, so its generated pictures can be found again. */
export type SurfaceImagesAt = { dir: string; slug: string; chatFile: string }

/**
 * The transcript stores the model's raw RenderUI input; the page drew what
 * `validateSpec` made of it. Serve the validated spec, so a reloaded chat
 * draws the surface it showed live (aliases, chart pairs and nested trees
 * resolved) and a spec with nothing drawable comes back as `spec: null`.
 * With `at`, each Image the engine paints (a `prompt`, or a photo with a `transform`: `pictureRequests`, F199) gets the picture
 * state it has now (F174), found through `images/index.json` by its origin
 * `<chatFile>#<toolId>#<elementId>` — the exact picture shown live, even if
 * the knobs changed since. A transcript block's id is the live toolId: the
 * tool_use is appended before the tools run. index.json is read once, and
 * only when a surface has such an Image. Each Image whose src is a path in
 * the project gets its file state again (`annotateFileImages`), as the live
 * frame had it. The stored history stays untouched.
 */
export function withValidatedSurfaces<T>(t: T, at?: SurfaceImagesAt): T {
  const msgs = (t as { messages?: unknown }).messages
  if (!Array.isArray(msgs)) return t
  let origins: Record<string, string> | null = null
  const messages = msgs.map((m: any) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return m
    if (!m.content.some((b: any) => b?.type === 'tool_use' && b.name === 'RenderUI')) return m
    return {
      ...m,
      content: m.content.map((b: any) => {
        if (b?.type !== 'tool_use' || b.name !== 'RenderUI' || !b.input || typeof b.input !== 'object') return b
        const raw = b.input.spec !== undefined ? b.input.spec : b.input
        const spec = validateSpec(raw).spec
        if (spec && at) {
          const toolId = typeof b.id === 'string' ? b.id : ''
          try {
            annotateFileImages(spec, at.slug)
          } catch (e) {
            console.log(`[projects] file Images of ${at.chatFile} ${toolId} could not be annotated: ${e instanceof Error ? e.message : String(e)}`)
          }
          for (const im of pictureRequests(spec)) {
            try {
              origins ??= readOrigins(at.dir)
              im.el.image = storedImageState(at.dir, at.slug, originKey({ chatFile: at.chatFile, toolId, elementId: im.id }), origins)
            } catch (e) {
              // Everything under images/ is untrusted; a reload must still draw the surface.
              console.log(`[projects] picture state for ${at.chatFile} ${toolId}/${im.id} unreadable: ${e instanceof Error ? e.message : String(e)}`)
              im.el.image = { status: 'off', reason: 'the record of this picture could not be read' }
            }
          }
        }
        return { ...b, input: { surface: isSurfaceId(b.input.surface) ? b.input.surface : undefined, spec } }
      }),
    }
  })
  return { ...(t as object), messages } as T
}

export async function renameChatApi(d: ProjectsDeps, slug: string, file: string, body: unknown): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const title = typeof obj(body).title === 'string' ? (obj(body).title as string) : ''
  if (!title.trim()) return bad('title is required')
  const dir = projectDir(d.home, slug)
  if (!renameChat(dir, basename(file), title)) return notFound('chat')
  appendJournal(dir, 'chat.renamed', `${basename(file)} → ${title.trim()}`)
  await commitHistory(dir, [`chats/${basename(file)}`, 'journal.md'], `chat: rename ${basename(file)}`)
  return { status: 200, body: { file: basename(file), title: title.trim() } }
}

export async function rescanApi(d: ProjectsDeps, slug: string): Promise<ApiResult> {
  if (!readProject(d.home, slug)) return notFound('project')
  const counts = await rescanProject(d, slug, d.looks ?? null)
  return { status: 200, body: counts }
}
