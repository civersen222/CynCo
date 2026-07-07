// benchmark/true/polyglot/runLoop.ts
import type { Provider } from '../../../engine/provider.js'
import { ConversationLoop } from '../../../engine/bridge/conversationLoop.js'
import { S5Orchestrator } from '../../../engine/s5/orchestrator.js'
import { RuleBasedS5 } from '../../../engine/s5/ruleBasedS5.js'

export interface TryResult {
  timedOut: boolean
  error?: string
}

/**
 * One ConversationLoop per exercise, kept alive across both tries so the
 * try-2 error feedback lands in the SAME conversation (aider's pass@2
 * protocol). Loop construction mirrors benchmark/true/harness/driver.ts:
 * approveAll, noScouts, silent emitter, S5 governance active (as-shipped).
 */
export class ExerciseSession {
  private loop: ConversationLoop

  constructor(opts: { config: any; provider: Provider; cwd: string }) {
    const s5 = new S5Orchestrator(new RuleBasedS5())
    this.loop = new ConversationLoop({
      config: { ...opts.config, approveAll: true, noScouts: true },
      provider: opts.provider,
      emit: () => {},
      cwd: opts.cwd,
      s5,
    })
  }

  /** Send one try. A timeout aborts the loop but keeps the session usable-enough to record. */
  async sendTry(prompt: string, timeoutMs: number): Promise<TryResult> {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.loop.abort()
    }, timeoutMs)
    try {
      await this.loop.handleUserMessage(prompt)
    } catch (err) {
      return { timedOut, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
    return timedOut ? { timedOut, error: 'try timeout' } : { timedOut: false }
  }
}
