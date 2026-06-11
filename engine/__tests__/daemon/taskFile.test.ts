// engine/__tests__/daemon/taskFile.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeTaskFile, readTaskFile, writeOutcome, readOutcome,
} from '../../daemon/taskFile.js'
import type { TaskFileInput, TaskOutcome } from '../../daemon/types.js'

const input: TaskFileInput = {
  missionId: 'mfl-dynasty',
  triggerId: 'daily-news',
  prompt: 'Review injury news',
  context: 'goal: win the league',
  allowedTools: ['Mfl', 'WebSearch'],
  timeoutMs: 900000,
  outcomePath: 'replaced-below',
}

describe('taskFile contract', () => {
  it('round-trips a task file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'task.json')
      writeTaskFile(p, { ...input, outcomePath: join(dir, 'out.json') })
      const back = readTaskFile(p)
      expect(back.missionId).toBe('mfl-dynasty')
      expect(back.allowedTools).toEqual(['Mfl', 'WebSearch'])
      expect(back.timeoutMs).toBe(900000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a task file missing required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'bad.json')
      writeFileSync(p, JSON.stringify({ missionId: 'x' }), 'utf-8')
      expect(() => readTaskFile(p)).toThrow(/missing|invalid/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('round-trips an outcome file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'out.json')
      const outcome: TaskOutcome = {
        ok: true,
        summary: '2 waiver targets found',
        recommendations: [{ id: 'rec-1', actionType: 'waiver', summary: 'Claim X', detail: 'because Y' }],
      }
      writeOutcome(p, outcome)
      const back = readOutcome(p)
      expect(back.ok).toBe(true)
      expect(back.recommendations[0].actionType).toBe('waiver')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('readOutcome returns a failure outcome when the file is absent', () => {
    const back = readOutcome(join(tmpdir(), 'cynco-definitely-missing', 'out.json'))
    expect(back.ok).toBe(false)
    expect(back.error).toMatch(/missing/i)
  })

  it('readOutcome returns a failure outcome for corrupt/truncated JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-tf-'))
    try {
      const p = join(dir, 'corrupt.json')
      writeFileSync(p, '{"ok": tr', 'utf-8')
      const back = readOutcome(p)
      expect(back.ok).toBe(false)
      expect(back.error).toMatch(/unreadable|missing/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
