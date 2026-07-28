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

  it('folds a decisionId-keyed backfill onto its entry and drops the measured negative', () => {
    const good = entry('v'); (good.decision as any).decisionId = 'd-good'
    const bad = entry('v'); (bad.decision as any).decisionId = 'd-bad'
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(good),
      JSON.stringify(bad),
      JSON.stringify({ _backfill: true, system: 'S5', decisionId: 'd-bad', outcome: { outcome: 'negative', measured: true } }),
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    // Both decisions are in the same viable session, so the session label cannot
    // separate them. The per-decision label can — that is the entire point.
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })

  it('keeps an unknown-outcome decision — unmeasured is not a veto', () => {
    const e = entry('v'); (e.decision as any).decisionId = 'd1'
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(e),
      JSON.stringify({ _backfill: true, system: 'S5', decisionId: 'd1', outcome: { outcome: 'unknown', measured: false } }),
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })

  it('strips decisionId, ruleIds and rejected from the training target', () => {
    const e = entry('v')
    Object.assign(e.decision, { decisionId: 'd1', ruleIds: ['W2'], rejected: [{ ruleId: 'W9' }] })
    const examples = joinViableExamples([e], new Map([['v', 'viable']]))
    const target = JSON.parse(examples[0].output)
    // The output string is the model's training target. A UUID in it teaches the
    // model to invent UUIDs; ruleIds and rejected teach it to imitate the rule
    // engine's internals, which is what this corpus exists to move past.
    expect(target.decisionId).toBeUndefined()
    expect(target.ruleIds).toBeUndefined()
    expect(target.rejected).toBeUndefined()
    expect(target.reasoning).toBe('ok')
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
