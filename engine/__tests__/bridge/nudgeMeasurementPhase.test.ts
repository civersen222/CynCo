import { describe, expect, it, afterAll } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Real ConversationLoop instances touch the filesystem (sessions, snapshots,
// index DBs), so this follows the house rule for loop-level tests.
const SKIP = !process.env.CYNCO_INTEGRATION

import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-nudge-cwd-'))
fs.writeFileSync(path.join(TEST_CWD, 'subject.txt'), 'the file under measurement\n')
afterAll(() => {
  // The loop opens a session journal and an index DB under this tree and does
  // not always have them closed by the time the suite tears down. On Windows
  // that surfaces as EBUSY, which is a cleanup detail and not a result.
  try {
    fs.rmSync(TEST_CWD, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434',
    model: 'test',
    tier: 'auto',
    temperature: 0.7,
    maxOutputTokens: 8192,
    timeout: 120000,
    // Above the two-stage tool-routing threshold, so the routing pre-call does
    // not eat the scripted responses.
    contextLength: 131072,
    tools: undefined,
    noScouts: true,
    approveAll: true,
  } as LocalCodeConfig
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced',
    toolUse: 'native',
    thinking: 'none',
    vision: false,
    jsonMode: true,
    contextLength: 32768,
    streaming: true,
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

/** A Read — the shape of every turn in a measurement phase. Mutates nothing. */
function* readResponse(id: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'm', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Read', input: {} } } as any
  yield {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: path.join(TEST_CWD, 'subject.txt') }) },
  } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

/** The nudge texts the loop injects, in all three escalation phrasings. */
const NUDGE = /Call a tool now|You MUST call a tool|FINAL WARNING: Call a tool|CONTINUE WORKING/

function countNudges(messages: any[]): number {
  let n = 0
  for (const m of messages) {
    if (m?.role !== 'user') continue
    const text = Array.isArray(m.content)
      ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('')
      : String(m.content ?? '')
    if (NUDGE.test(text)) n++
  }
  return n
}

describe('nudge backstop during a measurement phase', () => {
  it.skipIf(SKIP)('a Read answers a nudge, so investigation never exhausts the budget', async () => {
    // Stage 11I died here. The brief said MEASURE BEFORE YOU CHANGE, so the run
    // opened with Read/Grep/Bash and mutated nothing for many turns. The
    // unproductive-nudge counter was cleared only by Edit/Write/MultiEdit/
    // ApplyPatch, so three tool-less turns anywhere in that stretch exhausted
    // it; the backstop then accepted "completion" on every later stop and the
    // mission ended at turn 46 of 1200 with the job untouched.
    //
    // Interleave tool-less turns with Reads, the way a real investigation looks.
    // Under the old rule the counter reaches 3 and the loop stops early; the
    // scripted turns after that are never requested.
    // The first prose turn cannot nudge (no tool has been used in the session
    // yet), so the counter starts climbing at the second. Under the old rule it
    // reaches the limit of 3 at the turn marked below, and the loop stops
    // asking from there — everything after it is never delivered.
    const script: Array<() => Generator<StreamEvent>> = [
      () => textResponse('Let me look at how expansion is priced.'),
      () => readResponse('r1'),
      () => textResponse('Now let me check the unattended path.'),      // nudge 1
      () => readResponse('r2'),
      () => textResponse('One more thing to confirm before I change it.'), // nudge 2
      () => readResponse('r3'),
      () => textResponse('That accounts for some of it, not all.'),      // nudge 3 — old limit
      () => readResponse('r4'),
      () => textResponse('Let me check the caller before I touch anything.'),
      () => readResponse('r5'),
      () => textResponse('Confirmed. Now I know what to change.'),
      () => readResponse('r6'),
      () => textResponse('The task is complete.'),
    ]

    let delivered = 0
    let lastMessages: any[] = []
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
        lastMessages = (request.messages ?? []) as any[]
        const gen = script[delivered]
        if (gen) {
          delivered++
          yield* gen()
          return
        }
        // Past the end of the script the run is over as far as this test is
        // concerned; say so rather than yielding an empty stream, which the loop
        // would treat as a malformed response and retry.
        yield* textResponse('The task is complete.')
      },
    }

    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: () => {},
    })
    await loop.handleUserMessage('Measure before you change anything.')

    expect(delivered).toBe(script.length)

    // The observable is the nudge itself. Five prose turns are eligible: the
    // first cannot nudge (no tool has been used in the session yet) and the last
    // announces completion, which is a sanctioned stop. Each of the other five
    // gets a nudge.
    //
    // Under the old rule the counter was never cleared by a Read, so it hit the
    // limit of 3 and the loop went quiet for the rest of the run — a model
    // narrating its way through a measurement phase was read as one that had
    // finished. Measured: 3 without the fix, 5 with it.
    expect(countNudges(lastMessages)).toBe(5)
  })

  it.skipIf(SKIP)('prose with no tool call still exhausts the budget and ends the run', async () => {
    // The other half: the backstop must survive. A model that answers three
    // nudges with nothing but more prose is finished, and the loop stops asking.
    const script: Array<() => Generator<StreamEvent>> = Array.from(
      { length: 12 },
      (_, i) => () => textResponse(`Considering the problem, pass ${i}.`),
    )

    let calls = 0
    const provider: Provider = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() { return defaultCapabilities() },
      async complete() { throw new Error('not implemented') },
      async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
        const gen = script[calls++]
        if (gen) yield* gen()
      },
    }

    const loop = new ConversationLoop({
      cwd: TEST_CWD,
      config: defaultConfig(),
      provider,
      emit: () => {},
    })
    await loop.handleUserMessage('Do the work.')

    // It gives up well before the script runs out — that is the backstop.
    expect(calls).toBeLessThan(script.length)
  })
})
