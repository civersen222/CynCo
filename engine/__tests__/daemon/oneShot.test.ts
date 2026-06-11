// engine/__tests__/daemon/oneShot.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractOutcome, buildOneShotSystemPrompt } from '../../daemon/oneShot.js'

describe('extractOutcome', () => {
  it('parses the last fenced json block', () => {
    const text = [
      'thinking...',
      '```json', '{"summary": "draft", "recommendations": []}', '```',
      'more...',
      '```json',
      JSON.stringify({ summary: 'final', recommendations: [{ actionType: 'waiver', summary: 'Claim X', detail: 'why' }] }),
      '```',
    ].join('\n')
    const outcome = extractOutcome(text)
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toBe('final')
    expect(outcome.recommendations.length).toBe(1)
  })

  it('assigns ids to recommendations missing one', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations[0].id).toMatch(/^rec-/)
  })

  it('falls back to text tail when no json block parses', () => {
    const outcome = extractOutcome('I looked at the roster. Nothing to do this week.')
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toContain('Nothing to do')
    expect(outcome.recommendations).toEqual([])
  })

  it('drops malformed recommendation entries', () => {
    const text = '```json\n{"summary": "s", "recommendations": [{"bogus": true}, {"actionType": "waiver", "summary": "a", "detail": "d"}]}\n```'
    const outcome = extractOutcome(text)
    expect(outcome.recommendations.length).toBe(1)
    expect(outcome.recommendations[0].actionType).toBe('waiver')
  })
})

describe('buildOneShotSystemPrompt', () => {
  it('includes the outcome format contract and mission context', () => {
    const p = buildOneShotSystemPrompt('goal: win the league')
    expect(p).toContain('goal: win the league')
    expect(p).toContain('```json')
    expect(p).toContain('recommendations')
  })
})
