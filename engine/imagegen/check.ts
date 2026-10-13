/**
 * engine/imagegen/check.ts — the operator's live check of image generation.
 *
 *   bun engine/imagegen/check.ts                       config check + server probe
 *   bun engine/imagegen/check.ts --generate "<prompt>"  … then paint one picture
 *
 * Prints what `comfyConfig` and `probeComfy` say. With --generate it runs one
 * job through the real `ImageService` into a throwaway project, prints where
 * the picture landed and how long each stage took, and exits 0 or 1. The build
 * container has no ComfyUI, so this is how a setup is proved on the real PC.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UiImageEvent, UiSpec } from '../bridge/protocol.js'
import { createProject, projectDir } from '../projects/layout.js'
import { probeComfy } from './client.js'
import { comfyConfig } from './config.js'
import { ImageService } from './service.js'
import { pngPath, readSidecar } from './store.js'

async function main(argv: string[]): Promise<number> {
  const config = comfyConfig(process.env)
  if (!config.ok) { console.log(`config: ${config.reason}`); return 1 }
  const cfg = config.cfg
  console.log(`config: ${cfg.url} — ${cfg.width}x${cfg.height}, ${cfg.steps} steps, cfg ${cfg.cfg}, ${cfg.sampler}/${cfg.scheduler}, timeout ${cfg.timeoutMs / 1000} s`)
  console.log(`config: workflow ${cfg.workflow.source}${cfg.workflow.source === 'builtin' ? ' (SDXL)' : ` (sha256 ${cfg.workflow.sha256.slice(0, 12)})`}; checkpoint ${cfg.checkpoint ?? 'picked by the probe'}`)
  const probe = await probeComfy(cfg)
  if (!probe.ok) { console.log(`probe: ${probe.reason}`); return 1 }
  console.log(`probe: ComfyUI ${probe.version} — ${probe.device}, ${probe.vramGB ?? '?'} GB; checkpoint ${probe.checkpoint ?? 'set by the workflow'}${probe.picked ? ` (picked from ${probe.checkpointCount})` : ''}`)

  const at = argv.indexOf('--generate')
  if (at === -1) return 0
  const prompt = argv[at + 1]
  if (!prompt || !prompt.trim()) { console.log('--generate needs a prompt: --generate "a tall green alien, full body, plain light-grey background"'); return 1 }
  const home = mkdtempSync(join(tmpdir(), 'cynco-imagegen-check-'))
  const meta = createProject(home, { name: 'imagegen check' })
  const dir = projectDir(home, meta.slug)

  let resolveEnd: (e: UiImageEvent) => void = () => {}
  const ended = new Promise<UiImageEvent>(r => { resolveEnd = r })
  const service = new ImageService({
    emit: e => {
      console.log(`event: ui.image ${e.status}${e.reason ? ` — ${e.reason}` : ''}`)
      if (e.status !== 'running') resolveEnd(e)
    },
  })
  const spec: UiSpec = { root: 'img', elements: { img: { type: 'Image', props: { prompt, alt: 'imagegen check' } } } }
  const started = Date.now()
  const pics = service.annotate(spec, { project: { dir, slug: meta.slug, chatFile: 'check.jsonl' }, toolId: 'check', surfaceId: 'check', cutOff: false })
  console.log(pics.note ?? '(no note)')
  const state = spec.elements.img.image
  if (!state || state.status === 'off') { console.log(`not queued: ${state ? state.reason : 'no annotation'}`); return 1 }
  pics.start()
  const end = await ended
  await service.whenIdle()
  const sc = readSidecar(dir, state.key)
  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s; queue ${sc?.queueMs ?? '?'} ms, gen ${sc?.genMs ?? '?'} ms, exec ${sc?.execMs ?? '?'} ms`)
  if (end.status !== 'done') return 1
  console.log(`picture: ${pngPath(dir, state.key)} (${sc?.bytes ?? '?'} bytes, checkpoint ${sc?.checkpoint ?? '?'}, seed ${sc?.seed ?? '?'})`)
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    e => { console.log(`check failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1) },
  )
}
