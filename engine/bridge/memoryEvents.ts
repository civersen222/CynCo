/**
 * Pure helpers for formatting memory data into protocol event shapes.
 * Used by conversationLoop.ts to emit memory.recalled and memory.written events.
 *
 * See design spec: docs/superpowers/specs/2026-04-16-ux-completion-design.md §4
 */

import type { PriorSessionContext } from './protocol.js'

type HandoffLike = {
  goal: string
  now: string
  status: string
}

type OpenThread = {
  priority: string
  description: string
}

type RecalledMemoryLike = {
  type: string
  content: string
  confidence?: string
  context?: string
  rrf_score?: number
}

/**
 * Format a handoff + ledger open threads into the PriorSessionContext shape
 * for the memory.recalled protocol event.
 *
 * @param handoff - The most recent handoff, or null if none exists.
 * @param openThreads - High-priority open threads from the ledger.
 * @param handoffDate - When the handoff was created (for relative time display).
 * @param now - Current time (injectable for testing).
 */
export function formatSessionContext(
  handoff: HandoffLike | null,
  openThreads: OpenThread[],
  handoffDate: Date,
  now: Date = new Date(),
): PriorSessionContext | null {
  if (!handoff) return null
  return {
    priorGoal: handoff.goal,
    priorStatus: handoff.status,
    priorDate: formatRelativeTime(handoffDate, now),
    openThreads: openThreads.map(t => ({ priority: t.priority, description: t.description })),
  }
}

/**
 * Map recalled memories (from the vector DB) to the protocol event shape.
 * Strips internal fields like rrf_score and context that the TUI doesn't need.
 */
export function formatRecalledForProtocol(
  memories: RecalledMemoryLike[],
): { type: string; content: string; confidence?: string }[] {
  return memories.map(m => {
    const entry: { type: string; content: string; confidence?: string } = {
      type: m.type,
      content: m.content,
    }
    if (m.confidence) entry.confidence = m.confidence
    return entry
  })
}

/**
 * Build a one-line human-readable summary for a memory.written event.
 */
export function formatMemoryWrittenSummary(
  kind: 'handoff' | 'ledger_update',
  goal: string,
  status: string,
): string {
  if (kind === 'handoff') {
    return `Saved handoff: ${goal} (${status})`
  }
  return `Updated ledger: ${goal} (${status})`
}

/**
 * Format a duration between two dates as a compact relative string.
 * Examples: "just now", "5m ago", "3h ago", "2d ago", "2w ago", "1mo ago"
 */
function formatRelativeTime(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  const diffWeeks = Math.floor(diffDays / 7)
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths}mo ago`
}
