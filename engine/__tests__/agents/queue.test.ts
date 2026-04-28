import { describe, expect, it } from 'bun:test'
import { AgentQueue } from '../../agents/queue.js'
import type { AgentTask } from '../../agents/queue.js'

function makeTask(id: string, task: string = 'do something'): AgentTask {
  return { id, task, tools: ['Read', 'Bash'], status: 'pending' }
}

describe('AgentQueue', () => {
  it('enqueues and dequeues tasks in FIFO order', () => {
    const q = new AgentQueue()
    q.enqueue(makeTask('t1', 'first task'))
    q.enqueue(makeTask('t2', 'second task'))
    expect(q.size()).toBe(2)

    const first = q.dequeue()
    expect(first?.id).toBe('t1')
    expect(first?.status).toBe('running')
    expect(q.size()).toBe(1)

    const second = q.dequeue()
    expect(second?.id).toBe('t2')
    expect(q.size()).toBe(0)
  })

  it('returns null when queue is empty', () => {
    const q = new AgentQueue()
    expect(q.dequeue()).toBeNull()
    expect(q.isEmpty()).toBe(true)
  })

  it('tracks completed tasks and their results', () => {
    const q = new AgentQueue()
    q.enqueue(makeTask('t1'))
    q.dequeue()
    q.complete('t1', 'task output here')

    expect(q.completedCount()).toBe(1)
    expect(q.getResult('t1')).toBe('task output here')

    const task = q.listAll().find(t => t.id === 't1')
    expect(task?.status).toBe('completed')
    expect(task?.result).toBe('task output here')
  })

  it('lists all tasks including pending, running, completed, and failed', () => {
    const q = new AgentQueue()
    q.enqueue(makeTask('t1'))
    q.enqueue(makeTask('t2'))
    q.enqueue(makeTask('t3'))

    q.dequeue() // t1 → running
    q.complete('t1', 'done')

    q.dequeue() // t2 → running
    q.fail('t2', 'error occurred')

    const all = q.listAll()
    expect(all).toHaveLength(3)

    const statuses = Object.fromEntries(all.map(t => [t.id, t.status]))
    expect(statuses['t1']).toBe('completed')
    expect(statuses['t2']).toBe('failed')
    expect(statuses['t3']).toBe('pending')
  })
})
