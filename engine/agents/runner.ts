import { randomUUID } from 'crypto'
import { AgentQueue } from './queue.js'
import type { AgentTask } from './queue.js'

export type RunResult = {
  id: string
  result: string
}

export class SubAgentRunner {
  private queue: AgentQueue
  private runFn: (task: AgentTask) => Promise<string>

  constructor(
    runFn: (task: AgentTask) => Promise<string>,
    queue?: AgentQueue,
  ) {
    this.runFn = runFn
    this.queue = queue ?? new AgentQueue()
  }

  /**
   * Submit a task to the queue. Returns the task ID.
   */
  submit(task: string, tools: string[] = []): string {
    const id = randomUUID()
    this.queue.enqueue({ id, task, tools, status: 'pending' })
    return id
  }

  /**
   * Dequeue and execute the next pending task.
   * Returns the result, or null if the queue is empty.
   */
  async processNext(): Promise<RunResult | null> {
    const agentTask = this.queue.dequeue()
    if (!agentTask) return null

    try {
      const result = await this.runFn(agentTask)
      this.queue.complete(agentTask.id, result)
      return { id: agentTask.id, result }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.queue.fail(agentTask.id, error)
      return { id: agentTask.id, result: `[error] ${error}` }
    }
  }

  /**
   * Process all queued tasks sequentially, returning all results.
   */
  async processAll(): Promise<RunResult[]> {
    const results: RunResult[] = []
    while (!this.queue.isEmpty()) {
      const result = await this.processNext()
      if (result) results.push(result)
    }
    return results
  }

  get pendingCount(): number {
    return this.queue.size()
  }

  get completedCount(): number {
    return this.queue.completedCount()
  }
}
