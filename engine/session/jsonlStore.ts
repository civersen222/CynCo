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
  type: 'message' | 'compaction' | 'governance' | 'session_end'
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

  /** Most recent serialized file-op string journaled with a compaction, or null. */
  loadFileOps(): string | null {
    if (!existsSync(this.filePath)) return null
    const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(l => l.trim())
    let latest: string | null = null
    for (const line of lines) {
      try {
        const entry: JournalEntry = JSON.parse(line)
        if (entry.type === 'compaction') {
          const d = entry.data as { summary: string; fileOps?: string }
          if (d.fileOps) latest = d.fileOps
        }
      } catch { /* skip */ }
    }
    return latest
  }

  /** Write an explicit clean-shutdown marker. */
  appendSessionEnd(): void {
    const entry: JournalEntry = { type: 'session_end', timestamp: Date.now(), data: {} }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n')
  }

  /** True if a session_end marker was written (clean shutdown). */
  hasEnded(): boolean {
    if (!existsSync(this.filePath)) return false
    const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(l => l.trim())
    for (const line of lines) {
      try { if ((JSON.parse(line) as JournalEntry).type === 'session_end') return true } catch { /* skip */ }
    }
    return false
  }

  get path(): string { return this.filePath }

  /** Delete session files whose mtime is older than `maxAgeDays`. Returns count removed. */
  static gcOldSessions(maxAgeDays = 30): number {
    const sessionDir = join(homedir(), '.cynco', 'sessions')
    if (!existsSync(sessionDir)) return 0
    const cutoff = Date.now() - maxAgeDays * 86400_000
    let removed = 0
    try {
      const { statSync, unlinkSync } = require('fs')
      for (const f of readdirSync(sessionDir)) {
        if (!f.endsWith('.jsonl')) continue
        const full = join(sessionDir, f)
        try {
          if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++ }
        } catch { /* skip */ }
      }
    } catch { /* dir vanished */ }
    return removed
  }

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
