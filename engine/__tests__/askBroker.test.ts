import { describe, it, expect } from 'bun:test'
import { AskBroker } from '../tools/askBroker.js'
import type { AskRequest } from '../tools/askBroker.js'

describe('AskBroker', () => {
  it('emits a request carrying the question, options and a requestId', () => {
    const broker = new AskBroker({ timeoutMs: 20 })
    const reqs: AskRequest[] = []
    broker.setEmitter(r => reqs.push(r))

    broker.ask('Pick one', ['a', 'b'])

    expect(reqs.length).toBe(1)
    expect(reqs[0].question).toBe('Pick one')
    expect(reqs[0].options).toEqual(['a', 'b'])
    expect(reqs[0].requestId).toBeTruthy()
  })

  it('resolves ask() with the text passed to answer()', async () => {
    const broker = new AskBroker({ timeoutMs: 1000 })
    let id = ''
    broker.setEmitter(r => { id = r.requestId })

    const p = broker.ask('Proceed?', ['yes', 'no'])
    const ok = broker.answer(id, 'yes')

    expect(ok).toBe(true)
    expect(await p).toBe('yes')
  })

  it('answer() returns false for an unknown requestId', () => {
    const broker = new AskBroker()
    broker.setEmitter(() => {})
    expect(broker.answer('does-not-exist', 'x')).toBe(false)
  })

  it('resolves to an empty string when the request times out', async () => {
    const broker = new AskBroker({ timeoutMs: 10 })
    broker.setEmitter(() => {})
    expect(await broker.ask('q')).toBe('')
  })

  it('tracks pendingCount as requests are opened and answered', () => {
    const broker = new AskBroker({ timeoutMs: 1000 })
    let id = ''
    broker.setEmitter(r => { id = r.requestId })

    broker.ask('q')
    expect(broker.pendingCount).toBe(1)
    broker.answer(id, 'done')
    expect(broker.pendingCount).toBe(0)
  })

  it('does not throw when asking with no emitter set', () => {
    const broker = new AskBroker({ timeoutMs: 20 })
    expect(() => broker.ask('q')).not.toThrow()
  })
})
