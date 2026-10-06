/**
 * engine/projects/chat.ts — one JSONL transcript per chat.
 *
 * Line 1 is the header; every later line is one message in the engine's
 * own shape, appended as it is produced so a crash loses at most the turn
 * in flight. A rename rewrites line 1 only; the file name never changes.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { slugify } from './layout.js'

export type ChatHeader = { kind: 'chat'; title: string; createdAt: string; projectSlug: string }
export type TranscriptMessage = { role: 'user' | 'assistant' | 'system'; content: { type: string; text?: string; [k: string]: unknown }[]; aborted?: boolean }

export function titleFrom(firstUserText: string): string {
  const t = firstUserText.replace(/\s+/g, ' ').trim()
  return t.length <= 60 ? t : t.slice(0, 60).trimEnd()
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')
}

export function newChatFile(dir: string, firstUserText: string, now: Date = new Date()): { file: string; header: ChatHeader } {
  const title = titleFrom(firstUserText) || 'chat'
  const projectSlug = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).slug as string
  let file = `${stamp(now)}-${slugify(title)}.jsonl`
  let n = 2
  while (existsSync(join(dir, 'chats', file))) file = `${stamp(now)}-${slugify(title)}-${n++}.jsonl`
  const header: ChatHeader = { kind: 'chat', title, createdAt: now.toISOString(), projectSlug }
  writeFileSync(join(dir, 'chats', file), JSON.stringify(header) + '\n', 'utf8')
  return { file, header }
}

export function appendTranscript(dir: string, file: string, msg: TranscriptMessage): void {
  appendFileSync(join(dir, 'chats', file), JSON.stringify(msg) + '\n', 'utf8')
}

export function readTranscript(dir: string, file: string): { header: ChatHeader; messages: TranscriptMessage[] } | null {
  const p = join(dir, 'chats', file)
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').split('\n').filter(l => l.trim())
  if (!lines.length) return null
  try {
    const header = JSON.parse(lines[0]) as ChatHeader
    if (header.kind !== 'chat') return null
    const messages: TranscriptMessage[] = []
    for (const l of lines.slice(1)) {
      try { messages.push(JSON.parse(l)) } catch (e) { console.log(`[projects] skipping a corrupt transcript line in ${file}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    return { header, messages }
  } catch (e) {
    console.log(`[projects] unreadable chat header in ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

export function listChats(dir: string): { file: string; title: string; createdAt: string; messages: number }[] {
  const root = join(dir, 'chats')
  if (!existsSync(root)) return []
  const out: { file: string; title: string; createdAt: string; messages: number }[] = []
  for (const file of readdirSync(root).filter(f => f.endsWith('.jsonl'))) {
    const t = readTranscript(dir, file)
    if (t) out.push({ file, title: t.header.title, createdAt: t.header.createdAt, messages: t.messages.length })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file))
}

export function renameChat(dir: string, file: string, title: string): boolean {
  const p = join(dir, 'chats', file)
  if (!existsSync(p)) return false
  const lines = readFileSync(p, 'utf8').split('\n')
  let header: ChatHeader
  try { header = JSON.parse(lines[0]) } catch (e) { console.log(`[projects] rename: bad header in ${file}: ${e instanceof Error ? e.message : String(e)}`); return false }
  header.title = titleFrom(title) || header.title
  lines[0] = JSON.stringify(header)
  writeFileSync(p, lines.join('\n'), 'utf8')
  return true
}

/**
 * A chat aborted mid-tool ends on an assistant message whose tool_use blocks
 * no tool_result ever answered; providers reject that shape on the next call.
 * Drops such trailing assistant messages (returns a new array) so a reopened
 * chat resumes cleanly. A trailing assistant message with no tool_use (prose,
 * or aborted partial text) is kept.
 */
export function trimDanglingToolCall(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out = [...messages]
  while (out.length) {
    const last = out[out.length - 1]
    if (last.role === 'assistant' && last.content.some(b => b.type === 'tool_use')) out.pop()
    else break
  }
  return out
}

const textOf = (m: TranscriptMessage) => m.content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n\n')

export function turnsOf(messages: TranscriptMessage[]): { user: string; assistant: string }[] {
  const turns: { user: string; assistant: string }[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.some(b => b.type === 'tool_result')) continue
      turns.push({ user: textOf(m), assistant: '' })
    } else if (m.role === 'assistant' && turns.length) {
      const t = textOf(m)
      if (t) turns[turns.length - 1].assistant = turns[turns.length - 1].assistant ? `${turns[turns.length - 1].assistant}\n\n${t}` : t
    }
  }
  return turns
}
