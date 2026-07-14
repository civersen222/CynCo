// engine/daemon/oneShot.ts
// One-shot engine mode: read a task file, run the prompt through the REAL
// conversation loop (spec §4) — the same S5/VSM-governed path interactive
// sessions use — then write a TaskOutcome and return an exit code. Runs
// INSIDE the engine process (invoked from main.ts when --run-task is passed).
import { randomBytes } from 'crypto'
import type { Provider } from '../provider.js'
import type { LocalCodeConfig } from '../config.js'
import type { Message } from '../types.js'
import { ConversationLoop } from '../bridge/conversationLoop.js'
import type { EngineEvent } from '../bridge/protocol.js'
import { S5Orchestrator } from '../s5/orchestrator.js'
import { RuleBasedS5 } from '../s5/ruleBasedS5.js'
import { ModelS5 } from '../s5/modelS5.js'
import { readTaskFile, writeOutcome } from './taskFile.js'
import type { Recommendation, TaskFileInput, TaskOutcome } from './types.js'

export function buildOneShotPrompt(context: string, prompt: string): string {
  return [
    'You are running an unattended scheduled mission task. There is no user to ask — work autonomously with the tools provided, then stop.',
    '',
    'Mission context:',
    context,
    '',
    'Task:',
    prompt,
    '',
    'When you are done, end your FINAL message with exactly one fenced code block in this format:',
    '```json',
    '{"summary": "<one-paragraph summary of what you found/did>",',
    ' "recommendations": [{"actionType": "waiver|trade|lineup|info", "summary": "<short>", "detail": "<why>", "deepLink": "<optional URL>"}]}',
    '```',
    'If there is nothing actionable, return an empty recommendations array. Do not invent recommendations.',
  ].join('\n')
}

export function extractOutcome(text: string): TaskOutcome {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(blocks[i])
      if (typeof raw.summary !== 'string') continue
      const recommendations: Recommendation[] = (Array.isArray(raw.recommendations) ? raw.recommendations : [])
        .filter((r: any) => r && typeof r.actionType === 'string' && typeof r.summary === 'string' && typeof r.detail === 'string')
        .map((r: any) => ({
          // SECURITY: ids key the daemon's pending map and ride ntfy approve
          // buttons — never trust a model-supplied id, always mint our own.
          id: `rec-${randomBytes(4).toString('hex')}`,
          actionType: r.actionType,
          summary: r.summary,
          detail: r.detail,
          ...(typeof r.deepLink === 'string' ? { deepLink: r.deepLink } : {}),
        }))
      return { ok: true, summary: raw.summary, recommendations }
    } catch {
      // try the previous block
    }
  }
  // Soft failure: the model did work but broke the outcome contract. Keep
  // ok:true (don't page the user via failureStreak) but flag it visibly.
  // Sanitize before tailing — stuck runs leak reasoning (<think>) and
  // malformed <tool_call> fragments, which must never reach the phone.
  const sanitized = text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .trim()
  const tail = sanitized.slice(-1000)
  return { ok: true, summary: `(unstructured output) ${tail || '(no output)'}`, recommendations: [] }
}

function collectAssistantText(messages: Message[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type === 'text' && typeof (block as any).text === 'string') parts.push((block as any).text)
    }
  }
  return parts.join('\n')
}

/** Headless emit-sink that remembers whether the loop was halted by the
 *  algedonic kill switch, and the best available reason (P1.1). */
export function makeHaltCapture(): { emit: (e: EngineEvent) => void; haltReason: () => string | null } {
  let lastCriticalMsg: string | null = null
  let halted = false
  return {
    emit: (e: EngineEvent) => {
      if (e.type === 'governance.alert' && e.severity === 'critical' && e.message) {
        lastCriticalMsg = e.message
      }
      if (e.type === 'message.complete' && e.stopReason === 'halted') {
        halted = true
      }
    },
    haltReason: () => (halted ? (lastCriticalMsg ?? 'algedonic kill switch halted the loop') : null),
  }
}

export type TradeScanImpl = (
  task: TaskFileInput,
  provider: Provider,
  config: LocalCodeConfig,
) => Promise<TaskOutcome>

/** Run one prompt through the real S5/VSM-governed conversation loop and
 *  extract the outcome contract. Shared by plain one-shot tasks and the
 *  trade scan's ranking pass. */
export async function runGovernedLoop(opts: {
  prompt: string
  context: string
  allowedTools: string[]
  timeoutMs: number
  provider: Provider
  config: LocalCodeConfig
  /** Loop workspace root — the constructor initSnapshot()s this dir.
   *  Defaults to process.cwd() (daemon runs from the mission workspace). */
  cwd?: string
}): Promise<TaskOutcome> {
  // Same S5 selection as interactive startup (main.ts): LoRA-trained
  // decision model when configured, rule-based otherwise.
  const s5Impl = process.env.LOCALCODE_S5_MODEL
    ? new ModelS5({ model: process.env.LOCALCODE_S5_MODEL, baseUrl: opts.config.baseUrl })
    : new RuleBasedS5()
  const s5 = new S5Orchestrator(s5Impl)

  const haltCapture = makeHaltCapture()
  const loop = new ConversationLoop({
    // unattended: read-only mission tools, no TUI to ask; scouts disabled —
    // codebase scouting is irrelevant to mission tasks and burns GPU time
    config: { ...opts.config, approveAll: true, noScouts: true },
    provider: opts.provider,
    emit: haltCapture.emit, // headless — no TUI, but halts must not vanish (P1.1)
    cwd: opts.cwd ?? process.cwd(),
    s5,
    allowedTools: opts.allowedTools,
  })

  // Internal deadline backstop (the daemon also enforces a hard kill).
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; loop.abort() }, opts.timeoutMs)
  try {
    await loop.handleUserMessage(buildOneShotPrompt(opts.context, opts.prompt))
  } finally {
    clearTimeout(timer)
  }

  const collectedText = collectAssistantText(loop.getMessages())
  if (timedOut) {
    return { ok: false, summary: collectedText.slice(-1000), recommendations: [], error: 'Internal deadline exceeded' }
  }
  const haltReason = haltCapture.haltReason()
  if (haltReason) {
    return { ok: false, summary: collectedText.slice(-1000), recommendations: [], error: `HALTED: ${haltReason}` }
  }
  return extractOutcome(collectedText)
}

export async function runOneShotTask(
  taskFilePath: string,
  provider: Provider,
  config: LocalCodeConfig,
  tradeScanImpl?: TradeScanImpl,
  /** Loop workspace root override — see runGovernedLoop.cwd (tests pass a temp dir). */
  cwd?: string,
): Promise<number> {
  let outcomePath = ''
  try {
    const task = readTaskFile(taskFilePath)
    outcomePath = task.outcomePath
    console.log(`[one-shot] Mission ${task.missionId} / trigger ${task.triggerId}`)

    let outcome: TaskOutcome
    if (task.taskType === 'trade-scan') {
      // Lazy import keeps oneShot ↔ tradeScan acyclic at load time
      const impl = tradeScanImpl ?? (await import('./tradeScan.js')).runTradeScan
      outcome = await impl(task, provider, config)
    } else {
      outcome = await runGovernedLoop({
        prompt: task.prompt,
        context: task.context,
        allowedTools: task.allowedTools,
        timeoutMs: task.timeoutMs,
        provider,
        config,
        cwd,
      })
    }

    writeOutcome(outcomePath, outcome)
    console.log(`[one-shot] Outcome written: ${outcomePath}`)
    return outcome.ok ? 0 : 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[one-shot] Failed: ${msg}`)
    if (outcomePath) {
      try { writeOutcome(outcomePath, { ok: false, summary: '', recommendations: [], error: msg }) } catch {}
    }
    return 1
  }
}
