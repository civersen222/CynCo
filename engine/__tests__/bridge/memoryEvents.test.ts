import { describe, expect, it } from 'bun:test'
import {
  formatSessionContext,
  formatRecalledForProtocol,
  formatMemoryWrittenSummary,
} from '../../bridge/memoryEvents.js'

describe('formatSessionContext', () => {
  it('formats a handoff with open threads into PriorSessionContext shape', () => {
    const handoff = {
      goal: 'fix the edit loop bug',
      now: 'Wiring doom detector',
      status: 'in_progress' as const,
    }
    const openThreads = [
      { priority: 'high' as const, description: 'wire summary injection' },
      { priority: 'medium' as const, description: 'add settings UI' },
    ]
    const result = formatSessionContext(handoff, openThreads, new Date('2026-04-14T12:00:00Z'))
    expect(result!.priorGoal).toBe('fix the edit loop bug')
    expect(result!.priorStatus).toBe('in_progress')
    expect(result!.priorDate).toMatch(/\d+[dhwm]\s+ago|just now/)
    expect(result!.openThreads).toHaveLength(2)
    expect(result!.openThreads[0].priority).toBe('high')
  })

  it('returns null when no handoff provided', () => {
    const result = formatSessionContext(null, [], new Date())
    expect(result).toBeNull()
  })
})

describe('formatRecalledForProtocol', () => {
  it('maps RecalledMemory array to protocol shape', () => {
    const memories = [
      { type: 'WORKING_SOLUTION', content: 'Use ToolExecutor', confidence: 'high' },
      { type: 'ERROR_FIX', content: 'Check stop_reason before exit' },
    ]
    const result = formatRecalledForProtocol(memories)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'WORKING_SOLUTION', content: 'Use ToolExecutor', confidence: 'high' })
    expect(result[1].confidence).toBeUndefined()
  })

  it('returns empty array for empty input', () => {
    expect(formatRecalledForProtocol([])).toEqual([])
  })
})

describe('formatMemoryWrittenSummary', () => {
  it('formats handoff write summary', () => {
    const summary = formatMemoryWrittenSummary('handoff', 'fix edit loop', 'in_progress')
    expect(summary).toContain('handoff')
    expect(summary).toContain('fix edit loop')
    expect(summary).toContain('in_progress')
  })

  it('formats ledger update summary', () => {
    const summary = formatMemoryWrittenSummary('ledger_update', 'session complete', 'complete')
    expect(summary).toContain('ledger')
  })
})

describe('relative time formatting', () => {
  it('formats minutes ago', () => {
    const now = new Date('2026-04-16T12:30:00Z')
    const then = new Date('2026-04-16T12:15:00Z')
    const ctx = formatSessionContext({ goal: 'test', now: '', status: 'complete' as const }, [], then, now)
    expect(ctx!.priorDate).toBe('15m ago')
  })

  it('formats hours ago', () => {
    const now = new Date('2026-04-16T15:00:00Z')
    const then = new Date('2026-04-16T12:00:00Z')
    const ctx = formatSessionContext({ goal: 'test', now: '', status: 'complete' as const }, [], then, now)
    expect(ctx!.priorDate).toBe('3h ago')
  })

  it('formats days ago', () => {
    const now = new Date('2026-04-16T12:00:00Z')
    const then = new Date('2026-04-14T12:00:00Z')
    const ctx = formatSessionContext({ goal: 'test', now: '', status: 'complete' as const }, [], then, now)
    expect(ctx!.priorDate).toBe('2d ago')
  })

  it('formats weeks ago', () => {
    const now = new Date('2026-04-16T12:00:00Z')
    const then = new Date('2026-03-30T12:00:00Z')
    const ctx = formatSessionContext({ goal: 'test', now: '', status: 'complete' as const }, [], then, now)
    expect(ctx!.priorDate).toBe('2w ago')
  })
})
