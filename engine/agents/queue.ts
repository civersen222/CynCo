export type AgentTask = {
  id: string
  task: string
  tools: string[]
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: string
}

export class AgentQueue {
  private pending: AgentTask[] = []
  private completed: Map<string, string> = new Map()
  private all: Map<string, AgentTask> = new Map()

  enqueue(task: AgentTask): void {
    this.pending.push(task)
    this.all.set(task.id, task)
  }

  dequeue(): AgentTask | null {
    const task = this.pending.shift() ?? null
    if (task) task.status = 'running'
    return task
  }

  complete(taskId: string, result: string): void {
    const task = this.all.get(taskId)
    if (task) { task.status = 'completed'; task.result = result }
    this.completed.set(taskId, result)
  }

  fail(taskId: string, error: string): void {
    const task = this.all.get(taskId)
    if (task) { task.status = 'failed'; task.result = error }
  }

  getResult(taskId: string): string | undefined { return this.completed.get(taskId) }
  size(): number { return this.pending.length }
  completedCount(): number { return this.completed.size }
  listAll(): AgentTask[] { return Array.from(this.all.values()) }
  isEmpty(): boolean { return this.pending.length === 0 }
}
