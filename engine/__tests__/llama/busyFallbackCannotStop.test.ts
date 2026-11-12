// F223: a server on the model port that CynCo tried to stop and could not.
//
// The live hand-off, 2026-11-11: dndai's model server ran as administrator. The engine could not stop it,
// said it had, and then sat at `modelState: "waiting"` behind a server that would never yield until the
// turn was stopped by hand after 200 s. A wait that cannot end is not offered: the lazy path refuses
// (`PortHeldError`), and where the small-model fallback is set up it answers instead, as it does behind
// another engine's server (F213).
import { describe, expect, it } from 'bun:test'
import type { CompletionRequest, Provider } from '../../provider.js'
import { BusyFallbackProvider, portHolderReader } from '../../llama/busyFallback.js'
import { PortHeldError } from '../../llama/errors.js'
import type { PortOwner } from '../../llama/portOwner.js'

const DETAIL = 'pid 29720 (llama-server.exe), started by bash.exe'
const WHY = 'Windows refused (Access is denied): it was started as administrator and CynCo was not'
const req: CompletionRequest = { model: 'Qwen3.8-27B', messages: [] }

/** The primary as a lazy engine behind an unstoppable server: its first use tries the stop, fails, and refuses. */
function rig(opts: { fallbackUp?: boolean } = {}) {
  let stuck: { detail: string; why: string } | null = null
  const calls = { primary: 0, fallback: 0, tried: 0 }
  const refuse = () => {
    calls.tried++
    stuck = { detail: DETAIL, why: WHY }
    throw new PortHeldError(8081, `port 8081 is held by a server that is not CynCo's: ${DETAIL}. CynCo could not stop it: ${WHY}.`)
  }
  const primary: Provider = {
    name: 'llama-cpp',
    listModels: async () => [],
    probeCapabilities: async () => ({}) as never,
    healthCheck: async () => true,
    complete: async () => { calls.primary++; return refuse() },
    stream: async function* () { calls.primary++; refuse(); yield {} as never },
    countTokens: async () => { calls.primary++; return refuse() },
  }
  const fallback: Provider = {
    name: 'ollama',
    listModels: async () => [],
    probeCapabilities: async () => ({}) as never,
    healthCheck: async () => true,
    complete: async (r) => { calls.fallback++; return { content: [{ type: 'text', text: r.model }] } as never },
    stream: async function* (r) { calls.fallback++; yield { type: 'message_stop', model: r.model } as never },
    countTokens: async (t) => { calls.fallback++; return t.length },
  }
  const notices: string[] = []
  const owner: PortOwner = { owner: 'foreign', detail: DETAIL }
  const p = new BusyFallbackProvider({
    primary, fallback, fallbackModel: 'qwen3:14b', fallbackLabel: '192.168.0.47:11434',
    readBusy: () => null,
    remainingMs: () => null,
    primaryWarm: () => false,
    readPortHolder: portHolderReader({ port: 8081, ownServerUp: () => false, isPortOccupied: async () => true, isHealthy: async () => true, portOwner: async () => owner, cannotStop: () => stuck }),
    fallbackHealthy: async () => opts.fallbackUp ?? true,
    notify: (m) => notices.push(m),
    log: () => {},
  })
  return { p, calls, notices }
}

describe('BusyFallbackProvider behind a server CynCo could not stop', () => {
  it('the request that met the refusal is answered by the fallback, and the chat is told once why', async () => {
    const { p, calls, notices } = rig()
    const res = await p.complete(req)
    expect((res as unknown as { content: Array<{ text: string }> }).content[0].text).toBe('qwen3:14b')
    expect(calls).toEqual({ primary: 1, fallback: 1, tried: 1 })
    expect(notices).toEqual([`The model port is held by ${DETAIL}, which CynCo could not stop (${WHY}); answering on qwen3:14b at 192.168.0.47:11434 until it is free`])
    // The next requests go straight to the fallback: the stop is not tried again and nothing more is said.
    await p.complete(req)
    for await (const _ of p.stream(req)) { /* drain */ }
    expect(await p.countTokens('four')).toBe(4)
    expect(calls).toEqual({ primary: 1, fallback: 4, tried: 1 })
    expect(notices).toHaveLength(1)
  })

  it('a stream and a token count that meet the refusal are answered by the fallback too', async () => {
    const a = rig()
    const events: unknown[] = []
    for await (const e of a.p.stream(req)) events.push(e)
    expect(events).toEqual([{ type: 'message_stop', model: 'qwen3:14b' }])
    const b = rig()
    expect(await b.p.countTokens('four')).toBe(4)
    expect(b.calls.tried).toBe(1)
  })

  it('with the fallback box down the refusal is what the turn gets: a reason at once, not a wait', async () => {
    const { p, calls } = rig({ fallbackUp: false })
    const e = await p.complete(req).then(() => null, err => err as Error)
    expect(e).toBeInstanceOf(PortHeldError)
    expect(e!.message).toContain('CynCo could not stop it')
    expect(calls.fallback).toBe(0)
  })
})

describe('portHolderReader and a server that could not be stopped', () => {
  const reader = (owner: PortOwner, stuck: { detail: string; why: string } | null) =>
    portHolderReader({ port: 8081, ownServerUp: () => false, isPortOccupied: async () => true, isHealthy: async () => true, portOwner: async () => owner, cannotStop: () => stuck })

  it('is a holder while it is the server on the port, whether it was named as an app or not', async () => {
    expect(await reader({ owner: 'foreign', detail: DETAIL }, { detail: DETAIL, why: WHY })()).toEqual({ key: `cannot-stop:${DETAIL}`, says: `${DETAIL}, which CynCo could not stop (${WHY})` })
    const app = 'dndai\'s model server (pid 29720 (llama-server.exe), started by bash.exe)'
    expect((await reader({ owner: 'app', detail: app }, { detail: app, why: WHY })())?.says).toContain('dndai\'s model server')
  })

  it('is not one for a different server on the port: the lazy path takes the port from that one', async () => {
    expect(await reader({ owner: 'foreign', detail: 'pid 5 (llama-server.exe), started by cmd.exe' }, { detail: DETAIL, why: WHY })()).toBeNull()
    expect(await reader({ owner: 'foreign', detail: DETAIL }, null)()).toBeNull()
  })

  it('what was read before the refusal is not trusted after it', async () => {
    let stuck: { detail: string; why: string } | null = null
    const read = portHolderReader({ port: 8081, ownServerUp: () => false, isPortOccupied: async () => true, isHealthy: async () => true, portOwner: async () => ({ owner: 'foreign', detail: DETAIL }), cannotStop: () => stuck, now: () => 0 })
    expect(await read()).toBeNull()
    stuck = { detail: DETAIL, why: WHY }
    expect(await read()).not.toBeNull()
  })
})
