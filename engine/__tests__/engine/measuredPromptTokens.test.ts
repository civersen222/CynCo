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
    const withFloor = promptTokensWithFloor(guessed, { tokens: measured, atMessageCount: 80 }, 82, 0) / contextLength

    expect(withoutFloor).toBeLessThan(0.8)   // the trigger that did not fire
    expect(withFloor).toBeGreaterThan(0.8)   // the trigger that would have
  })

  it('returns the guess when nothing has been measured yet', () => {
    // Turn 1 of a session. Absent is absent — no measurement means no floor,
    // not a floor of zero and not a fabricated one.
    expect(promptTokensWithFloor(4000, { tokens: null, atMessageCount: 0 }, 3, 0)).toBe(4000)
  })

  it('keeps using the measurement as the conversation grows past it', () => {
    // The floor is loose here — the conversation has three more messages than
    // when it was measured — but a loose lower bound is still a lower bound,
    // and it is still tighter than a guess that under-reads by 28 points.
    expect(promptTokensWithFloor(50000, { tokens: 65330, atMessageCount: 80 }, 83, 0)).toBe(65330)
  })

  it('prefers the guess once the guess exceeds the measurement', () => {
    expect(promptTokensWithFloor(70000, { tokens: 65330, atMessageCount: 80 }, 90, 0)).toBe(70000)
  })

  it('discards the floor after the conversation shrinks', () => {
    // Compaction, a read-loop prune, a best-of-N rollback. The measurement
    // described messages that no longer exist, so "it was at least this big"
    // is no longer an argument about the current prompt. Keeping it would pin
    // the engine above the compaction threshold and make it compact forever.
    expect(promptTokensWithFloor(9000, { tokens: 65330, atMessageCount: 80 }, 12, 40000)).toBe(9000)
  })

  it('still trusts the floor at exactly the message count it was measured at', () => {
    // The boundary. Same conversation, no growth and no shrink: the
    // measurement describes precisely these messages, which is the strongest
    // case for it, not the weakest.
    expect(promptTokensWithFloor(9000, { tokens: 65330, atMessageCount: 80 }, 80, 0)).toBe(65330)
  })
})

/**
 * Finding (r), measured on the Gilded L4.1 run.
 *
 * Same death as finding (n), one layer further in:
 *
 *   [context] WARNING: 72% — model should start implementing
 *   ...
 *   send_error: task id = 14022, error: request (66019 tokens) exceeds the
 *   available context size (65536 tokens)
 *
 * 72% then 101% with no reading in between. The floor from finding (n) was in
 * place and did not help, because of what the floor actually says: "the prompt
 * was N tokens at message count M." Between M and now, the engine appended the
 * assistant's reply and a tool result — a pytest run, thousands of tokens — and
 * `max(guess, N)` accounted for exactly none of it. The guess that WOULD have
 * covered those messages under-reads the whole conversation so badly that the
 * max never selects it, so the newest and largest additions were the ones the
 * estimate was blindest to.
 *
 * The repair keeps the same argument and stops throwing away its second half:
 * the prompt was N tokens at M, and the messages added since M are worth at
 * least D. The measured part stays measured; the guessed part now covers only
 * what has never been measured, so its error scales with one tool result
 * instead of with the entire conversation.
 *
 * The tail is a required argument. A default of 0 would let a caller that
 * forgot it silently fall back to exactly the behaviour that killed this run,
 * with every test in this file still green.
 */
describe('the floor must account for what was appended after it was measured', () => {
  it('would have fired compaction on the request that killed the Gilded L4.1 run', () => {
    // The real numbers. 47186 is the 72% the engine printed and acted on;
    // 66019 is what the server counted one request later. The gap is the
    // assistant turn plus a pytest tool result that nothing in the estimate saw.
    const contextLength = 65536
    const measured = 47186
    const guessedWholeConversation = 46000   // chars/4, under-reads as always
    const guessedTail = 13400                // chars/4 over just the new messages

    const oldWay = promptTokensWithFloor(
      guessedWholeConversation, { tokens: measured, atMessageCount: 80 }, 82, 0)
    const newWay = promptTokensWithFloor(
      guessedWholeConversation, { tokens: measured, atMessageCount: 80 }, 82, guessedTail)

    expect(oldWay / contextLength).toBeLessThan(0.8)     // the trigger that did not fire
    expect(newWay / contextLength).toBeGreaterThan(0.8)  // the trigger that would have
  })

  it('adds the tail to the measurement rather than replacing it', () => {
    // Not max(measured, tail) and not a scaled measured: the two describe
    // disjoint halves of the same prompt, so they sum.
    expect(promptTokensWithFloor(1000, { tokens: 40000, atMessageCount: 10 }, 14, 9000)).toBe(49000)
  })

  it('leaves the floor alone when nothing has been appended since the measurement', () => {
    // The measurement describes the whole current prompt. Adding a tail of zero
    // must not inflate it.
    expect(promptTokensWithFloor(1000, { tokens: 40000, atMessageCount: 10 }, 10, 0)).toBe(40000)
  })

  it('still prefers the guess when the guess beats measurement plus tail', () => {
    // The floor is a lower bound, never a ceiling.
    expect(promptTokensWithFloor(80000, { tokens: 40000, atMessageCount: 10 }, 14, 9000)).toBe(80000)
  })

  it('discards the tail along with the floor after the conversation shrinks', () => {
    // After compaction the measurement describes messages that no longer exist,
    // and so does any tail computed against its message index. Both go.
    expect(promptTokensWithFloor(9000, { tokens: 65330, atMessageCount: 80 }, 12, 30000)).toBe(9000)
  })
})
