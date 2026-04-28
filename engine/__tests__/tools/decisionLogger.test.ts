import { describe, expect, it } from 'bun:test'
import { DecisionLogger } from '../../decisions/logger.js'
import { rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'localcode-test-decisions-' + Date.now())

describe('DecisionLogger', () => {
  it('writes and reads JSONL records', () => {
    const logger = new DecisionLogger(TMP)
    logger.log({
      timestamp: Date.now(),
      userMessageSummary: 'test message',
      activeWorkflow: null,
      contextUsagePercent: 0.15,
      toolsCalled: ['Read', 'Edit'],
      toolResults: ['success', 'success'],
      modelUsed: 'gemma4:31b',
      stopReason: 'end_turn',
      tokenCount: 150,
      latencyMs: 2000,
    })

    expect(existsSync(TMP)).toBe(true)
    const entries = logger.readAll()
    expect(entries.length).toBe(1)
    expect(entries[0].toolsCalled).toEqual(['Read', 'Edit'])
    expect(entries[0].modelUsed).toBe('gemma4:31b')

    rmSync(TMP, { recursive: true, force: true })
  })
})
