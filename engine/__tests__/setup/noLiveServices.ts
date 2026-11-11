/**
 * The suite does not reach the services that run on this machine.
 *
 * F206. Engine defaults point at well-known loopback ports: embeddings at
 * `localhost:11434` (`embedClient.ts`), the model at `127.0.0.1:8081`, the
 * engine itself on 9160/9161. A test that drives the real `ConversationLoop`
 * probes the embedding endpoint on every user message, and on the owner's PC
 * something answers there: measured 2026-11-11, one full run left
 * `nomic-embed-text` loaded in the owner's Ollama (`/api/ps`) and asked it to
 * pull `jina-code-embeddings-0.5b`. A CI runner has nothing on those ports, so
 * the same tests were exercising a different path on each machine.
 *
 * `fetch` to one of those ports fails here the way a closed port does
 * (`TypeError: fetch failed`, `cause.code === 'ECONNREFUSED'`), at once and
 * without touching the network. A test that stubs `fetch` replaces this
 * wrapper and is not affected; a test server asks for port 0 and never lands
 * on one of these (`guards/testPortsDoNotCollide.test.ts`). The switches that
 * ask for live-service tests (`LOCALCODE_INTEGRATION_TESTS`,
 * `CYNCO_INTEGRATION`) turn it off. Only `fetch` is covered: it is how the
 * engine reaches every one of these services.
 */
export const LIVE_SERVICE_PORTS: Readonly<Record<string, string>> = {
  '8081': 'the model server (llama-server)',
  '9160': 'the engine bridge',
  '9161': 'the dashboard',
  '9163': 'the jlens sidecar',
  '9165': 'the embedding service',
  '11434': 'Ollama',
  '8188': 'ComfyUI',
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/** The service a URL would reach on this machine, or null when it is not one of them. */
export function liveServiceOf(input: unknown): string | null {
  let url: URL
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? '')
    url = new URL(raw)
  } catch {
    return null
  }
  if (!LOOPBACK.has(url.hostname)) return null
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return LIVE_SERVICE_PORTS[port] ?? null
}

export function guardFetch(real: typeof fetch): typeof fetch {
  const guarded = (async (input: unknown, init?: unknown) => {
    const service = liveServiceOf(input)
    if (service) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`connect ECONNREFUSED: the test suite does not reach ${service} on this machine (F206, engine/__tests__/setup/noLiveServices.ts)`), { code: 'ECONNREFUSED' }),
      })
    }
    return (real as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
  }) as typeof fetch
  return guarded
}

if (process.env.LOCALCODE_INTEGRATION_TESTS !== '1' && !process.env.CYNCO_INTEGRATION) {
  globalThis.fetch = guardFetch(globalThis.fetch)
}
