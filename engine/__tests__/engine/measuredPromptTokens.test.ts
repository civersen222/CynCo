import { describe, expect, it } from 'bun:test'
import { fromOpenAIStreamChunk } from '../../ollama/format.js'
import { promptTokensWithFloor } from '../../bridge/contextFloor.js'

/**
 * Finding (n), measured on the L3-3.3b run (trajectory task-e952d4d8).
 *
 * The run died here:
 *
 *   [context] WARNING: 75% — model should start implementing
 *   ...
 *   send_error: task id = 8902, error: request (67733 tokens) exceeds the
 *   available context size (65536 tokens)
 *
 * 67733/65536 is 103%. The engine read 75% and let the request go. The 80%
 * compaction trigger never fired because it was reading a number nobody
 * measured: `JSON.stringify(x).length / 4`, a chars-per-token guess that
 * under-read the truth by twenty-eight points.
 *
 * The measurement existed. llama-server reports `usage.prompt_tokens` on the
 * final chunk of every stream — it is the count the server actually evaluated,
 * not an estimate of it. `fromOpenAIStreamChunk` declares that field in its
 * parameter type and never reads it, and both providers hardcode
 * `usage: { input_tokens: 0, output_tokens: 0 }` on message_start. So the one
 * authoritative number in the whole context-management path was arriving on the
 * wire, being named in a type signature, and getting dropped on the floor.
 *
 * Two things drop it, and both must be fixed or the fix is theatre:
 *
 *   1. The `usage` field is simply never read.
 *   2. `if (!chunk.choices || chunk.choices.length === 0) return events` bails
 *      out one line earlier — and a usage-bearing chunk has an EMPTY choices
 *      array. That guard was written to swallow error payloads and it happens
 *      to swallow the measurement too.
 *
 * The rule, again: measured, or absent. A guess dressed as a measurement is the
 * worse of the two, because the critical path trusts it.
 */

describe('the server measures the prompt; the translator must not discard it', () => {
  it('emits the measured prompt tokens from a usage-bearing chunk', () => {
    // The shape llama-server actually sends last: no choices, only usage.
    const events = fromOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'qwen',
      choices: [],
      usage: { prompt_tokens: 65330, completion_tokens: 412, total_tokens: 65742 },
    } as any)

    const usageEvent = events.find(e => e.type === 'message_delta')
    expect(usageEvent).toBeDefined()
    expect((usageEvent as any).usage.input_tokens).toBe(65330)
    expect((usageEvent as any).usage.output_tokens).toBe(412)
  })

  it('emits usage alongside content when a chunk carries both', () => {
    // Some backends attach usage to the final content chunk rather than to a
    // separate one. The content must survive and the usage must come with it.
    const events = fromOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'qwen',
      choices: [{ index: 0, delta: { content: 'done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40000, completion_tokens: 7, total_tokens: 40007 },
    } as any)

    const text = events.find(e => e.type === 'content_block_delta')
    expect((text as any).delta.text).toBe('done.')
    const usageEvent = events.find(e => e.type === 'message_delta')
    expect((usageEvent as any).usage.input_tokens).toBe(40000)
  })

  it('emits no usage event for an ordinary chunk that carries none', () => {
    // Absent is absent. A chunk without usage must not produce a zero, because
    // a zero would be indistinguishable from "the server measured nothing" and
    // would reset the floor the context check leans on.
    const events = fromOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'qwen',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    } as any)

    expect(events.find(e => e.type === 'message_delta')).toBeUndefined()
    expect(events).toHaveLength(1)
  })

  it('still returns nothing for a chunk with neither choices nor usage', () => {
    // The old early return existed to swallow error payloads, which have no
    // choices. That behaviour has to survive: only the usage case is new.
    const events = fromOpenAIStreamChunk({ id: 'x', model: 'qwen', choices: [] } as any)
    expect(events).toEqual([])
  })

  it('preserves tool call deltas on a chunk that also reports usage', () => {
    const events = fromOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'qwen',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Edit', arguments: '{"a":' } }] },
        finish_reason: null,
      }],
      usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
    } as any)

    expect(events.find(e => e.type === 'content_block_start')).toBeDefined()
    expect(events.find(e => e.type === 'content_block_delta')).toBeDefined()
    expect((events.find(e => e.type === 'message_delta') as any).usage.input_tokens).toBe(100)
  })
})

describe('the measurement is a floor, and only while the conversation grows', () => {
  it('would have fired compaction on the request that killed the L3-3.3b run', () => {
    // The real numbers. The guess is the engine's chars/4 reading at the turn
    // before the fatal request; the measurement is what llama-server reported
    // for the prompt it had just evaluated.
    const contextLength = 65536
    const guessed = 49000          // ~75%, what the engine acted on
    const measured = 65330         // what the server counted

    const withoutFloor = guessed / contextLength
    const withFloor = promptTokensWithFloor(guessed, { tokens: measured, atMessageCount: 80 }, 82) / contextLength

    expect(withoutFloor).toBeLessThan(0.8)   // the trigger that did not fire
    expect(withFloor).toBeGreaterThan(0.8)   // the trigger that would have
  })

  it('returns the guess when nothing has been measured yet', () => {
    // Turn 1 of a session. Absent is absent — no measurement means no floor,
    // not a floor of zero and not a fabricated one.
    expect(promptTokensWithFloor(4000, { tokens: null, atMessageCount: 0 }, 3)).toBe(4000)
  })

  it('keeps using the measurement as the conversation grows past it', () => {
    // The floor is loose here — the conversation has three more messages than
    // when it was measured — but a loose lower bound is still a lower bound,
    // and it is still tighter than a guess that under-reads by 28 points.
    expect(promptTokensWithFloor(50000, { tokens: 65330, atMessageCount: 80 }, 83)).toBe(65330)
  })

  it('prefers the guess once the guess exceeds the measurement', () => {
    expect(promptTokensWithFloor(70000, { tokens: 65330, atMessageCount: 80 }, 90)).toBe(70000)
  })

  it('discards the floor after the conversation shrinks', () => {
    // Compaction, a read-loop prune, a best-of-N rollback. The measurement
    // described messages that no longer exist, so "it was at least this big"
    // is no longer an argument about the current prompt. Keeping it would pin
    // the engine above the compaction threshold and make it compact forever.
    expect(promptTokensWithFloor(9000, { tokens: 65330, atMessageCount: 80 }, 12)).toBe(9000)
  })

  it('still trusts the floor at exactly the message count it was measured at', () => {
    // The boundary. Same conversation, no growth and no shrink: the
    // measurement describes precisely these messages, which is the strongest
    // case for it, not the weakest.
    expect(promptTokensWithFloor(9000, { tokens: 65330, atMessageCount: 80 }, 80)).toBe(65330)
  })
})
