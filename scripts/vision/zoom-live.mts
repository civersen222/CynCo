// Live check for F192, run by hand: bun scripts/vision/zoom-live.mts <photo> [question] — the picture whole vs in tiles, against the image box.
import { readFileSync } from 'node:fs'
import { LookClient } from '../../engine/vision/lookClient.js'
import { imageDimensions } from '../../engine/vision/imageSize.js'
import { cropTiles, tileGrid } from '../../engine/vision/tiles.js'
const path = process.argv[2]
const question = process.argv[3] ?? 'Which players have a ticked (checked) checkbox, which player names are in bold, and which rows show a mark in the INJ column? List each by name.'
const bytes = new Uint8Array(readFileSync(path))
const dims = imageDimensions(bytes)!
const client = new LookClient({ url: 'http://192.168.0.47:11434', model: 'qwen3-vl:8b-instruct' })
console.log(`picture ${dims.width}x${dims.height}`)
let t0 = Date.now()
const whole = await client.ask(bytes, 'image/jpeg', question)
console.log(`\n=== WHOLE (${Date.now() - t0} ms)\n` + (whole.ok ? whole.answer : whole.reason))
const grid = tileGrid(dims.width, dims.height)
t0 = Date.now()
const tiles = cropTiles(bytes, 'image/jpeg', grid)
console.log(`\n=== TILES: ${tiles.map(t => t.label).join(', ')} (crop ${Date.now() - t0} ms)`)
for (const t of tiles) {
  const t1 = Date.now()
  const r = await client.ask(t.bytes, 'image/jpeg', `${question}\n(This is the ${t.label} of a larger picture; answer for what this part shows.)`)
  console.log(`\n--- [${t.label}] ${imageDimensions(t.bytes)?.width}x${imageDimensions(t.bytes)?.height}, ${Date.now() - t1} ms\n` + (r.ok ? r.answer : r.reason))
}
