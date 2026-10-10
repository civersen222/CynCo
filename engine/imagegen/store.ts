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
 * start with the PNG signature. All writes are synchronous read-modify-write
 * on the one JS thread, so two of them cannot interleave.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiImageState } from '../bridge/protocol.js'
import { projectDir, readProject, realInside, SLUG_RE, writeJsonAtomic } from '../projects/layout.js'
import { DOWNLOAD_CAP_BYTES } from './config.js'

/** This engine process. A queued/running record under another runId was left by an engine that stopped. */
export const RUN_ID = randomUUID()
export const KEY_RE = /^[0-9a-f]{32}$/
/** The only names the image route serves. */
export const IMAGE_NAME_RE = /^([0-9a-f]{32})\.(png|json)$/
export const ORIGINS_CAP = 5000
export const INTERRUPTED_REASON = 'interrupted — the engine stopped before this picture finished'
export const NOT_GENERATED_REASON = 'this picture was not generated'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
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
  let v: unknown
  try {
    v = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.log(`[imagegen] images/${key}.json is unreadable; treated as no record: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  const fault = sidecarFault(v, key)
  if (fault) { console.log(`[imagegen] images/${key}.json is not a valid record (${fault}); treated as no record`); return null }
  return v as ImageSidecar
}

export function writeSidecar(dir: string, sc: ImageSidecar): void {
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
  let v: unknown
  try {
    v = JSON.parse(readFileSync(p, 'utf8'))
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

/** Map each origin to its key (a re-mapped origin becomes the newest), keeping the newest ORIGINS_CAP. */
export function recordOrigins(dir: string, pairs: Array<[origin: string, key: string]>): void {
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

/** Append `images/*.png` to the project's .gitignore unless a line already says it. Idempotent. */
export function ensureImageIgnore(dir: string): void {
  const p = join(dir, '.gitignore')
  const text = existsSync(p) ? readFileSync(p, 'utf8') : ''
  if (text.split(/\r?\n/).some(l => l.trim() === 'images/*.png')) return
  writeFileSync(p, text + (text && !text.endsWith('\n') ? '\n' : '') + 'images/*.png\n', 'utf8')
}

// ─── readers for the route and for reload ─────────────────────────────

/** What the page may see of a sidecar: no paths, hosts or graph. */
export function publicSidecar(sc: ImageSidecar): Record<string, unknown> {
  const eff = effectiveStatus(sc)
  return {
    status: eff.status, ...(eff.reason !== undefined ? { reason: eff.reason } : {}),
    w: sc.width, h: sc.height, prompt: sc.prompt, alt: sc.alt, checkpoint: sc.checkpoint, seed: sc.seed, finishedAt: sc.finishedAt ?? null,
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
  let bytes: Uint8Array
  try {
    bytes = readFileSync(file)
  } catch (e) {
    console.log(`[imagegen] reading images/${name} in ${slug} failed: ${(e as Error).message}`)
    return missing
  }
  if (!isPng(bytes)) return { status: 415, json: { error: `images/${key}.png is not a PNG; refused` } }
  return { status: 200, bytes }
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
