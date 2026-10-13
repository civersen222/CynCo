/**
 * engine/imagegen/config.ts — where the ComfyUI server is and how pictures are made.
 *
 * Environment variables only (F174 design §1): every LAN service the engine
 * talks to is configured this way (`LOCALCODE_EMBED_BASE_URL`,
 * `LOCALCODE_JLENS_URL`, `LOCALCODE_SEARXNG_URL`), the variables already reach
 * every launch path, and a profile file replaces the bundled one wholesale, so
 * a YAML typo there would silently drop the setting. Each knob is a pure reader
 * `fn(env = process.env)` in the shape `envVarScan.mjs` derives a default from.
 *
 * `comfyConfig` is the synchronous, config-only check `ImageService` runs once
 * at engine start; a change needs a restart. Whether the server answers is the
 * probe's question (`probeComfy`, client.ts), not this file's.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { cyncoHome } from '../paths.js'
import { BUILTIN_WORKFLOW, BUILTIN_WORKFLOW_SHA, parseWorkflow, placeholdersIn, type ComfyGraph } from './workflow.js'

// ─── fixed in code, not knobs ─────────────────────────────────────────
// A different sampler, scheduler or model family means a custom workflow file.

export const SAMPLER = 'dpmpp_2m'
export const SCHEDULER = 'karras'
export const NEGATIVE_PROMPT = 'text, watermark, signature, logo, lowres, blurry, jpeg artifacts, deformed, disfigured, extra limbs, cropped, out of frame, multiple views, collage'
/** Generated pictures per RenderUI call (F176: three designs × six takes, ~3 min of GPU at ~10 s a picture — gen 9.4–10.4 s, 40 steps, 1024², SDXL base, measured 2026-10-13; it was 6, one design's takes); the rest of the call's Images are drawn as "off". */
export const PER_CALL_CAP = 18
/** Jobs waiting behind the one in flight. */
export const QUEUE_CAP = 48
export const DOWNLOAD_CAP_BYTES = 32 * 1024 * 1024
export const POLL_MS = 1000
const WORKFLOW_MAX_BYTES = 1024 * 1024

// ─── readers ──────────────────────────────────────────────────────────

/** The ComfyUI server, e.g. http://192.168.1.50:8188; '' when unset. */
export function comfyUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.LOCALCODE_COMFYUI_URL
  return v && v.trim() ? v.trim() : ''
}

/** A checkpoint name exactly as /models/checkpoints lists it; '' picks one. */
export function comfyCheckpoint(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.LOCALCODE_COMFYUI_CHECKPOINT
  return v && v.trim() ? v.trim() : ''
}

/** An API-format workflow file (absolute, or relative to cyncoHome()); '' is the built-in SDXL graph. */
export function comfyWorkflow(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.LOCALCODE_COMFYUI_WORKFLOW
  return v && v.trim() ? v.trim() : ''
}

/** `WxH`, checked by comfyConfig (a bad value is refused, not defaulted). */
export function comfySize(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.LOCALCODE_COMFYUI_SIZE
  return v && v.trim() ? v.trim() : '1024x1024'
}

/** Sampler steps, clamped 1–150. */
export function comfySteps(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOCALCODE_COMFYUI_STEPS)
  if (!Number.isFinite(n) || n <= 0) return 40
  return Math.min(150, Math.max(1, Math.round(n)))
}

/** Classifier-free guidance, clamped to (0, 30]. */
export function comfyCfg(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOCALCODE_COMFYUI_CFG)
  if (!Number.isFinite(n) || n <= 0) return 6
  return Math.min(30, n)
}

/** Per-job deadline from submit, in seconds, clamped 30–3600. */
export function comfyTimeoutS(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOCALCODE_COMFYUI_TIMEOUT_S)
  if (!Number.isFinite(n) || n <= 0) return 300
  return Math.min(3600, Math.max(30, Math.round(n)))
}

/** A workflow path as the operator wrote it, made absolute: relative paths sit under cyncoHome(). */
export function resolveWorkflowPath(p: string): string {
  return isAbsolute(p) ? p : join(cyncoHome(), p)
}

// ─── the check ────────────────────────────────────────────────────────

export type ComfyWorkflow = {
  /** 'builtin', or the resolved path of the operator's file. */
  source: string
  /** sha256 of the file's bytes, or BUILTIN_WORKFLOW_SHA. Part of every image key. */
  sha256: string
  graph: ComfyGraph
  /** Whether the graph has a `{{checkpoint}}`; only then is a checkpoint checked or picked. */
  usesCheckpoint: boolean
}

export type ComfyConfig = {
  /** Base URL: http(s), any path prefix kept, no trailing slash. */
  url: string
  /** host:port, for messages. */
  host: string
  port: string
  /** The configured checkpoint, or null to pick one when the server is probed. */
  checkpoint: string | null
  workflow: ComfyWorkflow
  width: number
  height: number
  steps: number
  cfg: number
  timeoutMs: number
  sampler: string
  scheduler: string
  negative: string
}

export const UNSET_REASON = 'image generation is not set up — set LOCALCODE_COMFYUI_URL to the ComfyUI server (e.g. http://192.168.1.50:8188)'

function parseBaseUrl(v: string): { url: string; host: string; port: string } | null {
  let u: URL
  try {
    u = new URL(v)
  } catch (e) {
    console.log(`[imagegen] LOCALCODE_COMFYUI_URL does not parse as a URL: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, host: u.host, port: u.port || (u.protocol === 'https:' ? '443' : '80') }
}

function parseSize(v: string): { width: number; height: number } | null {
  const m = /^(\d{3,4})\s*[xX]\s*(\d{3,4})$/.exec(v)
  if (!m) return null
  const ok = (n: number) => n % 64 === 0 && n >= 512 && n <= 2048
  const width = Number(m[1]), height = Number(m[2])
  return ok(width) && ok(height) ? { width, height } : null
}

function loadWorkflow(setting: string): { ok: true; workflow: ComfyWorkflow } | { ok: false; reason: string } {
  if (!setting) return { ok: true, workflow: { source: 'builtin', sha256: BUILTIN_WORKFLOW_SHA, graph: BUILTIN_WORKFLOW, usesCheckpoint: true } }
  const path = resolveWorkflowPath(setting)
  const refuse = (detail: string) => ({ ok: false as const, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${detail}` })
  let bytes: Buffer
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return refuse(`no file at ${path}`)
    if (statSync(path).size > WORKFLOW_MAX_BYTES) return refuse(`${path} is over 1 MB`)
    bytes = readFileSync(path)
  } catch (e) {
    console.log(`[imagegen] reading the workflow at ${path} failed: ${e instanceof Error ? e.message : String(e)}`)
    return refuse(`${path} could not be read (${e instanceof Error ? e.message : String(e)})`)
  }
  const parsed = parseWorkflow(bytes.toString('utf8'), path)
  if (!parsed.ok) return refuse(parsed.reason)
  return { ok: true, workflow: { source: path, sha256: createHash('sha256').update(bytes).digest('hex'), graph: parsed.graph, usesCheckpoint: placeholdersIn(parsed.graph).has('checkpoint') } }
}

/** Everything the environment says about image generation, or the one reason it cannot run. Never throws. */
export function comfyConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; cfg: ComfyConfig } | { ok: false; reason: string } {
  const raw = comfyUrl(env)
  if (!raw) return { ok: false, reason: UNSET_REASON }
  const base = parseBaseUrl(raw)
  if (!base) return { ok: false, reason: `LOCALCODE_COMFYUI_URL="${raw}" is not an http(s) URL like http://192.168.1.50:8188` }
  const sizeRaw = comfySize(env)
  const size = parseSize(sizeRaw)
  if (!size) return { ok: false, reason: `LOCALCODE_COMFYUI_SIZE="${sizeRaw}" must be WIDTHxHEIGHT, each a multiple of 64 from 512 to 2048` }
  const wf = loadWorkflow(comfyWorkflow(env))
  if (!wf.ok) return wf
  return {
    ok: true,
    cfg: {
      ...base, checkpoint: comfyCheckpoint(env) || null, workflow: wf.workflow, ...size,
      steps: comfySteps(env), cfg: comfyCfg(env), timeoutMs: comfyTimeoutS(env) * 1000,
      sampler: SAMPLER, scheduler: SCHEDULER, negative: NEGATIVE_PROMPT,
    },
  }
}
