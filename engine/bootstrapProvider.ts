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
import { cyncoHome } from './paths.js'
import { isUnattendedMission, uncertaintyTraceEnabled } from './missionEnv.js'
import { mkdirSync } from 'fs'
import { basename, join } from 'path'

/** Where llama-server may write slot KV snapshots for this model; created on first use. */
function slotCacheDirFor(modelPath: string): string {
  const dir = join(cyncoHome(), 'slot-cache', basename(modelPath))
  mkdirSync(dir, { recursive: true })
  return dir
}

// The unattended-mission predicate lives in ./missionEnv.ts (shared with S5
// rule authority); re-exported so existing importers keep working.
export { isUnattendedMission }

/**
 * F161 residual: what to do about the llama-server binary once `resolveBinary`
 * has looked. A resolved path is used. With none, an interactive engine
 * downloads it (as it always has); an unattended mission REFUSES with a named
 * error instead — nobody is there to approve a download (downloads are the
 * operator's call, pre-staged for unattended runs), and the Phase 4 live proof's
 * second launch reached GitHub and then sat out the dispatch's ten-minute wait.
 * Refuse, don't crash (F140). Pure: no disk, no network.
 */
export function binaryAction(opts: {
  binaryPath: string | null
  unattended: boolean
  binDir: string
  brainBinDir: string
}): { kind: 'use'; path: string } | { kind: 'download' } | { kind: 'refuse'; message: string } {
  if (opts.binaryPath) return { kind: 'use', path: opts.binaryPath }
  if (!opts.unattended) return { kind: 'download' }
  return {
    kind: 'refuse',
    message: `F161: no llama-server under ${opts.binDir} or ${opts.brainBinDir}; an unattended engine does not download — stage the binary or set LOCALCODE_LLAMA_SERVER`,
  }
}

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

      const cyncoDir = cyncoHome()
      const binDir = path.join(cyncoDir, 'bin')
      const modelsDir = path.join(cyncoDir, 'models')
      const adaptersDir = path.join(cyncoDir, 'adapters')

      // 1. Resolve llama-server binary. bin-brain (the locally patched build:
      // activation tap + toolcall logprobs) outranks the stock download — the
      // J-Space readout is dead without it, and it sat unselected for five
      // weeks while every launch silently served the unpatched binary.
      const { resolveBinary, downloadBinary } = await import('./llama/binaryManager.js')
      const brainBinDir = path.join(cyncoDir, 'bin-brain')
      const action = binaryAction({
        binaryPath: resolveBinary(config.llamaServer, binDir, brainBinDir),
        unattended: isUnattendedMission(),
        binDir,
        brainBinDir,
      })
      // A refusal throws into the FATAL catch below, which names it.
      if (action.kind === 'refuse') throw new Error(action.message)
      let binaryPath: string
      if (action.kind === 'use') {
        binaryPath = action.path
      } else {
        console.log('[llama-cpp] llama-server not found — downloading...')
        binaryPath = await downloadBinary(binDir, (msg) => console.log(msg))
      }
      console.log(`[llama-cpp] Binary: ${binaryPath}`)
      // By directory NAME, not by `startsWith(brainBinDir)`: an explicit
      // LOCALCODE_LLAMA_SERVER (F161 — a campaign under a temp home naming the
      // real home's brain build) is the same patched binary and gets the tap.
      const isBrainBuild = binaryPath.replace(/\\/g, '/').includes('/bin-brain/')
      if (isBrainBuild && !process.env.LLAMA_ACTIVATIONS_LAYERS) {
        // The tap layers ship with the brain build's default readout config
        // (jlens artifacts are exported for exactly these five layers). The
        // patched server without this env serves /props but no activations —
        // the "tap not configured" tier the dashboard warns about.
        process.env.LLAMA_ACTIVATIONS_LAYERS = '24,32,40,48,56'
        console.log('[llama-cpp] brain build selected — LLAMA_ACTIVATIONS_LAYERS defaulted to 24,32,40,48,56')
      }

      // 2. Resolve GGUF model
      const { resolveModel } = await import('./llama/modelResolver.js')
      const modelPath = resolveModel(config.model ?? 'unknown', modelsDir, config.modelPath, config.modelFile)
      console.log(`[llama-cpp] Model: ${modelPath}`)

      // 3. Start/connect to llama-server
      const { ProcessManager, DEFAULT_CTX_SIZE } = await import('./llama/processManager.js')
      const rt = config.runtime
      const processManager = new ProcessManager({
        binaryPath,
        modelPath,
        port: config.port,
        // DEFAULT_CTX_SIZE, not a literal: this `??` is the value that actually
        // reaches llama-server when no profile or env pins the window, so a
        // literal here silently overrides processManager's own default and
        // makes changing it there a no-op.
        ctxSize: config.contextLength ?? DEFAULT_CTX_SIZE,
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
        cacheTypeK: rt?.cacheTypeK,
        cacheTypeV: rt?.cacheTypeV,
        chatTemplateKwargs: rt?.chatTemplateKwargs,
        // Slot KV snapshots: one directory per model file under ~/.cynco/slot-cache.
        slotSavePath: slotCacheDirFor(modelPath),
      })
      // Wire eval tok/s from llama-server stderr → governance (deferred until loop is created)
      ;(globalThis as any).__llamaProcessManager = processManager

      // Wakefulness (slice 2): under LOCALCODE_LLAMA_LAZY the model is not
      // loaded here; the provider loads it before its first request, waiting
      // on a running one-shot (gpu-busy.json) rather than killing its server.
      // Default: today's eager start.
      const { lazySettings, createLazyEnsureReady, IdleUnloader } = await import('./llama/lazyLoad.js')
      const lazy = lazySettings()
      let ensureReady: ((signal?: AbortSignal) => Promise<void>) | undefined
      // The owner's local-LLM apps (docs/decisions/2026-11-11-local-llm-apps.md): a server of theirs on our port is
      // named, taken for CynCo's work, and started again when CynCo is done.
      const { lazyAppDeps, giveGpuBack } = await import('./apps/gpu.js')
      const lazyApps = lazyAppDeps(config.port)
      const sayApps = (m: string) => { console.log(`[apps] ${m}`); processManager.onWaiting?.(m) }
      // A card too full for our model because Ollama holds one of the owner's apps' models: Ollama is asked to
      // unload it, through its API, before the spawn is refused. Every engine, lazy or not, a one-shot's included.
      const { freeOllamaForCynco } = await import('./apps/ollama.js')
      processManager.relieveGpu = () => freeOllamaForCynco({ by: 'its own model', say: sayApps })
      // The eager start (a mission engine, a one-shot, the engine booted after a mission) clears its port; an app's
      // server there is taken by the same rule as on the lazy path, not killed blind (F219).
      processManager.takePortFromApp = async () => {
        if ((await lazyApps.portOwner()).owner !== 'app') return false
        await lazyApps.takeFromApp(sayApps)
        return true
      }
      if (lazy.lazy) {
        const { readGpuBusy } = await import('./daemon/gpuBusyFile.js')
        // An engine that died owing an app its server: give it back now, if the GPU is free.
        void giveGpuBack(sayApps)
        ensureReady = createLazyEnsureReady(processManager, {
          readBusy: () => readGpuBusy(),
          maxWaitMs: lazy.lazyWaitMs,
          portOwner: lazyApps.portOwner,
          takeFromApp: lazyApps.takeFromApp,
          onWaiting: (info) => {
            const mins = info.remainingMs === null ? '?' : String(Math.ceil(info.remainingMs / 60000))
            processManager.onWaiting?.(`${info.reason} — about ${mins} min left; the model loads when it ends`)
          },
        })
        console.log(`[llama-cpp] lazy: the model loads on the first request (LOCALCODE_LLAMA_LAZY)${lazy.idleUnloadMs ? `, unloads after ${Math.round(lazy.idleUnloadMs / 60000)} min idle` : ''}`)
      } else {
        await processManager.ensureRunning()
      }

      // 4. Create provider
      const { LlamaCppProvider } = await import('./llama/provider.js')
      const uncertaintyTrace = uncertaintyTraceEnabled()
      if (!uncertaintyTrace) console.log('[llama-cpp] uncertainty trace (per-token logprobs) off for this run — unattended; set LOCALCODE_ENTROPY_TRACE=1 to force it')
      provider = new LlamaCppProvider({
        primaryUrl: `http://127.0.0.1:${config.port}`,
        adapterUrl: config.adapterUrl,
        modelName: config.model ?? 'unknown',
        modelsDir,
        adaptersDir,
        processManager,
        ...(ensureReady ? { ensureReady } : {}),
        uncertaintyTrace,
      })

      // Wakefulness (slice 2b): while a one-shot owns the GPU, a lazy engine
      // answers on the secondary box's Ollama instead of waiting
      // (LOCALCODE_FALLBACK_URL / _MODEL, engine/llama/busyFallback.ts).
      const { fallbackSettings, BusyFallbackProvider, portHolderReader } = await import('./llama/busyFallback.js')
      const fb = fallbackSettings()
      if (lazy.lazy && fb.url) {
        const { createProvider } = await import('./providers/factory.js')
        const { readGpuBusy, estimateRemainingMs } = await import('./daemon/gpuBusyFile.js')
        const fallback = createProvider('ollama', fb.url)
        provider = new BusyFallbackProvider({
          primary: provider,
          fallback,
          fallbackModel: fb.model,
          fallbackLabel: fb.url.replace(/^https?:\/\//, ''),
          readBusy: () => readGpuBusy(),
          remainingMs: (b) => estimateRemainingMs(b),
          primaryWarm: () => processManager.modelState() === 'warm',
          // Behind another engine's server (a dispatched mission, a second engine) there is no busy file (F213).
          readPortHolder: portHolderReader({
            port: config.port,
            ownServerUp: () => processManager.isRunning(),
            isPortOccupied: () => processManager.isPortOccupied(),
            isHealthy: () => processManager.portAnswersHealth(),
            portOwner: lazyApps.portOwner,
            // A server the lazy path could not stop (it runs as administrator): the fallback answers behind it too (F223).
            cannotStop: () => processManager.cannotStop(),
          }),
          fallbackHealthy: () => fallback.healthCheck(),
          notify: (m) => processManager.onWaiting?.(m),
          log: (line) => console.log(line),
        })
        console.log(`[llama-cpp] busy fallback: ${fb.model} at ${fb.url} answers while a one-shot or another engine's server owns the GPU (LOCALCODE_FALLBACK_URL)`)
      } else if (fb.url) {
        console.log('[llama-cpp] LOCALCODE_FALLBACK_URL is set but the engine is not lazy — the fallback only serves a lazy engine; ignored')
      }

      if (lazy.idleUnloadMs > 0) {
        const { activity } = await import('./power/activity.js')
        new IdleUnloader({
          registry: activity,
          isRunning: () => processManager.isRunning(),
          // CynCo is done with the GPU: an app whose server was stopped for it gets that server back.
          unload: async () => { await processManager.saveSlot(); await processManager.stop(); await giveGpuBack(sayApps) },
          idleMs: lazy.idleUnloadMs,
          log: (line) => console.log(line),
        }).start()
      }

      // Must be the same expression as ctxSize above — the loop's compaction
      // trigger is a fraction of this number, so a mismatch would compact at a
      // quarter of the window the server actually has.
      contextLength = config.contextLength ?? DEFAULT_CTX_SIZE
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
