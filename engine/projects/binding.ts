/**
 * engine/projects/binding.ts — what the loop holds while a project is open,
 * and how a tool call is graded there.
 *
 * The grader is the single allowed-root check for file tools (the REAL path —
 * symlinks and junctions followed — under the project folder, no `..`, no
 * sibling, no Glob pattern that climbs out) and the Bash grade: every
 * download is `risky` (the user approves every download — standing rule),
 * otherwise the guardian classifier's word; `dangerous` is refused, `risky`
 * asks, `safe` runs. The classifier is passed in because this package never
 * imports from engine/bridge. One fence is this package's own (`comfyFence`):
 * a command at the operator's ComfyUI, or a file that would drive it, is
 * `dangerous`, and a command that merely names the server asks, because
 * pictures are the engine's to make from RenderUI Image prompts.
 */
import { isAbsolute, resolve } from 'node:path'
import type { EmbedClient } from '../index/embedClient.js'
import { isDownloadCommand } from '../tools/approvalGate.js'
import { projectDir, readInstructions, readProject, realInside } from './layout.js'
import { readTranscript, trimDanglingToolCall, type TranscriptMessage } from './chat.js'
import type { IngestEvent } from './ingest.js'
import type { Citation } from './retrieval.js'
import { ensureHistory } from './history.js'
import { touchOpened, readRegistry, upsertRegistry } from './registry.js'
import { appendJournal } from './layout.js'

export type ProjectBinding = {
  home: string; slug: string; dir: string; name: string; description: string; instructions: string
  chatFile: string | null; chatTitle: string | null
  embed: EmbedClient | null; embedModel: string
  contextLength: number
  emit?: (e: IngestEvent) => void
  citations: Citation[]
}
export type Grade = { level: 'safe' | 'risky' | 'dangerous'; reason: string }
export type Classifier = (toolName: string, input: Record<string, unknown>) => 'safe' | 'risky' | 'dangerous'

export const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Ls', 'ImageView', 'NotebookEdit', 'ApplyPatch', 'ReplaceFunction'])

/**
 * Why a Bash command, or a file about to be written, that drives ComfyUI is
 * refused in a project chat (F176). The live run of 2026-10-12/13 wrote a workflow
 * of six KSamplers per design and drove the server by hand (POST /prompt,
 * poll /history, GET /view, renders saved under the project — through curl
 * and a render script of its own) because a project "directive" told it to;
 * the engine paints from Image prompts (engine/imagegen) and keeps every picture.
 */
export const COMFY_FENCE_REASON = 'pictures are made by the engine from RenderUI Image prompts; a project chat never drives ComfyUI itself — ask with an Image prompt (and a seed for another take)'

/**
 * Why a command that merely names the server — an echo, a grep, a script's
 * argument — asks instead of running: the address is not a call, and the
 * user sees the command (review: an echo naming it was refused outright).
 */
export const COMFY_MENTION_REASON = 'names the ComfyUI server — pictures are made by the engine from RenderUI Image prompts, and a project chat never drives ComfyUI itself'

/**
 * `host:port` of LOCALCODE_COMFYUI_URL (lower-cased; the port's leading zeros
 * dropped; the scheme's port when none is given), or null when it is unset
 * or not an http(s) URL. A small parser of its own: engine/imagegen's reader
 * sits beside imports of projects/layout and would cycle.
 */
export function comfyHostFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.LOCALCODE_COMFYUI_URL
  const raw = v && v.trim() ? v.trim() : ''
  const m = /^(https?):\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)(?::(\d{1,5}))?(?=$|[/?#])/i.exec(raw)
  if (!m) return null
  return `${m[2].toLowerCase()}:${m[3] ? String(Number(m[3])) : (m[1].toLowerCase() === 'https' ? '443' : '80')}`
}

/**
 * ComfyUI's own API on any host's 8188 (a leading zero in the port too — curl
 * and urllib take `:08188`): the routes it is driven by, with or without the
 * `/api/` prefix its web client uses, ended by anything but a name character
 * (`/queue>queue.json` is the route; `/promptly` is not). `/api/health` is left out.
 */
const COMFY_API_ON_8188 = /:0*8188\/(?:api\/)?(?:prompt|history|view|object_info|queue|interrupt|system_stats|ws|upload\/(?:image|mask))(?![A-Za-z0-9_-])/i

/** A network client a command or a script reaches a server with. */
const NET_CLIENT = /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|requests|urllib|httpx|aiohttp|http\.client|websockets?|fetch|nc|ncat|WebClient|HttpClient)\b/i

/** The variable that holds the server's URL, however it is read: `$LOCALCODE_COMFYUI_URL`, `$env:…`, `os.environ[…]`. */
const COMFY_ENV_NAME = /\bLOCALCODE_COMFYUI_URL\b/

type FenceTarget = { named: RegExp; url: RegExp | null }

/**
 * The configured `host:port` as a command spells it: the name, then the port
 * (leading zeros allowed; optional when it is the scheme's default, which no
 * command spells — `http://comfy.local/prompt`), neither inside a longer name
 * (`comfy.localhost`, `notcomfy.local`) nor followed by another port.
 */
function hostTarget(host: string): FenceTarget {
  const i = host.lastIndexOf(':')
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = esc(host.slice(0, i)), port = host.slice(i + 1)
  const portPart = `:0*${esc(port)}`
  const core = `${name}${port === '80' || port === '443' ? `(?:${portPart})?` : portPart}(?![A-Za-z0-9_.:-])`
  return {
    named: new RegExp(`(?<![A-Za-z0-9_.-])${core}`, 'i'),
    url: new RegExp(`\\b(?:https?|wss?)://(?:[^\\s/?#@"']*@)?${core}`, 'i'),
  }
}

/**
 * `dangerous` when `text` — a Bash command, or a file about to be written —
 * drives ComfyUI: its API on any host's 8188, or the configured server (its
 * `host:port`, or LOCALCODE_COMFYUI_URL by name) in a URL or beside a network
 * client; `risky` when the text merely names the server; else null. The
 * natural forms, not every form: a script that takes the address from a
 * config file or opens a raw socket is the prompt's rule, not the fence's.
 */
export function comfyFence(text: string, host: string | null = comfyHostFromEnv()): Grade | null {
  if (COMFY_API_ON_8188.test(text)) return { level: 'dangerous', reason: COMFY_FENCE_REASON }
  const targets: FenceTarget[] = [{ named: COMFY_ENV_NAME, url: null }]
  if (host) targets.push(hostTarget(host))
  let named = false
  for (const t of targets) {
    if (!t.named.test(text)) continue
    if ((t.url && t.url.test(text)) || NET_CLIENT.test(text)) return { level: 'dangerous', reason: COMFY_FENCE_REASON }
    named = true
  }
  return named ? { level: 'risky', reason: COMFY_MENTION_REASON } : null
}

/** What a file tool would write: Write's content, Edit's and each MultiEdit edit's new_string, NotebookEdit's new_source, ApplyPatch's patch, ReplaceFunction's new_body. */
function writtenText(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const f of ['content', 'new_string', 'new_source', 'patch', 'new_body']) if (typeof input[f] === 'string') parts.push(input[f] as string)
  if (Array.isArray(input.edits)) for (const e of input.edits as unknown[]) if (e && typeof e === 'object' && typeof (e as { new_string?: unknown }).new_string === 'string') parts.push((e as { new_string: string }).new_string)
  return parts.join('\n')
}

function pathArgOf(toolName: string, input: Record<string, unknown>): string | null {
  const raw = (input.file_path ?? input.path ?? input.notebook_path) as unknown
  if (typeof raw === 'string' && raw.trim()) return raw
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    const first = (input.edits as any[]).find(e => typeof e?.file_path === 'string')
    return first ? first.file_path : null
  }
  return null
}

export function gradeProjectCall(root: string, cwd: string, classify: Classifier, describe: (t: string, i: Record<string, unknown>, r: 'safe' | 'risky' | 'dangerous') => string, toolName: string, input: Record<string, unknown>): Grade {
  if (FILE_TOOLS.has(toolName)) {
    // Glob scans `pattern` from its dir, and the pattern itself can climb out
    // (`../other-project/**/*.md`) or be absolute — a listing of another
    // project's file names is a read of that project (spec §5). Grep's `glob`
    // is only a filter under its dir and cannot escape.
    if (toolName === 'Glob' && typeof input.pattern === 'string') {
      const pattern = input.pattern
      if (isAbsolute(pattern) || /^([\\/]|[A-Za-z]:)/.test(pattern) || pattern.split(/[\\/]+/).includes('..')) {
        return { level: 'dangerous', reason: `the Glob pattern reaches outside the project folder: ${pattern}` }
      }
    }
    const p = pathArgOf(toolName, input)
    if (p !== null) {
      // Judged on the real path, not the lexical one: a symlink or junction
      // inside the project that points outside it is outside (spec §5).
      const { inside, real } = realInside(root, resolve(cwd, p))
      if (!inside) return { level: 'dangerous', reason: `outside the project folder: ${real}` }
    }
    // A file that would drive ComfyUI is refused before it is written: the
    // live run's render script was a safe Write, then a safe
    // `python tower/render.py` — nothing for the Bash fence to see. A file
    // that merely names the server (a note) is written.
    const text = writtenText(input)
    if (text) {
      const fence = comfyFence(text)
      if (fence?.level === 'dangerous') return fence
    }
    return { level: 'safe', reason: '' }
  }
  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    // Before the download rule: a curl at the ComfyUI server is not a download to approve but a fence to refuse.
    const fence = comfyFence(command)
    if (fence?.level === 'dangerous') return fence
    if (isDownloadCommand(command) || /\bgit\s+clone\b/i.test(command)) return { level: 'risky', reason: 'downloads need your approval' }
    const level = classify(toolName, input)
    // A command that merely names the server asks — unless the classifier already has a word on it.
    if (level === 'safe' && fence) return fence
    return { level, reason: level === 'safe' ? '' : describe(toolName, input, level) }
  }
  return { level: 'safe', reason: '' }
}

export async function openBinding(args: { home: string; slug: string; chat?: string | null; embed: EmbedClient | null; embedModel: string; contextLength: number; emit?: (e: IngestEvent) => void }): Promise<{ ok: true; binding: ProjectBinding; messages: TranscriptMessage[] } | { ok: false; reason: string }> {
  const meta = readProject(args.home, args.slug)
  if (!meta) return { ok: false, reason: `no such project: ${args.slug}` }
  const dir = projectDir(args.home, args.slug)
  await ensureHistory(dir)
  let chatFile: string | null = null, chatTitle: string | null = null, messages: TranscriptMessage[] = []
  if (args.chat) {
    const t = readTranscript(dir, args.chat)
    if (!t) return { ok: false, reason: `no such chat: ${args.chat}` }
    // A chat aborted mid-tool must not resume on an unanswered tool call.
    chatFile = args.chat; chatTitle = t.header.title; messages = trimDanglingToolCall(t.messages)
  }
  const reg = readRegistry(args.home).registry
  if (!reg.projects.some(p => p.slug === meta.slug)) upsertRegistry(args.home, { slug: meta.slug, name: meta.name, description: meta.description, tags: meta.tags, createdAt: meta.createdAt, lastOpenedAt: null, path: dir })
  touchOpened(args.home, meta.slug)
  appendJournal(dir, 'chat.opened', chatFile ?? '(new chat)')
  return {
    ok: true, messages,
    binding: { home: args.home, slug: meta.slug, dir, name: meta.name, description: meta.description, instructions: readInstructions(args.home, meta.slug), chatFile, chatTitle, embed: args.embed, embedModel: args.embedModel, contextLength: args.contextLength, emit: args.emit, citations: [] },
  }
}
