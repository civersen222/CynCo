import { describe, it, expect, afterEach } from 'bun:test'
import { askUserTool } from '../tools/askUser.js'
import { globalAskBroker } from '../tools/askBroker.js'

afterEach(() => {
  globalAskBroker.setEmitter(null)
})

describe('askUserTool', () => {
  it('is an auto-tier tool named AskUser that requires a question', () => {
    expect(askUserTool.name).toBe('AskUser')
    expect(askUserTool.tier).toBe('auto')
    expect(askUserTool.inputSchema.required).toContain('question')
  })

  it('returns the human answer routed back through the broker', async () => {
    // Auto-answer: defer so the pending entry is registered before we answer.
    globalAskBroker.setEmitter(req => {
      setTimeout(() => globalAskBroker.answer(req.requestId, 'use option B'), 0)
    })

    const result = await askUserTool.execute({ question: 'Which option?', options: ['A', 'B'] }, '/cwd')

    expect(result.isError).toBe(false)
    expect(result.output).toBe('use option B')
  })

  it('errors when no question is provided', async () => {
    const result = await askUserTool.execute({}, '/cwd')
    expect(result.isError).toBe(true)
  })

  it('reports an empty answer (timeout) without erroring out', async () => {
    // Broker resolves to '' on timeout; the tool should surface that gracefully.
    globalAskBroker.setEmitter(req => {
      setTimeout(() => globalAskBroker.answer(req.requestId, ''), 0)
    })
    const result = await askUserTool.execute({ question: 'anyone there?' }, '/cwd')
    expect(result.isError).toBe(false)
    expect(result.output.toLowerCase()).toContain('no answer')
  })
})
