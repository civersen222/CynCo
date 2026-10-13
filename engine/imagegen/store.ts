/**
 * engine/imagegen/store.ts — a project's pictures on disk.
 *
 *   <project>/images/<key>.png       the picture — git-ignored (images/*.png)
 *   <project>/images/<key>.json      sidecar: how it was made — committed
 *   <project>/images/index.json      { schema: 1, origins: { "<chatFile>#<toolId>#<elementId>": key } } — committed
 *   <project>/.cynco/tmp/<key>.part  a download in flight, renamed into images/ when complete
 *
 * Not under knowledge/ or artifacts/: `rescanProject` walks those and would
 * journal every PNG as unindexed. Everything here is untrusted on read — the
 * model can write anywhere in a project (`gradeProjectCall`), images/
 * included — so keys are checked against KEY_RE, sidecar fields are
 * type-checked (a bad file reads as no record), origins land in a
 * null-prototype map, files are found by key only, and a served PNG must
 * start with the PNG signature. A file is read only when it is a regular file
 * under a size cap (`readSmallFile`): a planted FIFO or a link to /dev/zero
 * would otherwise freeze the engine's one thread. Nothing is written through
 * a link (`storeFault`). All writes are synchronous read-modify-write on the
 * one JS thread, so two of them cannot interleave.
 *
 * An Image may also show a file the model wrote anywhere in the project
 * (`fileImages`, `annotateFileImages`, `servedProjectFile`): a relative
 * png/jpg/gif/webp/svg path the validator kept (`projectImagePath`), served
 * under the same guards as a picture — the real path inside the project, a
 * regular file under a cap, the format's signature — and under its own.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiElement, UiImageState, UiSpec } from '../bridge/protocol.js'
import { projectDir, readProject, realInside, SLUG_RE, writeJsonAtomic } from '../projects/layout.js'
import { projectImagePath } from '../genui/spec.js'
import { DOWNLOAD_CAP_BYTES } from './config.js'

/** This engine process. A queued/running record under another runId was left by an engine that stopped. */
export const RUN_ID = randomUUID()
export const KEY_RE = /^[0-9a-f]{32}$/
/** The only names the image route serves. */
export const IMAGE_NAME_RE = /^([0-9a-f]{32})\.(png|json)$/
export const ORIGINS_CAP = 5000
export const INTERRUPTED_REASON = 'interrupted — the engine stopped before this picture finished'
export const NOT_GENERATED_REASON = 'this picture was not generated'
/** A file Image outside a project chat: there is no project folder to show it from. */
export const FILES_ONLY_REASON = 'files are shown in project chats only'
/** The cap on an SVG the file route serves: text the browser parses, and far past any drawing a model writes. */
export const SVG_CAP_BYTES = 2 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** The file route's types and names, by the checked extension; the type is never sniffed. */
const FILE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
const FILE_NAMES: Record<string, string> = { png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', webp: 'WEBP', svg: 'SVG' }
/** Read caps. A sidecar holds the filled graph, so it allows for a 1 MB workflow pretty-printed; the index for ORIGINS_CAP long origins. */
const SIDECAR_CAP = 8 * 1024 * 1024
const INDEX_CAP = 4 * 1024 * 1024
const IGNORE_CAP = 1024 * 1024
/** "<chatFile>#<toolId>#<elementId>": three '#'-free parts, the last an element id. */
const ORIGIN_RE = /^[^#\s]{1,200}#[^#\s]{1,200}#[A-Za-z0-9_-]{1,40}$/

export type ImageStatus = 'queued' | 'running' | 'done' | 'failed'
export type ImageRef = { filename: string; subfolder: string; type: 'output' | 'temp' }
export type ImageOrigin = { chatFile: string; toolId: string; elementId: string; surfaceId: string }

/** Sidecar schema 1: everything a later step (image → 3D → STL) needs to know about how the picture was made. */
export type ImageSidecar = {
  schema: 1
  key: string
  status: ImageStatus
  reason?: string
  runId: string
  prompt: string
  negative: string
  alt: string
  seed: number
  /** Where the seed came from: the Image's own "seed" (another take), or derived from the prompt; absent on records from before the field. */
  seedFrom?: 'model' | 'prompt'
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  /** The resolved checkpoint name, or 'auto' until a probe resolves it. */
  checkpoint: string
  workflow: { source: string; sha256: string }
  /** The filled graph actually submitted; null until the job starts. */
  apiPrompt: Record<string, unknown> | null
  comfy: { host: string; promptId: string; outputs: ImageRef[] }
  sha256?: string
  bytes?: number
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  queueMs?: number
  genMs?: number
  execMs?: number
  origin: ImageOrigin
}

/** The fields an image key is derived from. */
export type KeyFields = {
  prompt: string; negative: string; seed: number; width: number; height: number; steps: number; cfg: number
  sampler: string; scheduler: string; checkpoint: string; workflow: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

function bytesAt(b: Uint8Array, at: number, sig: number[]): boolean {
  if (b.length < at + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false
  return true
}

/**
 * Whether `b` is an SVG document: after an optional BOM, whitespace, an XML
 * declaration ("<?xml" then whitespace — not an "<?xml-stylesheet" or any
 * other processing instruction), a DOCTYPE (one without an internal subset —
 * entities are not served) and comments, the first tag is <svg. Only the
 * head is read. An <img> runs no script and loads no external resource from
 * an SVG and the route adds a sandbox CSP for a direct open; this check
 * keeps a renamed HTML page or PNG from going out as image/svg+xml at all.
 */
export function isSvg(b: Uint8Array): boolean {
  let s = Buffer.from(b.subarray(0, 4096)).toString('utf8')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  let i = 0
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (/^<\?xml\s/.test(s.slice(i, i + 6))) { const e = s.indexOf('?>', i); if (e < 0) return false; i = e + 2; continue }
    if (s.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') { const e = doctypeEnd(s, i + 9); if (e < 0) return false; i = e + 1; continue }
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); if (e < 0) return false; i = e + 3; continue }
    break
  }
  return /^<svg[\s>/]/i.test(s.slice(i, i + 5))
}

/**
 * The index of the '>' that ends a DOCTYPE whose name starts at `from`, or
 * -1 when it is unclosed or a '[' (an internal subset) comes first. A '>' or
 * '[' inside one of its quoted literals (SYSTEM "a>b.dtd") is part of the
 * literal: taking the first '>' as the end let a literal holding one hide
 * the subset after it (review of the file route).
 */
function doctypeEnd(s: string, from: number): number {
  let quote = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = '' }
    else if (c === '"' || c === "'") quote = c
    else if (c === '[') return -1
    else if (c === '>') return i
  }
  return -1
}

/** Whether the bytes carry the signature of the format the extension names. */
function hasSignature(ext: string, b: Uint8Array): boolean {
  switch (ext) {
    case 'png': return isPng(b)
    case 'jpg': case 'jpeg': return bytesAt(b, 0, [0xff, 0xd8, 0xff])
    case 'gif': return bytesAt(b, 0, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
    case 'webp': return bytesAt(b, 0, [0x52, 0x49, 0x46, 0x46]) && bytesAt(b, 8, [0x57, 0x45, 0x42, 0x50])
    case 'svg': return isSvg(b)
    default: return false
  }
}

export function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x)
}

/** Trimmed, every whitespace run one space: two spellings of one prompt are one picture. */
export function normPrompt(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * The KSampler seed for a prompt: the first 48 bits of its hash, so the same
 * prompt paints the same picture everywhere in a project. Element ids are left
 * out on purpose — models rename ids across re-renders and that must not repaint.
 */
export function seedFor(prompt: string, negative: string): number {
  return parseInt(sha256(prompt + '\n' + negative).slice(0, 12), 16)
}

/** JSON with every object's keys sorted, so equal values hash equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** 32 hex characters naming one generation request; known before any network call. */
export function imageKey(f: KeyFields): string {
  return sha256(canonicalJson({ v: 1, ...f })).slice(0, 32)
}

export function originKey(o: { chatFile: string; toolId: string; elementId: string }): string {
  return `${o.chatFile}#${o.toolId}#${o.elementId}`
}

function assertKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error(`bad image key: ${key.slice(0, 40)}`)
  return key
}
export function imagesDir(dir: string): string { return join(dir, 'images') }
export function sidecarPath(dir: string, key: string): string { return join(dir, 'images', `${assertKey(key)}.json`) }
export function pngPath(dir: string, key: string): string { return join(dir, 'images', `${assertKey(key)}.png`) }
export function partPath(dir: string, key: string): string { return join(dir, '.cynco', 'tmp', `${assertKey(key)}.part`) }
export function originsPath(dir: string): string { return join(dir, 'images', 'index.json') }

// ─── untrusted files ──────────────────────────────────────────────────

/**
 * A file the model may have planted, read only when it is a regular file of
 * at most `cap` bytes. Opened non-blocking and checked on the open
 * descriptor, so a FIFO (a plain read blocks until a writer comes), a device
 * (a link to /dev/zero never ends) or a huge file is refused at once. null,
 * logged, when refused or unreadable: the caller reads that as no record.
 */
function readSmallFile(p: string, cap: number, label: string): Buffer | null {
  let fd: number
  try {
    fd = openSync(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (e) {
    console.log(`[imagegen] ${label} could not be opened: ${(e as Error).message}`)
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) { console.log(`[imagegen] ${label} is not a regular file; not read`); return null }
    if (st.size > cap) { console.log(`[imagegen] ${label} is ${st.size} bytes, over the ${cap}-byte cap; not read`); return null }
    const buf = Buffer.alloc(st.size)
    let n = 0
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n)
      if (r === 0) break
      n += r
    }
    return buf.subarray(0, n)
  } catch (e) {
    console.log(`[imagegen] reading ${label} failed: ${(e as Error).message}`)
    return null
  } finally {
    try {
      closeSync(fd)
    } catch (e) {
      console.log(`[imagegen] closing ${label} failed: ${(e as Error).message}`)
    }
  }
}

/** Why the engine must not write into `<dir>/<rel>/` (`rel` '/'-separated; join makes it native), or null: it must be a real folder (not a link or junction) inside the project, or not exist yet. */
function folderFault(dir: string, rel: string): string | null {
  const p = join(dir, rel)
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return `${rel}/ in the project is a link; pictures are written only into a real folder inside it — refused`
    if (!st.isDirectory()) return `${rel} in the project is not a folder; refused`
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.log(`[imagegen] lstat ${p} failed: ${(e as Error).message}`)
      return `${rel}/ in the project could not be checked (${code ?? (e as Error).message}); refused`
    }
  }
  // A parent link (.cynco -> elsewhere) passes the lstat above; the real path does not.
  const r = realInside(dir, p)
  return r.inside ? null : `${rel}/ leads outside the project (to ${r.real}); refused`
}

const IGNORE_FAULT = '.gitignore in the project is a link or not a regular file; the engine will not write through it — refused'

function ignoreFault(dir: string): string | null {
  try {
    return lstatSync(join(dir, '.gitignore')).isFile() ? null : IGNORE_FAULT
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    console.log(`[imagegen] lstat .gitignore in ${dir} failed: ${(e as Error).message}`)
    return IGNORE_FAULT
  }
}

/**
 * Why the engine must not store pictures in this project, or null. The model
 * can write anywhere in a project, links included (`gradeProjectCall`), so
 * `images/` and `.cynco/tmp/` must each be a real folder inside it (or not
 * exist yet) and `.gitignore` a regular file (or absent). Checked when the
 * pictures are annotated, when a job starts and again at its write, so a link
 * planted while a job ran is caught before anything follows it.
 */
export function storeFault(dir: string): string | null {
  return folderFault(dir, 'images') ?? folderFault(dir, '.cynco/tmp') ?? ignoreFault(dir)
}

function assertImagesFolder(dir: string): void {
  const fault = folderFault(dir, 'images')
  if (fault) throw new Error(fault)
}

// ─── sidecars ─────────────────────────────────────────────────────────

const STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'failed'])
const str = (v: unknown) => typeof v === 'string'
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const optional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v)

/** The first field that is wrong, or null when the record is a valid sidecar for `key`. */
function sidecarFault(v: unknown, key: string): string | null {
  if (!isObj(v)) return 'not an object'
  if (v.schema !== 1) return 'schema'
  if (v.key !== key) return 'key'
  if (!str(v.status) || !STATUSES.has(v.status as string)) return 'status'
  for (const f of ['runId', 'prompt', 'negative', 'alt', 'sampler', 'scheduler', 'checkpoint', 'queuedAt']) if (!str(v[f])) return f
  for (const f of ['seed', 'width', 'height', 'steps', 'cfg']) if (!num(v[f])) return f
  for (const f of ['reason', 'sha256', 'startedAt', 'finishedAt']) if (!optional(v[f], str)) return f
  for (const f of ['bytes', 'queueMs', 'genMs', 'execMs']) if (!optional(v[f], num)) return f
  if (!optional(v.seedFrom, x => x === 'model' || x === 'prompt')) return 'seedFrom'
  if (!isObj(v.workflow) || !str(v.workflow.source) || !str(v.workflow.sha256)) return 'workflow'
  if (v.apiPrompt !== null && !isObj(v.apiPrompt)) return 'apiPrompt'
  const c = v.comfy
  if (!isObj(c) || !str(c.host) || !str(c.promptId) || !Array.isArray(c.outputs)) return 'comfy'
  if (!c.outputs.every(o => isObj(o) && str(o.filename) && str(o.subfolder) && (o.type === 'output' || o.type === 'temp'))) return 'comfy.outputs'
  const o = v.origin
  if (!isObj(o) || !str(o.chatFile) || !str(o.toolId) || !str(o.elementId) || !str(o.surfaceId)) return 'origin'
  return null
}

/** The sidecar for `key`, or null when there is none or it is not a valid record. */
export function readSidecar(dir: string, key: string): ImageSidecar | null {
  if (!KEY_RE.test(key)) return null
  const p = sidecarPath(dir, key)
  if (!existsSync(p)) return null
  const raw = readSmallFile(p, SIDECAR_CAP, `images/${key}.json`)
  if (raw === null) return null
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    console.log(`[imagegen] images/${key}.json is unreadable; treated as no record: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  const fault = sidecarFault(v, key)
  if (fault) { console.log(`[imagegen] images/${key}.json is not a valid record (${fault}); treated as no record`); return null }
  return v as ImageSidecar
}

/** Throws, naming the fault, when images/ is a link or leads outside the project. */
export function writeSidecar(dir: string, sc: ImageSidecar): void {
  assertImagesFolder(dir)
  mkdirSync(imagesDir(dir), { recursive: true })
  writeJsonAtomic(sidecarPath(dir, sc.key), sc)
}

/** A record's status as a reader should report it: queued/running from another engine run is failed. */
export function effectiveStatus(sc: ImageSidecar): { status: ImageStatus; reason?: string } {
  if ((sc.status === 'queued' || sc.status === 'running') && sc.runId !== RUN_ID) return { status: 'failed', reason: INTERRUPTED_REASON }
  return sc.reason !== undefined ? { status: sc.status, reason: sc.reason } : { status: sc.status }
}

// ─── origins ──────────────────────────────────────────────────────────

/** origin → key, in insertion order, in a null-prototype map. Every entry passes ORIGIN_RE and KEY_RE. */
export function readOrigins(dir: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  const p = originsPath(dir)
  if (!existsSync(p)) return out
  const raw = readSmallFile(p, INDEX_CAP, 'images/index.json')
  if (raw === null) return out
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    console.log(`[imagegen] images/index.json is unreadable; no origins read: ${e instanceof Error ? e.message : String(e)}`)
    return out
  }
  if (!isObj(v) || v.schema !== 1 || !isObj(v.origins)) { console.log('[imagegen] images/index.json is not { schema: 1, origins }; no origins read'); return out }
  const origins = v.origins
  for (const k of Object.keys(origins)) {
    const key = origins[k]
    if (ORIGIN_RE.test(k) && typeof key === 'string' && KEY_RE.test(key)) out[k] = key
  }
  return out
}

/** Map each origin to its key (a re-mapped origin becomes the newest), keeping the newest ORIGINS_CAP. Throws like `writeSidecar`. */
export function recordOrigins(dir: string, pairs: Array<[origin: string, key: string]>): void {
  assertImagesFolder(dir)
  const map = readOrigins(dir)
  for (const [origin, key] of pairs) {
    if (!ORIGIN_RE.test(origin) || !KEY_RE.test(key)) { console.log(`[imagegen] origin "${origin.slice(0, 80)}" → ${key.slice(0, 40)} not recorded: not an origin/key pair`); continue }
    delete map[origin]
    map[origin] = key
  }
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - ORIGINS_CAP))) delete map[k]
  mkdirSync(imagesDir(dir), { recursive: true })
  writeJsonAtomic(originsPath(dir), { schema: 1, origins: map })
}

/**
 * Append `images/*.png` to the project's .gitignore unless a line already says
 * it. Idempotent. Returns why it refused — a .gitignore that is a link, a
 * FIFO or too big — or null. Written to a fresh temp file and renamed over,
 * so a link planted after the check is replaced, never written through.
 */
export function ensureImageIgnore(dir: string): string | null {
  const fault = ignoreFault(dir)
  if (fault) return fault
  const p = join(dir, '.gitignore')
  let text = ''
  if (existsSync(p)) {
    const raw = readSmallFile(p, IGNORE_CAP, '.gitignore')
    if (raw === null) return IGNORE_FAULT
    text = raw.toString('utf8')
  }
  if (text.split(/\r?\n/).some(l => l.trim() === 'images/*.png')) return null
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(tmp, text + (text && !text.endsWith('\n') ? '\n' : '') + 'images/*.png\n', { encoding: 'utf8', flag: 'wx' })
  renameSync(tmp, p)
  return null
}

// ─── readers for the route and for reload ─────────────────────────────

/** Every element reachable from the root, in draw order (depth-first), with its props when they are an object. */
function reachableElements(spec: UiSpec): Array<{ id: string; el: UiElement; props: Record<string, unknown> | null }> {
  const out: Array<{ id: string; el: UiElement; props: Record<string, unknown> | null }> = []
  const els = spec.elements
  const seen = new Set<string>()
  const stack: string[] = [spec.root]
  while (stack.length && seen.size < 1000) {
    const id = stack.pop()!
    if (typeof id !== 'string' || seen.has(id) || !Object.hasOwn(els, id)) continue
    seen.add(id)
    const el = els[id]
    if (!isObj(el)) continue
    out.push({ id, el, props: isObj(el.props) ? el.props : null })
    if (Array.isArray(el.children)) for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i])
  }
  return out
}

/**
 * Every Image with a non-empty prompt, in draw order (depth-first from the
 * root), with its "seed" when the model gave one (a safe non-negative
 * integer — the validator's rule, checked again here because a replayed
 * transcript spec is unvalidated). The one definition of "a picture the
 * engine paints": `annotate` queues these and a reloaded chat
 * (`withValidatedSurfaces`) looks these up.
 */
export function promptedImages(spec: UiSpec): Array<{ id: string; el: UiElement; prompt: string; alt: string; seed?: number }> {
  const out: Array<{ id: string; el: UiElement; prompt: string; alt: string; seed?: number }> = []
  for (const { id, el, props } of reachableElements(spec)) {
    if (el.type !== 'Image' || !props || typeof props.prompt !== 'string') continue
    const prompt = normPrompt(props.prompt)
    if (!prompt) continue
    const seed = typeof props.seed === 'number' && Number.isSafeInteger(props.seed) && props.seed >= 0 ? props.seed : undefined
    out.push({ id, el, prompt, alt: typeof props.alt === 'string' ? normPrompt(props.alt).slice(0, 200) : '', ...(seed !== undefined ? { seed } : {}) })
  }
  return out
}

/**
 * Every Image whose src is the path of a file in the project (and no
 * prompt), in draw order: the one definition of "a file the Image shows",
 * checked against the validator's rule again here so no unchecked path ever
 * reaches an annotation.
 */
export function fileImages(spec: UiSpec): Array<{ id: string; el: UiElement; path: string }> {
  const out: Array<{ id: string; el: UiElement; path: string }> = []
  for (const { id, el, props } of reachableElements(spec)) {
    if (el.type !== 'Image' || !props || typeof props.prompt === 'string') continue
    const path = projectImagePath(props.src)
    if (path !== null) out.push({ id, el, path })
  }
  return out
}

/**
 * Give each file Image its engine-only state and take the path out of its
 * props: in a project chat (`slug`) the file state the page fetches from
 * GET /api/projects/:slug/files/<path>; elsewhere off with the reason. Run by
 * `ImageService.annotate` on the live final frame and by
 * `withValidatedSurfaces` on a reload, whether or not the file is there —
 * the route and the page say when it is not. Returns what was annotated.
 */
export function annotateFileImages(spec: UiSpec, slug: string | null): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = []
  for (const im of fileImages(spec)) {
    im.el.image = slug === null ? { status: 'off', reason: FILES_ONLY_REASON } : { status: 'file', slug, path: im.path }
    if (isObj(im.el.props)) delete im.el.props.src
    out.push({ id: im.id, path: im.path })
  }
  return out
}


/** What the page may see of a sidecar: no paths, hosts or graph. */
export function publicSidecar(sc: ImageSidecar): Record<string, unknown> {
  const eff = effectiveStatus(sc)
  return {
    status: eff.status, ...(eff.reason !== undefined ? { reason: eff.reason } : {}),
    w: sc.width, h: sc.height, prompt: sc.prompt, alt: sc.alt, checkpoint: sc.checkpoint, seed: sc.seed, ...(sc.seedFrom ? { seedFrom: sc.seedFrom } : {}), finishedAt: sc.finishedAt ?? null,
  }
}

/**
 * `GET /api/projects/:slug/images/:name` without the HTTP: a status plus PNG
 * bytes or a JSON body. The name must be `<32 hex>.png|json`; the file must
 * really be inside the project's images/ (links followed), a regular file, at
 * most 32 MB, and a PNG must start with the PNG signature.
 */
export function servedImage(home: string, slug: string, name: string): { status: number; bytes?: Uint8Array; json?: unknown } {
  if (!SLUG_RE.test(slug)) return { status: 400, json: { error: 'bad slug' } }
  const m = IMAGE_NAME_RE.exec(name)
  if (!m) return { status: 400, json: { error: 'bad image name' } }
  const [, key, ext] = m
  if (!readProject(home, slug)) return { status: 404, json: { error: 'no such project' } }
  const dir = projectDir(home, slug)
  const file = join(dir, 'images', name)
  const missing = { status: 404, json: { error: 'no such image' } }
  if (!realInside(join(dir, 'images'), file).inside || !realInside(dir, file).inside) return missing
  let size: number
  try {
    const st = statSync(file)
    if (!st.isFile()) return missing
    size = st.size
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[imagegen] stat images/${name} in ${slug} failed: ${(e as Error).message}`)
    return missing
  }
  if (size > DOWNLOAD_CAP_BYTES) return { status: 413, json: { error: `images/${name} is larger than 32 MB; refused` } }
  if (ext === 'json') {
    const sc = readSidecar(dir, key)
    return sc ? { status: 200, json: publicSidecar(sc) } : missing
  }
  // Re-checked on the open file: a FIFO swapped in since the stat must not hang the route.
  const bytes = readSmallFile(file, DOWNLOAD_CAP_BYTES, `images/${name} in ${slug}`)
  if (bytes === null) return missing
  if (!isPng(bytes)) return { status: 415, json: { error: `images/${key}.png is not a PNG; refused` } }
  return { status: 200, bytes }
}

/**
 * `<dir>/<rel>` when it is a regular file whose real path is inside the
 * project (symlinks followed) and that has no other name, else null; logged
 * unless simply absent. A hard link has no target to follow — its real path
 * is the in-project name — so its content may live outside the project: a
 * file with more than one link is refused like a link out (review of the
 * file route). The model's own file has one name.
 */
function regularFileInside(dir: string, rel: string, label: string): { file: string; size: number } | null {
  const file = join(dir, rel)
  if (!realInside(dir, file).inside) return null
  try {
    const st = statSync(file)
    return st.isFile() && !(st.nlink > 1) ? { file, size: st.size } : null
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.log(`[imagegen] stat ${label} failed: ${(e as Error).message}`)
    return null
  }
}

/** Whether a checked relative path names a regular file really inside the project: what `annotate` tells the model about a file Image. */
export function isProjectFile(dir: string, rel: string): boolean {
  return regularFileInside(dir, rel, rel) !== null
}

/**
 * `GET /api/projects/:slug/files/<path>` without the HTTP: a status plus the
 * bytes and their fixed type, or a JSON body. The decoded path must pass the
 * validator's own rule (`projectImagePath`: 400 otherwise, so `..`, a
 * backslash, a NUL or a dot-leading segment never reaches a join), the file
 * must really be inside the project (symlinks followed, a hard link refused;
 * 404 otherwise, like a missing one), a regular file, at most 32 MB (an SVG
 * 2 MB; 413), and carry its format's signature (415) — an SVG must start
 * with <svg after the optional BOM, XML declaration, DOCTYPE and comments.
 */
export function servedProjectFile(home: string, slug: string, path: string): { status: number; bytes?: Uint8Array; type?: string; json?: unknown } {
  if (!SLUG_RE.test(slug)) return { status: 400, json: { error: 'bad slug' } }
  const rel = projectImagePath(path)
  if (rel === null) return { status: 400, json: { error: 'bad file path' } }
  if (!readProject(home, slug)) return { status: 404, json: { error: 'no such project' } }
  const dir = projectDir(home, slug)
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
  const svg = ext === 'svg'
  const cap = svg ? SVG_CAP_BYTES : DOWNLOAD_CAP_BYTES
  const missing = { status: 404, json: { error: 'no such file' } }
  const found = regularFileInside(dir, rel, `${rel} in ${slug}`)
  if (!found) return missing
  if (found.size > cap) return { status: 413, json: { error: `${rel} is larger than ${svg ? 2 : 32} MB; refused` } }
  // Re-checked on the open file: a FIFO swapped in since the stat must not hang the route.
  const bytes = readSmallFile(found.file, cap, `${rel} in ${slug}`)
  if (bytes === null) return missing
  if (!hasSignature(ext, bytes)) return { status: 415, json: { error: `${rel} is not a ${FILE_NAMES[ext]} file; refused` } }
  return { status: 200, bytes, type: FILE_TYPES[ext] }
}

/**
 * The picture state a reloaded chat's Image shows, found through the origin
 * index (the exact picture shown live, even if the knobs changed since and a
 * re-derived key would differ). Pass `origins` to read index.json once for a
 * whole transcript.
 */
export function storedImageState(dir: string, slug: string, origin: string, origins: Record<string, string> = readOrigins(dir)): UiImageState {
  if (!Object.hasOwn(origins, origin)) return { status: 'off', reason: NOT_GENERATED_REASON }
  const key = origins[origin]
  const sc = readSidecar(dir, key)
  if (!sc) return { status: 'off', reason: `the record of this picture (images/${key}.json) is missing or unreadable` }
  const eff = effectiveStatus(sc)
  const base = { key, slug, w: sc.width, h: sc.height }
  if (eff.status === 'done' && !existsSync(pngPath(dir, key))) return { status: 'failed', ...base, reason: `images/${key}.png is missing` }
  return eff.reason !== undefined ? { status: eff.status, ...base, reason: eff.reason } : { status: eff.status, ...base }
}
