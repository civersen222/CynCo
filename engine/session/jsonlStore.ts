/**
 * S5 Identity Continuity: Append-only JSONL session persistence.
 * Each message is a JSON line. Crash-safe — resume from last line.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

type Message = {
  role: 'user' | 'assistant' | 'system'
  content: { type: string; text?: string; [key: string]: unknown }[]
}

type JournalEntry = {
  type: 'message' | 'compaction' | 'governance'
  timestamp: number
  data: Message | { summary: string; fileOps?: string } | Record<string, unknown>
}

export class JSONLStore {
  private filePath: string

  constructor(sessionId: string) {
    const sessionDir = join(homedir(), '.cynco', 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    this.filePath = join(sessionDir, `${sessionId}.jsonl`)
  }

  appendMessage(message: Message): void {
    const entry: JournalEntry = { type: 'message', timestamp: Date.now(), data: message }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n')
  }

  appendCompaction(summary: string, fileOps?: string): void {
    const entry: JournalEntry = { type: 'compaction', timestamp: Date.now(), data: { summary, fileOps } }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n')
  }

  appendGovernance(data: Record<string, unknown>): void {
    const entry: JournalEntry = { type: 'governance', timestamp: Date.now(), data }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n')
  }

  loadMessages(): Message[] {
    if (!existsSync(this.filePath)) return []
    const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(l => l.trim())
    const messages: Message[] = []

    for (const line of lines) {
      try {
        const entry: JournalEntry = JSON.parse(line)
        if (entry.type === 'message') {
          messages.push(entry.data as Message)
        } else if (entry.type === 'compaction') {
          // Compaction replaces all prior messages with summary
          messages.length = 0
          const compData = entry.data as { summary: string; fileOps?: string }
          messages.push({
            role: 'system',
            content: [{ type: 'text', text: `[Context Summary]\n${compData.summary}` }],
          })
        }
      } catch { /* skip malformed lines */ }
    }
    return messages
  }

  get path(): string { return this.filePath }

  static listSessions(): { id: string; modified: number }[] {
    const sessionDir = join(homedir(), '.cynco', 'sessions')
    if (!existsSync(sessionDir)) return []
    try {
      const { statSync } = require('fs')
      return readdirSync(sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          id: f.replace('.jsonl', ''),
          modified: statSync(join(sessionDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.modified - a.modified)
    } catch { return [] }
  }
}
