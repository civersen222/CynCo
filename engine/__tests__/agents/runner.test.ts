import { describe, expect, it } from 'bun:test'
import { SubAgentRunner } from '../../agents/runner.js'
import type { AgentTask } from '../../agents/queue.js'

function makeEchoRunner(): SubAgentRunner {
  return new SubAgentRunner(async (task: AgentTask) => `result for: ${task.task}`)
}

describe('SubAgentRunner', () => {
  it('submit returns a UUID task id and increments pending count', () => {
    const runner = makeEchoRunner()
    const id = runner.submit('analyze the codebase', ['Read', 'Grep'])

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    // UUID pattern
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(runner.pendingCount).toBe(1)
  })

  it('processNext dequeues and executes the next task', async () => {
    const runner = makeEchoRunner()
    const id = runner.submit('write tests')

    const result = await runner.processNext()

    expect(result).not.toBeNull()
    expect(result!.id).toBe(id)
    expect(result!.result).toBe('result for: write tests')
    expect(runner.pendingCount).toBe(0)
    expect(runner.completedCount).toBe(1)
  })

  it('processNext returns null when queue is empty', async () => {
    const runner = makeEchoRunner()
    const result = await runner.processNext()
    expect(result).toBeNull()
  })

  it('processAll executes all queued tasks sequentially', async () => {
    const order: string[] = []
    const runner = new SubAgentRunner(async (task: AgentTask) => {
      order.push(task.task)
      return `done: ${task.task}`
    })

    runner.submit('task A')
    runner.submit('task B')
    runner.submit('task C')

    expect(runner.pendingCount).toBe(3)

    const results = await runner.processAll()

    expect(results).toHaveLength(3)
    expect(order).toEqual(['task A', 'task B', 'task C'])
    expect(runner.pendingCount).toBe(0)
    expect(runner.completedCount).toBe(3)
  })

  it('handles errors in runFn gracefully and marks task as failed', async () => {
    const runner = new SubAgentRunner(async () => {
      throw new Error('execution failed')
    })
    const id = runner.submit('risky task')

    const result = await runner.processNext()

    expect(result).not.toBeNull()
    expect(result!.id).toBe(id)
    expect(result!.result).toContain('[error]')
    expect(result!.result).toContain('execution failed')
  })
})
