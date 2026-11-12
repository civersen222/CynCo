/**
 * engine/power/reporter/sample.ts — one sample of this box, from sources that may each fail.
 *
 * A source that throws or does not answer in time leaves its field `null` and
 * the sample still goes out: a box that cannot read its GPU is still awake,
 * and saying so is the point. Nothing is reported as a made-up 0.
 */
import { modelRows, type ModelPortFacts } from './engineFacts.js'
import type { EngineRow, GpuRow, HolderRow, ModelRow, Sample, ServiceRow } from './types.js'

export type Sources = {
  idleS: () => Promise<number | null>
  gpus: () => Promise<GpuRow[] | null>
  engine: () => Promise<EngineRow | null>
  modelPort: () => Promise<ModelPortFacts | null>
  holder: (modelUp: boolean) => Promise<HolderRow | null>
  services: (engine: EngineRow | null) => Promise<ServiceRow[]>
  ollama: () => Promise<ModelRow[]>
}

export type GatherOpts = { modelPort: number; timeoutMs?: number; log?: (line: string) => void }

/** The answer of `fn`, or `fallback` when it throws or takes longer than `timeoutMs`. */
async function within<T>(name: string, fn: () => Promise<T>, fallback: T, timeoutMs: number, log: (line: string) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs) }),
    ])
  } catch (err) {
    log(`[watch] ${name} could not be read: ${err instanceof Error ? err.message : String(err)}`)
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function gatherSample(sources: Sources, now: Date, opts: GatherOpts): Promise<Sample> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const log = opts.log ?? console.log
  const [idleS, gpus, engine, model, ollama] = await Promise.all([
    within('the idle time', sources.idleS, null, timeoutMs, log),
    within('the GPUs', sources.gpus, null, timeoutMs, log),
    within('the engine', sources.engine, null, timeoutMs, log),
    within('the model port', sources.modelPort, null, timeoutMs, log),
    within('Ollama', sources.ollama, [] as ModelRow[], timeoutMs, log),
  ])
  const holder = await within('who holds the GPU', () => sources.holder(model?.up === true), null, timeoutMs, log)
  const services = await within('the services', () => sources.services(engine), [] as ServiceRow[], timeoutMs, log)
  return {
    t: 'sample',
    at: now.toISOString(),
    idleS: idleS === null ? null : Math.round(idleS),
    gpus,
    models: modelRows(opts.modelPort, model, holder, engine, ollama),
    holder,
    engine,
    services,
  }
}

/**
 * The part of a sample whose change is worth telling at once: which services answer and are
 * wanted, which models are loaded and in use, who holds the GPU, whether the engine is up and
 * its model state. Temperatures, memory and idle seconds move all the time and wait for the beat.
 */
export function fingerprint(s: Sample): string {
  return JSON.stringify({
    services: s.services.map(v => [v.name, v.up, v.wanted]),
    models: (s.models ?? []).map(m => [m.server, m.name, m.busy]),
    holder: s.holder?.unit ?? null,
    engine: s.engine ? [s.engine.up, s.engine.modelState] : null,
  })
}
