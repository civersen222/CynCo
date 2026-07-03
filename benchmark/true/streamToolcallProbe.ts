/**
 * Streaming tool-call probe — a falsifiable regression test for the engine's
 * STREAMING tool-call path.
 *
 * Ported from club-3090/scripts/stream-toolcall-probe.py (which targets the
 * vLLM Qwen3 #145 / vllm#39056 class: tool-call XML is emitted/parsed fine
 * NON-streaming, but the STREAMING extractor drops it at the
 * </think>-><tool_call> boundary — finish_reason:stop, markup leaks into
 * content, no structured tool call). Here it is adapted to drive LocalCode's
 * OWN streaming path: it sends tool-requiring prompts through `provider.stream()`
 * — the exact code (buildRequestBody -> llama.cpp /v1/chat/completions ->
 * parseSSELine -> fromOpenAIStreamChunk -> StreamEvent) that ConversationLoop
 * consumes — and classifies what the engine actually surfaces to its consumer.
 *
 * Why this matters here specifically:
 *   - The 2026-06-12 incident: an oversized/grammar-constrained request made
 *     llama-server EOS at 0 tokens and "every turn became a silent 0-token
 *     end_turn." That silent-drop is invisible to a non-streaming check and to
 *     a score-only benchmark — the agent simply stops calling tools and the
 *     CivKings scores crater with no obvious cause.
 *   - This probe makes that failure mode FALSIFIABLE and CI-friendly: it exits
 *     non-zero if any prompt DROPs, so a config change (grammar, MTP draft,
 *     chat template) that breaks streamed tool calls is caught before a run,
 *     not during.
 *
 * Note on observability: the llama-cpp provider's stream() does not surface
 * finish_reason (fromOpenAIStreamChunk drops it), so — unlike the upstream
 * probe — DROP is detected from what the CONSUMER sees: either tool-call markup
 * leaked into text deltas, or a completely empty turn (no text, no tool_use).
 * Those are the two observable signatures of "the streaming path lost the call"
 * for a LocalCode consumer.
 *
 * Verdicts:
 *   PASS   a structured tool_use block streamed (content_block_start with a
 *          name) with valid-JSON accumulated args and no tool-call markup
 *          leaked into the text.
 *   DROP   no tool_use block AND (markup leaked into content OR the turn was
 *          empty). The regression signature.
 *   OTHER  anything else (model produced text but declined to call a tool, or
 *          a tool call with non-JSON args / co-leaked markup). Surfaced, not a
 *          hard fail.
 *   ERROR  the stream threw (HTTP / transport / mid-stream llama error).
 *
 * Run:
 *   LOCALCODE_MODEL=qwen3.6-27b-q6k bun benchmark/true/streamToolcallProbe.ts
 *   ... --repeat 5 --temperature 0.6 --max-tokens 512
 *
 * Exits non-zero if any DROP is observed. For an A/B (e.g. grammar on vs off),
 * run twice with different env and diff the DROP counts.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../engine/config.js'
import { bootstrapProvider } from '../../engine/bootstrapProvider.js'
import type { Provider, CompletionRequest } from '../../engine/provider.js'
import type { Message, ToolDefinition } from '../../engine/types.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// ─── Classification (pure — unit-tested in streamToolcallProbe.test.ts) ──────

export interface ProbeObservation {
  /** Structured tool calls the engine surfaced via content_block_start(tool_use). */
  toolCalls: Array<{ name: string; args: string }>
  /** Accumulated text_delta content the engine surfaced. */
  text: string
  /** Error message if provider.stream() threw or emitted an error event. */
  errored?: string
}

export type Verdict = 'PASS' | 'DROP' | 'OTHER' | 'ERROR'
export interface Classification { verdict: Verdict; why: string }

/** Tool-call markup that must NOT leak into plain text when streaming works. */
const TOOL_MARKUP = /<\/?tool_call>|<\/?tool_use>/

export function classifyStream(obs: ProbeObservation): Classification {
  if (obs.errored) return { verdict: 'ERROR', why: obs.errored.slice(0, 200) }

  const named = obs.toolCalls.filter((tc) => tc.name.trim().length > 0)
  const gotCall = named.length > 0
  const leaked = TOOL_MARKUP.test(obs.text)

  let argsOk = true
  for (const tc of named) {
    try { JSON.parse(tc.args.trim() || '{}') } catch { argsOk = false }
  }

  if (gotCall && argsOk && !leaked) {
    return { verdict: 'PASS', why: `tool=${named.map((t) => t.name).join(',')}` }
  }

  // DROP: the streaming path lost the tool call entirely.
  if (!gotCall) {
    if (leaked) return { verdict: 'DROP', why: 'tool-call markup leaked into content; no structured tool_use emitted' }
    if (obs.text.trim().length === 0) return { verdict: 'DROP', why: 'silent empty turn: no text and no tool_use emitted' }
    return { verdict: 'OTHER', why: 'model produced text but emitted no tool call' }
  }

  // A call was emitted but it failed a PASS condition.
  const bits: string[] = []
  if (!argsOk) bits.push('tool args not valid JSON')
  if (leaked) bits.push('tool-call markup also leaked into content')
  return { verdict: 'OTHER', why: bits.join('; ') }
}

// ─── Probe prompts + tools ───────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a file from disk.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run a shell command and return its output.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'web_search', description: 'Search the web for a query.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'calculate', description: 'Evaluate an arithmetic expression.',
    input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
]

const SYSTEM =
  'You are a coding assistant with tools. When the user asks you to read a file, ' +
  'run a command, search the web, or compute something, you MUST call the matching ' +
  'tool rather than answering from memory. Call exactly one tool.'

const u = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })

const SINGLE_TURN: Array<{ name: string; messages: Message[] }> = [
  { name: 'S1', messages: [u('Read the file /etc/hosts and summarize it.')] },
  { name: 'S2', messages: [u('Run `df -h` and tell me the root filesystem usage.')] },
  { name: 'S3', messages: [u('List the current directory by running `ls -la`.')] },
  { name: 'S4', messages: [u('Search the web for the latest Qwen3 release notes.')] },
  { name: 'S5', messages: [u('Compute 17 * 23 + 100 using the calculator.')] },
  { name: 'S6', messages: [u('What is 2 to the power of 16? Use the calculator tool.')] },
]

// Multi-turn: turn 1 already has a tool result; turn 2 must call again — exercises
// the boundary mid-conversation, where #145's intermittent turn-N failures appeared.
const MULTI_TURN: Array<{ name: string; messages: Message[] }> = [
  { name: 'M1', messages: [
    u('Read /etc/os-release.'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: '/etc/os-release' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'NAME="Ubuntu"\nVERSION="24.04"' }] },
    u('Now read /etc/hostname too.'),
  ] },
  { name: 'M2', messages: [
    u('Run `uname -r`.'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'run_shell', input: { command: 'uname -r' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '6.8.0-124-generic' }] },
    u('Good. Now run `nproc` to count CPUs.'),
  ] },
]

// ─── One streamed request, accumulated into a ProbeObservation ───────────────

async function observe(provider: Provider, req: CompletionRequest): Promise<ProbeObservation> {
  const slots = new Map<number, { name: string; args: string }>()
  let text = ''
  let errored: string | undefined
  try {
    for await (const ev of provider.stream(req)) {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
        slots.set(ev.index, { name: ev.content_block.name, args: '' })
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') text += ev.delta.text
        else if (ev.delta.type === 'input_json_delta') {
          const slot = slots.get(ev.index)
          if (slot) slot.args += ev.delta.partial_json
        }
      } else if (ev.type === 'error') {
        errored = ev.error.message
      }
    }
  } catch (e) {
    errored = e instanceof Error ? e.message : String(e)
  }
  return { toolCalls: [...slots.values()], text, errored }
}

async function main() {
  const repeat = parseInt(arg('--repeat', '3'), 10)
  const temperature = parseFloat(arg('--temperature', '0.6'))
  const maxTokens = parseInt(arg('--max-tokens', '512'), 10)
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error(`[stream-toolcall] invalid --repeat: ${arg('--repeat', '3')}`)
    process.exit(2)
  }

  const config = loadConfig()
  if (!config.model) {
    console.error('[stream-toolcall] no model configured (set LOCALCODE_MODEL)')
    process.exit(2)
  }

  const cases = [...SINGLE_TURN, ...MULTI_TURN]
  console.log(`[stream-toolcall] model=${config.model}  ${cases.length} prompts x ${repeat} repeats = ${cases.length * repeat} streamed requests`)

  const { provider } = await bootstrapProvider(config)
  const counts: Record<Verdict, number> = { PASS: 0, DROP: 0, OTHER: 0, ERROR: 0 }
  const drops: string[] = []
  const lines: string[] = []

  try {
    for (const c of cases) {
      for (let r = 1; r <= repeat; r++) {
        const tag = `${c.name}#${r}`
        const req: CompletionRequest = {
          model: config.model,
          system: SYSTEM,
          messages: c.messages,
          tools: TOOLS,
          max_tokens: maxTokens,
          temperature,
          // qwen3.6 reasons by default (the #145 trigger); the provider does not
          // currently forward a thinking toggle, so this records intent only.
          thinking: { enabled: true },
        }
        const obs = await observe(provider, req)
        const { verdict, why } = classifyStream(obs)
        counts[verdict]++
        const line = `  ${tag.padEnd(7)} ${verdict.padEnd(5)} ${why}`
        console.log(line)
        lines.push(line)
        if (verdict === 'DROP') drops.push(`${tag}: ${why}`)
      }
    }
  } finally {
    const pm = (globalThis as any).__llamaProcessManager
    if (pm) { try { await pm.stop() } catch {} }
  }

  const total = counts.PASS + counts.DROP + counts.OTHER + counts.ERROR
  const summary =
    `=== STREAMING TOOL-CALL PROBE ===\n` +
    `model: ${config.model}\n` +
    `requests: ${total}  PASS: ${counts.PASS}  DROP: ${counts.DROP}  OTHER: ${counts.OTHER}  ERROR: ${counts.ERROR}\n` +
    `verdict: ${counts.DROP === 0 ? 'OK (no streamed tool-call drops)' : `REGRESSION (${counts.DROP} drops)`}\n` +
    (drops.length ? `\nDROPs:\n${drops.map((d) => '  ' + d).join('\n')}\n` : '') +
    `\nper-request:\n${lines.join('\n')}\n`

  const outDir = join(import.meta.dirname, 'results')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `streamtoolcall-${Date.now()}.summary.txt`)
  writeFileSync(outFile, summary)

  console.log(`\n${summary.split('\n').slice(0, 4).join('\n')}`)
  console.log(`evidence: ${outFile}`)

  // CI-friendly: any streamed tool-call drop fails the probe.
  process.exit(counts.DROP > 0 ? 1 : 0)
}

// Only run when executed directly (`bun streamToolcallProbe.ts`), NOT when the
// classifier is imported by the unit test — importing must not boot llama-server.
if ((import.meta as any).main) {
  main().catch((e) => { console.error(e); process.exit(2) })
}
