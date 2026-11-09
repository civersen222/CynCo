// Live check for F193, run by hand: bun scripts/imagegen/edit-live.mts <photo> "<instruction>" [out.png]
// Runs the built-in edit graph (Qwen-Image-Edit-2509 GGUF + Lightning) against the image box
// through the engine's own client, with no model in the loop: proves the files and the graph.
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ComfyClient } from '../../engine/imagegen/client.js'
import { BUILTIN_EDIT, fillWorkflow } from '../../engine/imagegen/workflow.js'
import type { ImageRef } from '../../engine/imagegen/store.js'

const [photo, instruction, out = 'edit-live.png'] = process.argv.slice(2)
if (!photo || !instruction) { console.error('usage: bun scripts/imagegen/edit-live.mts <photo> "<instruction>" [out.png]'); process.exit(2) }
const client = new ComfyClient(process.env.LOCALCODE_COMFYUI_URL ?? 'http://192.168.0.47:8188')
const key = randomUUID().replace(/-/g, '')
const t0 = Date.now()
const uploaded = await client.uploadImage(new Uint8Array(readFileSync(photo)), `cynco-live-${key}.jpg`)
console.log(`uploaded as ${uploaded} (${Date.now() - t0} ms)`)
const graph = fillWorkflow(BUILTIN_EDIT, {
  prompt: instruction, negative: '', seed: 42, width: 1024, height: 1024, steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple',
  checkpoint: '', filename_prefix: `cynco-live/${key}`, image: uploaded,
})
const id = await client.submit(graph, randomUUID())
console.log(`submitted ${id}`)
let entry: Awaited<ReturnType<ComfyClient['history']>> = null
while (!entry) { await new Promise(r => setTimeout(r, 2000)); entry = await client.history(id); if (Date.now() - t0 > 600_000) throw new Error('timed out') }
console.log(`done: ${JSON.stringify(entry.status).slice(0, 200)} (${Date.now() - t0} ms)`)
const refs = Object.values(entry.outputs).flatMap((o: any) => Array.isArray(o?.images) ? o.images : []) as ImageRef[]
if (!refs.length) { console.log('no images in outputs:', JSON.stringify(entry.outputs).slice(0, 500)); process.exit(1) }
const bytes = await client.download(refs[0], 50 * 1024 * 1024)
writeFileSync(out, bytes)
await client.free()
console.log(`saved ${out} (${bytes.length} bytes) — total ${((Date.now() - t0) / 1000).toFixed(1)} s`)
