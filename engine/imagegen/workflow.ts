/**
 * engine/imagegen/workflow.ts — the ComfyUI graph a picture is painted with.
 *
 * A workflow is ComfyUI's API format: `{ "<node id>": { class_type, inputs } }`.
 * Values the engine chooses ride in it as `{{name}}` placeholders. The built-in
 * graph is the plain SDXL chain (checkpoint → two text encodes → KSampler →
 * VAE decode → SaveImage); an operator who wants another model family points
 * LOCALCODE_COMFYUI_WORKFLOW at an exported file with the same placeholders.
 *
 * `fillWorkflow` walks the parsed object, never JSON text: the prompt is a JS
 * string dropped into a value, so a quote, a backslash, a newline or a literal
 * `{{seed}}` inside it stays inert.
 */

export type ComfyNode = { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }
export type ComfyGraph = Record<string, ComfyNode>

/** The placeholders a text-to-image (generate) workflow may use. */
export const GENERATE_PLACEHOLDERS = ['prompt', 'negative', 'seed', 'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler', 'checkpoint', 'filename_prefix'] as const
/** Every placeholder any workflow may use: the generate set plus the transforms' `image` (the uploaded input's ComfyUI name) and `denoise` (image box §4). */
export const PLACEHOLDERS = [...GENERATE_PLACEHOLDERS, 'image', 'denoise'] as const
export type Placeholder = typeof PLACEHOLDERS[number]
/** generate = today's text-to-image; vary = the owner's photo varied toward an idea; outline = clean line art from a photo. */
export type WorkflowKind = 'generate' | 'vary' | 'outline'

/** Placeholders that become numbers: only as a whole string value, never inside a longer one. */
const NUMERIC: ReadonlySet<string> = new Set(['seed', 'width', 'height', 'steps', 'cfg', 'denoise'])
const KNOWN: ReadonlySet<string> = new Set(PLACEHOLDERS)
const TOKEN = /\{\{([^{}]*)\}\}/g
const WHOLE = /^\{\{([^{}]*)\}\}$/

export type FillValues = {
  prompt: string; negative: string; seed: number; width: number; height: number; steps: number; cfg: number
  sampler: string; scheduler: string; checkpoint: string; filename_prefix: string
  /** Transforms only: the uploaded input's ComfyUI name and the vary denoise. Absent, the tokens stay in place. */
  image?: string; denoise?: number
}

/** The plain SDXL chain, the same nodes the operator's old batch script queued. */
export const BUILTIN_WORKFLOW: ComfyGraph = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: '{{sampler}}', scheduler: '{{scheduler}}', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{filename_prefix}}', images: ['8', 0] } },
}

/** The key the built-in graph contributes to an image key in place of a file's sha256. */
export const BUILTIN_WORKFLOW_SHA = 'builtin-1'

/**
 * vary (image box §4): the owner's photo, scaled to fit 1024 on its long side,
 * encoded, re-sampled toward the idea in {{prompt}} at {{denoise}} (0.55 by
 * default: the thing stays itself, the idea shows), decoded, saved.
 */
export const BUILTIN_VARY: ComfyGraph = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
  '10': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  '11': { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: '{{width}}', height: '{{height}}', crop: 'disabled' } },
  '12': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['4', 2] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: '{{sampler}}', scheduler: '{{scheduler}}', denoise: '{{denoise}}',
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['12', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{filename_prefix}}', images: ['8', 0] } },
}
export const BUILTIN_VARY_SHA = 'builtin-vary-1'

/**
 * outline (image box §4): clean black-on-white lines to paint from. The
 * preprocessor's output is the deliverable — no diffusion, so no model-family
 * mismatch (SDXL has no native lineart ControlNet). Needs comfyui_controlnet_aux.
 */
export const BUILTIN_OUTLINE: ComfyGraph = {
  '10': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  '20': { class_type: 'LineArtPreprocessor', inputs: { image: ['10', 0], coarse: 'disable', resolution: 1024 } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{filename_prefix}}', images: ['20', 0] } },
}
export const BUILTIN_OUTLINE_SHA = 'builtin-outline-1'

/**
 * The size a transform paints at: the photo's aspect, about the configured area
 * (SDXL's 1 MP), on multiples of 64. Check 4 (2026-11-09) squashed a portrait
 * yard photo into the configured 1024x1024 square — `ImageScale` with crop
 * disabled stretches. Null when the photo's size is unknown; the caller keeps
 * the configured size then.
 */
export function fitToArea(dims: { width: number; height: number } | null, area: number, step = 64): { width: number; height: number } | null {
  if (!dims || !(dims.width > 0) || !(dims.height > 0) || !(area > 0)) return null
  const ratio = dims.width / dims.height
  const snap = (v: number) => Math.max(step, Math.round(v / step) * step)
  return { width: snap(Math.sqrt(area * ratio)), height: snap(Math.sqrt(area / ratio)) }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every string value under a node's inputs, depth-first; keys are never visited. */
function* stringsIn(v: unknown, depth = 0): Generator<string> {
  if (depth > 32) return
  if (typeof v === 'string') { yield v; return }
  if (Array.isArray(v)) { for (const x of v) yield* stringsIn(x, depth + 1); return }
  if (isObj(v)) for (const k of Object.keys(v)) yield* stringsIn(v[k], depth + 1)
}

/** The placeholder names a graph's inputs use. */
export function placeholdersIn(graph: ComfyGraph): Set<string> {
  const out = new Set<string>()
  for (const node of Object.values(graph)) for (const s of stringsIn(node.inputs)) for (const m of s.matchAll(TOKEN)) out.add(m[1])
  return out
}

/** Each distinct `class_type` in the graph, sorted: what the server probe asks /object_info about. */
export function workflowClasses(graph: ComfyGraph): string[] {
  return [...new Set(Object.values(graph).map(n => n.class_type))].sort()
}

/**
 * An operator's workflow file as a graph, or the reason it cannot be used.
 * The reason starts with `path` and is the part after
 * "LOCALCODE_COMFYUI_WORKFLOW: " in the config refusal.
 */
export function parseWorkflow(text: string, path: string, kind: WorkflowKind = 'generate'): { ok: true; graph: ComfyGraph } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    console.log(`[imagegen] workflow ${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, reason: `${path} is not an API-format workflow (not valid JSON: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)})` }
  }
  if (!isObj(raw)) return { ok: false, reason: `${path} is not an API-format workflow (the top level is not an object)` }
  if (Array.isArray(raw.nodes) && raw.links !== undefined) return { ok: false, reason: `${path} is a ComfyUI UI workflow; export it with "Export (API)"` }
  const ids = Object.keys(raw)
  if (ids.length === 0) return { ok: false, reason: `${path} is not an API-format workflow (it has no nodes)` }
  for (const id of ids) {
    const node = raw[id]
    if (!isObj(node) || typeof node.class_type !== 'string' || !node.class_type || !isObj(node.inputs)) {
      return { ok: false, reason: `${path} is not an API-format workflow (node "${id.slice(0, 40)}" is not {class_type: string, inputs: object})` }
    }
  }
  // JSON.parse makes every key an own data property ("__proto__" included),
  // and nothing below assigns through a key, so the parsed object is the graph.
  const graph = raw as ComfyGraph
  for (const node of Object.values(graph)) {
    for (const s of stringsIn(node.inputs)) {
      for (const m of s.matchAll(TOKEN)) {
        const name = m[1]
        if (!KNOWN.has(name)) return { ok: false, reason: `${path} uses "{{${name.slice(0, 40)}}}", which is not one of: ${PLACEHOLDERS.join(', ')}` }
        if (NUMERIC.has(name) && s !== m[0]) return { ok: false, reason: `${path}: "{{${name}}}" must be a whole string value, not part of a longer one` }
      }
    }
  }
  const used = placeholdersIn(graph)
  if (kind !== 'outline' && !used.has('prompt')) return { ok: false, reason: `${path} has no "{{prompt}}" placeholder, so nothing would describe the picture` }
  if (kind !== 'generate' && !used.has('image')) return { ok: false, reason: `${path} has no "{{image}}" placeholder, so the ${kind} would never see the photo` }
  if (!Object.values(graph).some(n => n.class_type === 'SaveImage')) return { ok: false, reason: `${path} has no SaveImage node; the engine downloads saved images only` }
  return { ok: true, graph }
}

/** `v` with its placeholders filled. Containers are filled in place: callers pass a clone. */
function fillValue(v: unknown, values: FillValues, depth: number): unknown {
  if (depth > 32) return v
  if (typeof v === 'string') {
    const whole = WHOLE.exec(v)
    if (whole && KNOWN.has(whole[1])) { const val = values[whole[1] as Placeholder]; return val === undefined ? v : val }
    // A function replacement inserts the value literally ("$&" stays "$&") and
    // in one pass, so a "{{seed}}" inside the prompt is never expanded again.
    return v.replace(TOKEN, (token, name: string) => (KNOWN.has(name) && !NUMERIC.has(name) && values[name as Placeholder] !== undefined ? String(values[name as Placeholder]) : token))
  }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = fillValue(v[i], values, depth + 1); return v }
  // Assigning to an own data property, even one named "__proto__", sets that
  // property; a fresh object would have turned such a key into a prototype.
  if (isObj(v)) { for (const k of Object.keys(v)) v[k] = fillValue(v[k], values, depth + 1); return v }
  return v
}

/**
 * The graph with every placeholder in its inputs replaced, as a fresh object
 * (the input is never mutated). A whole-value numeric placeholder becomes a
 * number; a string placeholder becomes the string, in place when it sits
 * inside a longer value. Keys, `class_type` and `_meta` are left alone.
 */
export function fillWorkflow(graph: ComfyGraph, values: FillValues): ComfyGraph {
  const out = structuredClone(graph)
  for (const node of Object.values(out)) fillValue(node.inputs, values, 0)
  return out
}
