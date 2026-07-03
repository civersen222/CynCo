import type { Provider } from '../../../engine/provider.js'
import type { Message } from '../../../engine/types.js'
import { ConversationLoop } from '../../../engine/bridge/conversationLoop.js'
import { S5Orchestrator } from '../../../engine/s5/orchestrator.js'
import { RuleBasedS5 } from '../../../engine/s5/ruleBasedS5.js'
import { withAblationEnv } from './ablationEnv.js'

export interface DriveResult {
  messages: Message[]
  timedOut: boolean
}

/**
 * Run a single task to completion in `cwd` under the given arm. Mirrors the
 * loop construction used by engine/main.ts --run-ablation (approveAll, noScouts,
 * silent emitter), but with cwd pointed at the isolated clone.
 */
export async function runTask(opts: {
  prompt: string
  cwd: string
  governed: boolean
  config: any
  provider: Provider
  timeoutMs: number
}): Promise<DriveResult> {
  return withAblationEnv(opts.governed, async () => {
    const s5 = new S5Orchestrator(new RuleBasedS5())
    const loop = new ConversationLoop({
      config: { ...opts.config, approveAll: true, noScouts: true },
      provider: opts.provider,
      emit: () => {},
      cwd: opts.cwd,
      s5,
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; loop.abort() }, opts.timeoutMs)
    try {
      await loop.handleUserMessage(opts.prompt)
    } finally {
      clearTimeout(timer)
    }
    return { messages: loop.getMessages(), timedOut }
  })
}

/** Count of assistant messages — used as the secondary `turns` metric. */
export function countTurns(messages: Message[]): number {
  return messages.filter((m) => m.role === 'assistant').length
}
