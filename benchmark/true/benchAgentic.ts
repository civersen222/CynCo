/**
 * Agentic prefill benchmark — the serving-cost lens on a long coding session.
 *
 * Ported from club-3090/scripts/bench-agentic.sh. Where run.ts/deepdive.ts score
 * task QUALITY, this characterizes the SERVING COST of an agentic session: it
 * replays a fixture of growing tool results turn-over-turn and measures, per
 * turn, time-to-first-token (TTFT) and decode tok/s as accumulated context
 * grows. That incremental-prefill cost — not single-prompt decode — is what
 * dominates every round >5 in a real CynCo/Cline/Claude-Code session.
 *
 * It bootstraps the real provider (which starts llama-server) and then hits the
 * llama.cpp OpenAI endpoint directly so it can read `usage` and time the first
 * streamed byte precisely (the engine's provider.stream() drops usage and
 * finish_reason, so a raw request is the honest way to measure TTFT + tok/s).
 *
 * Fixture: benchmark/true/fixtures/agentic-bench-fixture.json — deterministic,
 * opaque tool-result payloads of growing size. Used only to grow prompt depth;
 * paths/commands in it are NOT executed.
 *
 * Ramp robustness (mirrors upstream #255): the context ramp is driven by
 * tool_choice='required', but does NOT depend on tool-call success. If the model
 * fails to emit a parseable tool call at depth, the turn synthesizes one so the
 * prompt keeps growing by the same fixed payload (the fixture tool_result is
 * injected regardless). The miss is logged + counted. Only genuine transport
 * errors stop the ramp — you can't grow context off a dead request.
 *
 * Run:
 *   LOCALCODE_MODEL=qwen3.6-27b-q6k bun benchmark/true/benchAgentic.ts
 *   ... --turns 12 --sessions 2 --max-tokens 150
 *
 * Output: per-turn table + TTFT growth verdict, written to
 * results/benchagentic-<ts>.summary.txt
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../engine/config.js'
import { bootstrapProvider } from '../../engine/bootstrapProvider.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

interface FixtureTurn { user_msg: string; tool_result: string; chars: number }
interface OAIMessage { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }
export interface TurnMetric { turn: number; promptTokens: number; ttftMs: number; decodeTps: number; completionTokens: number; missed: boolean }

const SYSTEM =
  'You are an autonomous coding assistant working inside a TypeScript/Python repository. ' +
  'When file contents, search results, or command output would change your answer, call the ' +
  'appropriate tool — do not speculate. After each tool call, briefly state what you learned ' +
  'and your next step. Keep replies under 80 words; defer to tools for raw data.'

const TOOLS = [
  'Read', 'Bash', 'Edit', 'Write', 'Grep', 'LS', 'TodoRead', 'TodoWrite', 'WebSearch', 'WebFetch',
].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `${name} tool.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }, command: { type: 'string' },
        pattern: { type: 'string' }, content: { type: 'string' },
      },
      required: [],
    },
  },
}))

/** Resolve the llama.cpp OpenAI completions URL from the provider or config. */
function completionsUrl(provider: unknown, port: number): string {
  const fromProvider = (provider as { getCompletionsUrl?: () => string })?.getCompletionsUrl?.()
  return fromProvider ?? `http://127.0.0.1:${port}/v1/chat/completions`
}

async function detectModel(baseCompletionsUrl: string, fallback: string): Promise<string> {
  const modelsUrl = baseCompletionsUrl.replace(/\/v1\/chat\/completions$/, '/v1/models')
  try {
    const r = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const j = (await r.json()) as { data?: Array<{ id?: string }> }
      const id = j.data?.[0]?.id
      if (id) return id
    }
  } catch { /* fall through */ }
  return fallback
}

/** One streamed turn against the raw endpoint; measures TTFT + decode tok/s. */
async function runTurn(
  url: string, model: string, messages: OAIMessage[], maxTokens: number,
): Promise<{ ttftMs: number; decodeTps: number; promptTokens: number; completionTokens: number; toolCall: { id: string; name: string; args: string } | null }> {
  const body = JSON.stringify({
    model, messages, tools: TOOLS, tool_choice: 'required',
    max_tokens: maxTokens, temperature: 0.3, stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false },
  })
  const tSend = Date.now()
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`llama-server HTTP ${resp.status}: ${detail.slice(0, 300)}`)
  }
  const reader = resp.body?.getReader()
  if (!reader) throw new Error('no response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let ttft: number | null = null
  let promptTokens = 0, completionTokens = 0, contentChars = 0
  const slots = new Map<number, { id: string; name: string; args: string }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let chunk: any
      try { chunk = JSON.parse(payload) } catch { continue }
      const choice = chunk.choices?.[0]
      if (choice) {
        const delta = choice.delta ?? {}
        if (ttft === null && (delta.content || delta.tool_calls)) ttft = Date.now() - tSend
        if (delta.content) contentChars += String(delta.content).length
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const slot = slots.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.args += tc.function.arguments
          slots.set(idx, slot)
        }
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens
        completionTokens = chunk.usage.completion_tokens ?? completionTokens
      }
    }
  }

  const wall = Date.now() - tSend
  if (ttft === null) ttft = wall
  if (completionTokens === 0) completionTokens = Math.max(1, Math.round(contentChars / 4)) // usage fallback
  const decodeS = Math.max((wall - ttft) / 1000, 1e-6)
  const named = [...slots.values()].find((s) => s.name)
  return { ttftMs: ttft, decodeTps: completionTokens / decodeS, promptTokens, completionTokens, toolCall: named ?? null }
}

async function runSession(
  url: string, model: string, fixture: FixtureTurn[], maxTokens: number, sessionId: number,
): Promise<{ metrics: TurnMetric[]; misses: number }> {
  const messages: OAIMessage[] = [{ role: 'system', content: SYSTEM }]
  const metrics: TurnMetric[] = []
  let misses = 0

  for (let t = 0; t < fixture.length; t++) {
    const ft = fixture[t]
    messages.push({ role: 'user', content: ft.user_msg })
    const r = await runTurn(url, model, messages, maxTokens)

    // #255: keep the ramp alive even if the model emits no parseable tool call.
    const missed = !r.toolCall
    if (missed) misses++
    const call = r.toolCall ?? { id: `synthetic_s${sessionId}_t${t}`, name: TOOLS[0].function.name, args: '{}' }
    const callId = call.id || `call_s${sessionId}_t${t}`
    messages.push({ role: 'assistant', content: null, tool_calls: [
      { id: callId, type: 'function', function: { name: call.name, arguments: call.args || '{}' } },
    ] })
    messages.push({ role: 'tool', tool_call_id: callId, content: ft.tool_result })

    metrics.push({
      turn: t + 1, promptTokens: r.promptTokens, ttftMs: r.ttftMs,
      decodeTps: r.decodeTps, completionTokens: r.completionTokens, missed,
    })
    console.log(
      `  s${sessionId} turn ${String(t + 1).padStart(2)}  prompt_tok ${String(r.promptTokens).padStart(6)}  ` +
      `ttft ${r.ttftMs.toFixed(0).padStart(6)}ms  decode ${r.decodeTps.toFixed(1).padStart(6)} tok/s` +
      (missed ? '  [tool-call miss → synthesized]' : ''),
    )
  }
  return { metrics, misses }
}

/** Linear-regression slope of TTFT vs prompt tokens (ms per 1K tokens). */
export function ttftSlope(rows: TurnMetric[]): number {
  const n = rows.length
  if (n < 2) return 0
  const xs = rows.map((r) => r.promptTokens / 1000)
  const ys = rows.map((r) => r.ttftMs)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2 }
  return den === 0 ? 0 : num / den
}

async function main() {
  const turns = parseInt(arg('--turns', '12'), 10)
  const sessions = parseInt(arg('--sessions', '2'), 10)
  const maxTokens = parseInt(arg('--max-tokens', '150'), 10)

  const config = loadConfig()
  if (!config.model) { console.error('[bench-agentic] no model configured (set LOCALCODE_MODEL)'); process.exit(2) }

  const fixturePath = join(import.meta.dirname, 'fixtures', 'agentic-bench-fixture.json')
  const fixture = (JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureTurn[]).slice(0, turns)
  console.log(`[bench-agentic] model=${config.model}  sessions=${sessions}  turns=${fixture.length}  accumulates ~${Math.round(fixture.reduce((s, f) => s + f.chars, 0) / 4).toLocaleString()} tokens`)

  const { provider } = await bootstrapProvider(config)
  const url = completionsUrl(provider, config.port)
  const model = await detectModel(url, config.model)

  const perTurn: TurnMetric[][] = Array.from({ length: fixture.length }, () => [])
  let totalMisses = 0
  try {
    for (let s = 1; s <= sessions; s++) {
      console.log(`\n=== SESSION ${s}/${sessions} ===`)
      const { metrics, misses } = await runSession(url, model, fixture, maxTokens, s)
      totalMisses += misses
      metrics.forEach((m) => perTurn[m.turn - 1].push(m))
    }
  } finally {
    const pm = (globalThis as any).__llamaProcessManager
    if (pm) { try { await pm.stop() } catch {} }
  }

  const median = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)] }
  const aggregated: TurnMetric[] = perTurn.filter((g) => g.length).map((g) => ({
    turn: g[0].turn,
    promptTokens: Math.round(median(g.map((m) => m.promptTokens))),
    ttftMs: Math.round(median(g.map((m) => m.ttftMs))),
    decodeTps: +median(g.map((m) => m.decodeTps)).toFixed(1),
    completionTokens: Math.round(median(g.map((m) => m.completionTokens))),
    missed: g.some((m) => m.missed),
  }))

  const slope = ttftSlope(aggregated)
  const ttft0 = aggregated[0]?.ttftMs ?? 0
  const ttftN = aggregated[aggregated.length - 1]?.ttftMs ?? 0
  const shape = slope > 50 && ttftN > ttft0 * 2 ? 'LINEAR (incremental prefill grows with context)' : 'FLAT-ish (prefix caching holding)'

  const header = `=== AGENTIC PREFILL BENCH ===\nmodel: ${model}  sessions: ${sessions}  turns: ${aggregated.length}\ntool-call misses (synthesized): ${totalMisses}\n`
  const table = ['turn  prompt_tok   ttft_ms   decode_tps', ...aggregated.map((m) =>
    `${String(m.turn).padStart(4)}  ${String(m.promptTokens).padStart(10)}  ${String(m.ttftMs).padStart(8)}  ${m.decodeTps.toFixed(1).padStart(10)}`,
  )].join('\n')
  const analysis = `\nTTFT growth: ${slope.toFixed(1)} ms per 1K prompt tokens  (turn1=${ttft0}ms → turn${aggregated.length}=${ttftN}ms)\nshape: ${shape}\n`
  const summary = `${header}\n${table}\n${analysis}`

  const outDir = join(import.meta.dirname, 'results')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `benchagentic-${Date.now()}.summary.txt`)
  writeFileSync(outFile, summary)
  console.log(`\n${summary}\nevidence: ${outFile}`)
}

if ((import.meta as any).main) {
  main().catch((e) => { console.error(e); process.exit(2) })
}
