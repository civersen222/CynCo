/**
 * S5's recommendation on the dashboard (owner's decision sheet of 2026-11-17, row 21, F233 d).
 *
 * The loop has emitted `governance.recommendation` for every warning-tier rule that fired, and
 * only the TUI drew it: a session watched from the dashboard or the phone never saw that S5
 * would revert, compact or restrict. The decision was to show it and stop there. Nothing acts
 * on a recommendation, so the page says "not applied" and offers no button: executing a revert
 * is authority to change files, which was not asked for.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { REPLAYED_TYPES, NOT_REPLAYED_TYPES } from '../../dashboard/replay.js'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function extractFunction(name: string): string {
  const startAt = html.indexOf('function ' + name + '(')
  if (startAt < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = html.indexOf('{', startAt); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(startAt, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

type Entry = { decision: string; reason: string; chatLine: string | null }
const recommendationEntry = new Function(`${extractFunction('recommendationEntry')}; return recommendationEntry;`)() as (event: any) => Entry

/** The frame as conversationLoop.ts emits it for a decision. */
const frame = (signal: string, description: string, action: Record<string, unknown>) => ({
  type: 'governance.recommendation', requestId: 'r1', severity: 'warning', signal,
  title: description.split('.')[0], description,
  action: { model: null, tools: null, contextAction: 'none', revert: false, priority: 'balanced', ...action },
})

describe('what a recommendation says on the page', () => {
  it('a revert is named, said to be advice, and goes to the chat as well', () => {
    const e = recommendationEntry(frame('W3', 'stuck for 6 turns (20% tool success) — recommending revert', { revert: true }))
    expect(e.decision).toBe('recommends (W3): revert the last change · not applied')
    expect(e.reason).toBe('stuck for 6 turns (20% tool success) — recommending revert')
    expect(e.chatLine).toBe('S5 recommends a revert (W3): stuck for 6 turns (20% tool success) — recommending revert. Nothing was reverted: this is advice, and acting on it is yours.')
  })

  it('a context action, a tool restriction and a model switch are each named; none of them reaches the chat', () => {
    expect(recommendationEntry(frame('W1', 'context at 80%', { contextAction: 'warn' }))).toEqual({
      decision: 'recommends (W1): context: warn · not applied', reason: 'context at 80%', chatLine: null,
    })
    const both = recommendationEntry(frame('W4', 'drift, degrading', { contextAction: 'compact', tools: ['Read', 'Grep'], model: 'qwen3.8:27b' }))
    expect(both.decision).toBe('recommends (W4): switch model to qwen3.8:27b, restrict tools to Read, Grep, context: compact · not applied')
    expect(both.chatLine).toBeNull()
  })

  it('a recommendation that names no action says so, and a frame missing its fields does not throw', () => {
    expect(recommendationEntry(frame('W9', 'observers diverge', {})).decision).toBe('recommends (W9): no action named · not applied')
    expect(recommendationEntry({ type: 'governance.recommendation' })).toEqual({
      decision: 'recommends (?): no action named · not applied', reason: '', chatLine: null,
    })
  })

  it('a sentence that already ends in a full stop is not given a second one', () => {
    const e = recommendationEntry(frame('W3', 'Stuck. Recommending revert.', { revert: true }))
    expect(e.chatLine).toBe('S5 recommends a revert (W3): Stuck. Recommending revert. Nothing was reverted: this is advice, and acting on it is yours.')
  })
})

describe('the page draws it and offers nothing to press', () => {
  const start = html.indexOf("case 'governance.recommendation'")
  const body = start < 0 ? '' : html.slice(start, html.indexOf('break;', start))

  it('handleEvent has the case: the Governance tab list always, the chat only when there is a chat line', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain('recommendationEntry(event)')
    expect(body).toContain('state.s5Decisions.unshift(')
    expect(body).toContain('renderS5()')
    expect(body).toContain("if (rec.chatLine !== null) appendChatMsg('system', rec.chatLine)")
  })

  it('it is display only: no request, no timer and no button come from a recommendation', () => {
    for (const s of ['fetch(', 'setTimeout(', 'setInterval(', 'ws.send(', 'createElement(', 'autoApplyAfterMs']) {
      expect(body, s).not.toContain(s)
    }
  })

  it('a page that was away is sent it again: the revert line is part of the Chat pane', () => {
    expect(REPLAYED_TYPES.has('governance.recommendation')).toBe(true)
    expect('governance.recommendation' in NOT_REPLAYED_TYPES).toBe(false)
  })
})
