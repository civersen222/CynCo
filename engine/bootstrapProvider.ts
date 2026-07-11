/**
 * Shared model-provider bootstrap.
 *
 * This is the single source of truth for how the engine selects a provider:
 * the llama-cpp/llama-server path when `config.provider === 'llama-cpp'` (the
 * default), or the Ollama path otherwise. llama-cpp setup failure is FATAL —
 * it throws instead of silently falling back to Ollama, because a degraded
 * fallback runs with the wrong model/context and produces broken sessions
 * (timeouts with no visible cause). It mutates `config.contextLength` to the
 * resolved budget and returns the provider plus that budget.
 *
 * Both `engine/main.ts` and `benchmark/true/run.ts` call this so the benchmark
 * drives the identical backend the user runs in production.
 */
import type { Provider } from './provider.js'
import type { LocalCodeConfig } from './config.js'
import { resolveCapabilities } from './ollama/probe.js'

export async function bootstrapProvider(
  config: LocalCodeConfig,
): Promise<{ provider: Provider; contextLength: number }> {
  const modelCaps = config.model ? resolveCapabilities(config.model) : null

  async function createOllamaFallback(): Promise<{ provider: Provider; contextLength: number }> {
    const contextLengthExplicit = process.env.LOCALCODE_CONTEXT_LENGTH
      ? parseInt(process.env.LOCALCODE_CONTEXT_LENGTH, 10)
      : undefined

    let ctx: number
    if (contextLengthExplicit && !Number.isNaN(contextLengthExplicit)) {
      ctx = contextLengthExplicit
      console.log(`[context] Using explicit LOCALCODE_CONTEXT_LENGTH=${ctx}`)
    } else {
      let ollamaNumCtx: number | null = null
      try {
        const resp = await fetch(`${config.baseUrl}/api/ps`)
        const data = await resp.json() as any
        const running = data.models?.find((m: any) => m.name?.startsWith(config.model?.split(':')[0] ?? ''))
        if (running?.details?.num_ctx) {
          ollamaNumCtx = running.details.num_ctx
        }
      } catch {}

      if (ollamaNumCtx) {
        ctx = ollamaNumCtx
        console.log(`[context] Detected Ollama num_ctx=${ctx} from /api/ps`)
      } else {
        const OLLAMA_DEFAULT_CTX = 32768
        const modelMax = modelCaps?.contextLength ?? OLLAMA_DEFAULT_CTX
        ctx = Math.min(modelMax, OLLAMA_DEFAULT_CTX)
        console.log(`[context] Using Ollama default ${ctx} (model theoretical max: ${modelMax})`)
      }
    }

    const { createProvider } = await import('./providers/factory.js')
    return { provider: createProvider('ollama', config.baseUrl, config.apiKey, ctx), contextLength: ctx }
  }

  let provider: Provider
  let contextLength: number

  if (config.provider === 'llama-cpp') {
    // ─── llama-cpp provider path ─────────────────────────────
    try {
      const os = require('os')
      const path = require('path')

      const cyncoDir = path.join(os.homedir(), '.cynco')
      const binDir = path.join(cyncoDir, 'bin')
      const modelsDir = path.join(cyncoDir, 'models')
      const adaptersDir = path.join(cyncoDir, 'adapters')

      // 1. Resolve llama-server binary
      const { resolveBinary, downloadBinary } = await import('./llama/binaryManager.js')
      let binaryPath = resolveBinary(config.llamaServer, binDir)
      if (!binaryPath) {
        console.log('[llama-cpp] llama-server not found — downloading...')
        binaryPath = await downloadBinary(binDir, (msg) => console.log(msg))
      }
      console.log(`[llama-cpp] Binary: ${binaryPath}`)

      // 2. Resolve GGUF model
      const { resolveModel } = await import('./llama/modelResolver.js')
      const modelPath = resolveModel(config.model ?? 'unknown', modelsDir, config.modelPath, config.modelFile)
      console.log(`[llama-cpp] Model: ${modelPath}`)

      // 3. Start/connect to llama-server
      const { ProcessManager } = await import('./llama/processManager.js')
      const rt = config.runtime
      const processManager = new ProcessManager({
        binaryPath,
        modelPath,
        port: config.port,
        ctxSize: config.contextLength ?? 32768,
        batchSize: rt?.batchSize ?? config.batchSize,
        gpuLayers: rt?.gpuLayers ?? config.gpuLayers,
        flashAttn: rt?.flashAttn ?? config.flashAttn,
        threads: config.threads,
        specType: process.env.LOCALCODE_SPEC_TYPE || rt?.specType || undefined,
        specDraftN: process.env.LOCALCODE_SPEC_DRAFT_N
          ? parseInt(process.env.LOCALCODE_SPEC_DRAFT_N, 10)
          : rt?.specDraftN,
        cacheRam: rt?.cacheRam,
        reasoningBudget: rt?.reasoningBudget,
        ctxCheckpoints: rt?.ctxCheckpoints,
        checkpointMinStep: rt?.checkpointMinStep,
        ubatchSize: rt?.ubatchSize,
        chatTemplateFile: rt?.chatTemplateFile,
      })
      // Wire eval tok/s from llama-server stderr → governance (deferred until loop is created)
      ;(globalThis as any).__llamaProcessManager = processManager
      await processManager.ensureRunning()

      // 4. Create provider
      const { LlamaCppProvider } = await import('./llama/provider.js')
      provider = new LlamaCppProvider({
        primaryUrl: `http://127.0.0.1:${config.port}`,
        adapterUrl: config.adapterUrl,
        modelName: config.model ?? 'unknown',
        modelsDir,
        adaptersDir,
        processManager,
      })

      contextLength = config.contextLength ?? 32768
      config.contextLength = contextLength

      // Cleanup on exit — must run before the later SIGINT/SIGTERM handlers that call process.exit()
      const cleanup = async () => { await processManager.stop() }
      process.on('beforeExit', cleanup)

    } catch (err) {
      // No silent fallback: degrading to Ollama here runs the wrong model with
      // the wrong context budget and fails later with opaque timeouts. Fail
      // loud at startup so the launcher/user sees the real cause immediately.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[llama-cpp] FATAL: setup failed: ${msg}`)
      console.error('[llama-cpp] Fix the error above, or set provider: ollama explicitly if that is what you want.')
      throw err
    }

  } else {
    // ─── Ollama provider path ──────────────────────────────────
    const fallback = await createOllamaFallback()
    provider = fallback.provider
    contextLength = fallback.contextLength
    config.contextLength = contextLength
  }

  return { provider, contextLength }
}
