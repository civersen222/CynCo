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
 * imports from engine/bridge.
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
    if (p === null) return { level: 'safe', reason: '' }
    // Judged on the real path, not the lexical one: a symlink or junction
    // inside the project that points outside it is outside (spec §5).
    const { inside, real } = realInside(root, resolve(cwd, p))
    return inside ? { level: 'safe', reason: '' } : { level: 'dangerous', reason: `outside the project folder: ${real}` }
  }
  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    if (isDownloadCommand(command) || /\bgit\s+clone\b/i.test(command)) return { level: 'risky', reason: 'downloads need your approval' }
    const level = classify(toolName, input)
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
