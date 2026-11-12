// F223, the parts put together as bootstrapProvider puts them: the real ProcessManager's lazy path behind
// the real lazy gate, under the real fallback provider and its real port-holder reader. Only the process
// boundary is stubbed: the port, the kill (refused, as for a server started as administrator) and the two
// model servers. One chat request must come back answered by the fallback, with the truth said once.
import { describe, expect, it } from 'bun:test'
import type { CompletionRequest, Provider } from '../../provider.js'
import { BusyFallbackProvider, portHolderReader } from '../../llama/busyFallback.js'
import { isPortHeldError } from '../../llama/errors.js'
import { createLazyEnsureReady } from '../../llama/lazyLoad.js'
import { ProcessManager } from '../../llama/processManager.js'
import type { PortOwner } from '../../llama/portOwner.js'

const DENIED = 'Windows refused (Access is denied): it was started as administrator and CynCo was not'
const owner: PortOwner = { owner: 'foreign', detail: 'pid 29720 (llama-server.exe), started by bash.exe' }
const req: CompletionRequest = { model: 'Qwen3.8-27B', messages: [] }

function wire(opts: { fallbackUp: boolean }) {
  const pm = new ProcessManager({ binaryPath: '/bin/llama-server', modelPath: '/models/qwen.gguf', port: 8081 })
  const calls = { start: 0, kill: 0, primaryAnswered: 0, fallbackAnswered: 0 }
  const told: string[] = []
  pm.onWaiting = (m) => told.push(m)
  const stub = pm as unknown as Record<string, unknown>
  stub.startProcess = async () => { calls.start++ }
  stub.killProcessOnPort = async () => { calls.kill++; return DENIED }
  stub.isPortOccupied = async () => true
  stub.portAnswersHealth = async () => true
  const ensureReady = createLazyEnsureReady(pm, { readBusy: () => null, maxWaitMs: 30 * 60_000, portOwner: async () => owner })
  // The primary as LlamaCppProvider behaves on a lazy engine: every call passes the gate first.
  const primary: Provider = {
    name: 'llama-cpp',
    listModels: async () => [],
    probeCapabilities: async () => ({}) as never,
    healthCheck: async () => true,
    complete: async (r) => { await ensureReady(r.signal); calls.primaryAnswered++; return { content: [] } as never },
    stream: async function* (r) { await ensureReady(r.signal); calls.primaryAnswered++; yield { type: 'message_stop' } as never },
    countTokens: async (_t, signal) => { await ensureReady(signal); return 1 },
  }
  const fallback: Provider = {
    name: 'ollama',
    listModels: async () => [],
    probeCapabilities: async () => ({}) as never,
    healthCheck: async () => opts.fallbackUp,
    complete: async (r) => { calls.fallbackAnswered++; return { content: [{ type: 'text', text: r.model }] } as never },
    stream: async function* (r) { calls.fallbackAnswered++; yield { type: 'message_stop', model: r.model } as never },
    countTokens: async (t) => t.length,
  }
  const provider = new BusyFallbackProvider({
    primary, fallback, fallbackModel: 'qwen3:14b', fallbackLabel: '192.168.0.47:11434',
    readBusy: () => null,
    remainingMs: () => null,
    primaryWarm: () => pm.modelState() === 'warm',
    readPortHolder: portHolderReader({ port: 8081, ownServerUp: () => pm.isRunning(), isPortOccupied: () => pm.isPortOccupied(), isHealthy: () => pm.portAnswersHealth(), portOwner: async () => owner, cannotStop: () => pm.cannotStop() }),
    fallbackHealthy: () => fallback.healthCheck(),
    notify: (m) => pm.onWaiting?.(m),
    log: () => {},
  })
  return { pm, provider, calls, told }
}

describe('a chat turn behind a server that runs as administrator (F223)', () => {
  it('is answered on the fallback: the count and the request both, with the truth said once and no wait', async () => {
    const { pm, provider, calls, told } = wire({ fallbackUp: true })
    // A turn counts its context, then asks.
    expect(await provider.countTokens!('four')).toBe(4)
    const res = await provider.complete(req)
    expect((res as unknown as { content: Array<{ text: string }> }).content[0].text).toBe('qwen3:14b')
    expect(calls).toEqual({ start: 0, kill: 1, primaryAnswered: 0, fallbackAnswered: 1 })
    expect(told).toEqual([
      `port 8081 is held by a server that is not CynCo's: ${owner.detail}. CynCo could not stop it: ${DENIED}. Close the window it was started from; CynCo's model loads once the port is free.`,
      `The model port is held by ${owner.detail}, which CynCo could not stop (${DENIED}); answering on qwen3:14b at 192.168.0.47:11434 until it is free`,
    ])
    expect(told.join(' ')).not.toMatch(/Stopped it/)
    expect(pm.modelState()).not.toBe('waiting')
    // The next turn: the same server is not killed again and nothing more is said.
    await provider.complete(req)
    expect(calls.kill).toBe(1)
    expect(told).toHaveLength(2)
  })

  it('with no fallback to go to, is refused at once with the reason', async () => {
    const { provider, calls, told } = wire({ fallbackUp: false })
    const began = Date.now()
    const e = await provider.complete(req).then(() => null, err => err as Error)
    expect(isPortHeldError(e)).toBe(true)
    expect(e!.message).toContain('CynCo could not stop it')
    expect(Date.now() - began).toBeLessThan(4000)
    expect(calls).toEqual({ start: 0, kill: 1, primaryAnswered: 0, fallbackAnswered: 0 })
    expect(told).toHaveLength(1)
  })
})
