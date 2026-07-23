import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { formatJournalInput, joinViableExamples, exportViableExamples } from '../../s5/exportTrainingData.js'
import type { JournalEntry } from '../../training/types.js'

function entry(sessionId: string): JournalEntry {
  return {
    timestamp: 1, sessionId, system: 'S5',
    input: { userMessage: 'fix the bug', activeWorkflow: null, contextUsagePercent: 0.5,
             turnCount: 4, recentToolResults: [{ tool: 'Read', success: true }],
             governanceStatus: 'healthy', varietyBalance: 'balanced', promptDifficulty: 'medium' },
    decision: { workflow: null, contextAction: 'none', priority: 'balanced', reasoning: 'ok' },
  }
}

describe('exportTrainingData', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'export-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('formatJournalInput renders a stable, non-empty prompt string', () => {
    const s = formatJournalInput(entry('s1').input)
    expect(s).toContain('User: fix the bug')
    expect(s).toContain('Context: 50%')
    expect(s.length).toBeGreaterThan(0)
  })

  it('joinViableExamples keeps only viable-session decisions and preserves the real decision as output', () => {
    const entries = [entry('viable-1'), entry('nonviable-1'), entry('missing-1')]
    const outcomes = new Map([['viable-1', 'viable'], ['nonviable-1', 'non-viable']])
    const examples = joinViableExamples(entries, outcomes)
    expect(examples).toHaveLength(1)
    expect(JSON.parse(examples[0].output).reasoning).toBe('ok')
  })

  it('exportViableExamples writes JSONL for viable sessions', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [entry('v'), entry('nv')].map(e => JSON.stringify(e)).join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
    expect(existsSync(out)).toBe(true)
    const line = JSON.parse(readFileSync(out, 'utf-8').trim())
    expect(line).toHaveProperty('input')
    expect(line).toHaveProperty('output')
  })

  it('exportViableExamples writes nothing and reports 0 when no viable sessions match', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, JSON.stringify(entry('nv')) + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['nv', 'non-viable']]) })
    expect(res.written).toBe(0)
    expect(existsSync(out)).toBe(false)
  })

  it('exportViableExamples skips _backfill records and malformed lines', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(entry('v')),
      JSON.stringify({ _backfill: true, system: 'S5', entryTimestamp: 1, outcome: {} }),
      '{ this is not json',
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })
})
