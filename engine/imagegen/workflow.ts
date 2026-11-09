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
/** generate = today's text-to-image; vary = the owner's photo varied toward an idea; edit = the photo changed as instructed (F193); outline = a tracing sheet to paint from, drawn by the edit recipe with a fixed instruction (2026-11-09). */
export type WorkflowKind = 'generate' | 'vary' | 'outline' | 'edit'
/** The kinds that start from a project photo. */
export type TransformKind = Exclude<WorkflowKind, 'generate'>

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
 * outline (image box §4, redone 2026-11-09): a tracing sheet to paint from. The first
 * version ran a line-art preprocessor (`comfyui_controlnet_aux`) whose raw output was
 * white lines on black with every blade of grass as noise — nothing the owner would
 * trace. The edit model draws exactly what a painter wants (check 5: black ink
 * contours, perspective guides, a marked vanishing point), so an outline is the edit
 * recipe with this instruction fixed in front of whatever the model adds (`outlinePrompt`).
 * Owner's words: "this is my way to bridge my poor drawing ability".
 */
export const OUTLINE_INSTRUCTION =
  'Turn this photo into a clean tracing sheet for painting: black ink contour lines on a pure white background, no shading, no colour, no hatching, no grey. ' +
  'Keep every major shape and edge exactly where it is: horizon, buildings, trees, paths, people, animals, furniture, clouds. ' +
  'Simplify textures to their outlines: grass, foliage, water, gravel and fabric become a few clean lines, never texture.'

/** The outline's full prompt: the fixed instruction, then the model's extra guides ("draw the horizon line…") when it gave any. */
export function outlinePrompt(extras: string): string {
  const more = extras.trim()
  return more ? `${OUTLINE_INSTRUCTION} Also: ${more}` : OUTLINE_INSTRUCTION
}

// `BUILTIN_OUTLINE` itself is defined after `BUILTIN_EDIT` below: the same graph under its own version, so an operator may override one without the other.

/**
 * edit (F193): the photo changed as the instruction says — add, remove, replace,
 * restyle something — on Qwen-Image-Edit-2509, the official ComfyUI template's
 * graph with the GGUF loader in place of UNETLoader so the 20B model fits the
 * 16 GB box (Q4_K_S, 12.2 GB) and the 4-step Lightning LoRA so an edit takes
 * seconds, not minutes. Sampling is the LoRA's (`EDIT_SAMPLING`: 4 steps, cfg 1,
 * euler/simple, denoise 1) and the negative prompt is empty, whatever the generate
 * configuration says; `FluxKontextImageScale` sizes the output near 1 MP at the
 * photo's aspect. A vary keeps the composition and repaints surfaces; this is the
 * transform for "add a pergola". Files (ComfyUI/models/…): unet/ the GGUF,
 * text_encoders/qwen_2.5_vl_7b_fp8_scaled, vae/qwen_image_vae, loras/ the LoRA.
 * Needs the ComfyUI-GGUF node pack (UnetLoaderGGUF).
 */
export const EDIT_SAMPLING = { steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple', negative: '' } as const
export const BUILTIN_EDIT: ComfyGraph = {
  '37': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'Qwen-Image-Edit-2509-Q4_K_S.gguf' } },
  '89': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['37', 0], lora_name: 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors', strength_model: 1 } },
  '66': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['89', 0], shift: 3 } },
  '75': { class_type: 'CFGNorm', inputs: { model: ['66', 0], strength: 1 } },
  '38': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
  '39': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  '10': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  '117': { class_type: 'FluxKontextImageScale', inputs: { image: ['10', 0] } },
  '88': { class_type: 'VAEEncode', inputs: { pixels: ['117', 0], vae: ['39', 0] } },
  '111': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['38', 0], vae: ['39', 0], image1: ['117', 0], prompt: '{{prompt}}' } },
  '110': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['38', 0], vae: ['39', 0], image1: ['117', 0], prompt: '' } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}', steps: EDIT_SAMPLING.steps, cfg: EDIT_SAMPLING.cfg, sampler_name: EDIT_SAMPLING.sampler, scheduler: EDIT_SAMPLING.scheduler, denoise: 1,
      model: ['75', 0], positive: ['111', 0], negative: ['110', 0], latent_image: ['88', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{filename_prefix}}', images: ['8', 0] } },
}
export const BUILTIN_EDIT_SHA = 'builtin-edit-1'

/** The outline's graph: the edit graph, node for node (`outlinePrompt` supplies the prompt). */
export const BUILTIN_OUTLINE: ComfyGraph = { ...BUILTIN_EDIT }
export const BUILTIN_OUTLINE_SHA = 'builtin-outline-2'

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
  if (!used.has('prompt')) return { ok: false, reason: `${path} has no "{{prompt}}" placeholder, so nothing would describe the picture` }
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
