import { describe, it, expect, afterEach } from 'bun:test'
import { askUserTool } from '../tools/askUser.js'
import { globalAskBroker } from '../tools/askBroker.js'

afterEach(() => {
  globalAskBroker.setEmitter(null)
  globalAskBroker.setUnattended(false)
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

  it('returns immediately when unattended, without waiting out the timeout', async () => {
    // The emitter is wired — a harness dispatches over the same socket a person
    // uses — but nobody will ever call answer(). Measured on Gilded UI Wave 6:
    // this burned the full 300s AskBroker timeout.
    let emitted = 0
    globalAskBroker.setEmitter(() => { emitted++ })
    globalAskBroker.setUnattended(true)

    const started = Date.now()
    const result = await askUserTool.execute({ question: 'which approach?' }, '/cwd')
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect(emitted).toBe(0)
    expect(globalAskBroker.pendingCount).toBe(0)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No human is attached')
    // The model must be told not to retry, or it burns turns re-asking.
    expect(result.output).toContain('Do not ask again')
  })

  it('returns immediately when nothing is wired to surface the question', async () => {
    globalAskBroker.setEmitter(null)
    const started = Date.now()
    const result = await askUserTool.execute({ question: 'hello?' }, '/cwd')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(globalAskBroker.pendingCount).toBe(0)
    expect(result.isError).toBe(false)
  })

  it('still waits for a real human once the unattended flag is cleared', async () => {
    globalAskBroker.setUnattended(true)
    globalAskBroker.setUnattended(false)
    globalAskBroker.setEmitter(req => {
      setTimeout(() => globalAskBroker.answer(req.requestId, 'option A'), 0)
    })
    const result = await askUserTool.execute({ question: 'Which option?' }, '/cwd')
    expect(result.output).toBe('option A')
  })
})
