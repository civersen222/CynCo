import { describe, it, expect } from 'bun:test'
import { BUILTIN_EDIT, BUILTIN_EDIT_SHA, EDIT_SAMPLING, BUILTIN_OUTLINE, BUILTIN_VARY, BUILTIN_WORKFLOW, fillWorkflow, parseWorkflow, placeholdersIn, workflowClasses, GENERATE_PLACEHOLDERS, PLACEHOLDERS, type ComfyGraph, type FillValues, fitToArea } from '../../imagegen/workflow.js'

const VALUES: FillValues = {
  prompt: 'a tall green alien', negative: 'blurry', seed: 123456789012, width: 1024, height: 768, steps: 40, cfg: 6,
  sampler: 'dpmpp_2m', scheduler: 'karras', checkpoint: 'juggernautXL_v9.safetensors', filename_prefix: 'cynco/0123456789abcdef0123456789abcdef',
}

describe('the built-in graph', () => {
  it('passes parseWorkflow and uses every placeholder', () => {
    const r = parseWorkflow(JSON.stringify(BUILTIN_WORKFLOW), 'builtin')
    expect(r.ok).toBe(true)
    expect([...placeholdersIn(BUILTIN_WORKFLOW)].sort()).toEqual([...GENERATE_PLACEHOLDERS].sort())
    expect([...PLACEHOLDERS].sort()).toEqual([...GENERATE_PLACEHOLDERS, 'image', 'denoise'].sort())
    expect(workflowClasses(BUILTIN_WORKFLOW)).toEqual(['CLIPTextEncode', 'CheckpointLoaderSimple', 'EmptyLatentImage', 'KSampler', 'SaveImage', 'VAEDecode'])
  })
})

describe('fillWorkflow', () => {
  it('whole tokens become typed values', () => {
    const g = fillWorkflow(BUILTIN_WORKFLOW, VALUES)
    expect(g['3'].inputs).toMatchObject({ seed: 123456789012, steps: 40, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0] })
    expect(g['5'].inputs).toEqual({ width: 1024, height: 768, batch_size: 1 })
    expect(g['4'].inputs.ckpt_name).toBe('juggernautXL_v9.safetensors')
    expect(g['6'].inputs.text).toBe('a tall green alien')
    expect(g['7'].inputs.text).toBe('blurry')
    expect(g['9'].inputs.filename_prefix).toBe('cynco/0123456789abcdef0123456789abcdef')
    expect(JSON.stringify(g)).not.toContain('{{')
  })

  it('an embedded string token is interpolated, and a hostile prompt survives exactly', () => {
    const graph: ComfyGraph = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, {{prompt}}, {{sampler}}', clip: ['4', 1] } } }
    const hostile = 'a "quoted" \\ back\nslash, $& and $1, a literal {{seed}} and {{prompt}}'
    const g = fillWorkflow(graph, { ...VALUES, prompt: hostile })
    expect(g['6'].inputs.text).toBe(`masterpiece, ${hostile}, dpmpp_2m`)
    // The JSON a server would receive round-trips to the same prompt.
    expect(JSON.parse(JSON.stringify(g))['6'].inputs.text).toBe(`masterpiece, ${hostile}, dpmpp_2m`)
  })

  it('keys are never substituted and the input is not mutated', () => {
    const graph: ComfyGraph = { '1': { class_type: 'Custom', inputs: { '{{prompt}}': '{{prompt}}', nested: { list: ['{{negative}}', { deep: '{{seed}}' }] } } } }
    const before = JSON.stringify(graph)
    const g = fillWorkflow(graph, VALUES)
    expect(JSON.stringify(graph)).toBe(before)
    expect(g['1'].inputs).toEqual({ '{{prompt}}': 'a tall green alien', nested: { list: ['blurry', { deep: 123456789012 }] } })
    expect(fillWorkflow(BUILTIN_WORKFLOW, VALUES)).not.toBe(BUILTIN_WORKFLOW)
    expect(BUILTIN_WORKFLOW['3'].inputs.seed).toBe('{{seed}}')
  })

  it('an input keyed "__proto__" stays an own value and never becomes a prototype', () => {
    const graph = JSON.parse('{"1":{"class_type":"Custom","inputs":{"__proto__":{"x":"{{prompt}}"},"text":"{{prompt}}"}}}') as ComfyGraph
    const g = fillWorkflow(graph, VALUES)
    expect(Object.getPrototypeOf(g['1'].inputs)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(g))['1'].inputs.text).toBe('a tall green alien')
  })
})

describe('parseWorkflow', () => {
  it('refuses a top level that is not an object, and an empty graph', () => {
    expect(parseWorkflow('[]', 'p')).toEqual({ ok: false, reason: 'p is not an API-format workflow (the top level is not an object)' })
    expect(parseWorkflow('{}', 'p')).toEqual({ ok: false, reason: 'p is not an API-format workflow (it has no nodes)' })
  })
})

// The image box (docs/decisions/2026-11-08-image-box-design.md §4): two transforms of the owner's own photo.
describe('fitToArea (a transform paints at the photo\'s aspect, not the configured square — check 4, 2026-11-09)', () => {
  it('keeps the aspect at about the configured area, on multiples of 64', () => {
    expect(fitToArea({ width: 3000, height: 4000 }, 1024 * 1024)).toEqual({ width: 896, height: 1152 })
    expect(fitToArea({ width: 4000, height: 3000 }, 1024 * 1024)).toEqual({ width: 1152, height: 896 })
    expect(fitToArea({ width: 500, height: 500 }, 1024 * 1024)).toEqual({ width: 1024, height: 1024 })
    expect(fitToArea({ width: 1080, height: 2340 }, 1024 * 1024)).toEqual({ width: 704, height: 1536 })
  })
  it('no size known: null, and the caller keeps the configured size', () => {
    expect(fitToArea(null, 1024 * 1024)).toBeNull()
    expect(fitToArea({ width: 0, height: 10 }, 1024 * 1024)).toBeNull()
  })
})

describe('vary and outline', () => {
  it('the vary graph takes the uploaded image and a denoise, and passes as kind vary', () => {
    const g = fillWorkflow(BUILTIN_VARY, { ...VALUES, image: 'cynco-in.png', denoise: 0.55 })
    const load = Object.values(g).find(n => n.class_type === 'LoadImage')!
    const ks = Object.values(g).find(n => n.class_type === 'KSampler')!
    expect(load.inputs.image).toBe('cynco-in.png')
    expect(ks.inputs.denoise).toBe(0.55)
    expect(parseWorkflow(JSON.stringify(BUILTIN_VARY), 'builtin-vary', 'vary').ok).toBe(true)
    expect(workflowClasses(BUILTIN_VARY)).toContain('ImageScale')
  })
  it('the outline graph needs no prompt as kind outline, and is refused as kind generate', () => {
    const text = JSON.stringify(BUILTIN_OUTLINE)
    expect(parseWorkflow(text, 'builtin-outline', 'outline').ok).toBe(true)
    const asGenerate = parseWorkflow(text, 'builtin-outline', 'generate')
    expect(asGenerate.ok).toBe(false)
    if (!asGenerate.ok) expect(asGenerate.reason).toContain('{{prompt}}')
    expect(workflowClasses(BUILTIN_OUTLINE)).toEqual(['LineArtPreprocessor', 'LoadImage', 'SaveImage'])
  })
  it('a vary workflow without {{image}} is refused naming it', () => {
    const r = parseWorkflow(JSON.stringify(BUILTIN_WORKFLOW), 'mine.json', 'vary')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('{{image}}')
  })
  it('the edit graph (Qwen-Image-Edit-2509 GGUF + Lightning, F193): the instruction is the positive prompt, the uploaded photo feeds the encoder and the latent, sampling is fixed, no checkpoint', () => {
    expect(BUILTIN_EDIT_SHA).toBe('builtin-edit-1')
    expect(parseWorkflow(JSON.stringify(BUILTIN_EDIT), 'builtin-edit', 'edit').ok).toBe(true)
    const classes = workflowClasses(BUILTIN_EDIT)
    for (const c of ['UnetLoaderGGUF', 'LoraLoaderModelOnly', 'ModelSamplingAuraFlow', 'CFGNorm', 'CLIPLoader', 'VAELoader', 'LoadImage', 'FluxKontextImageScale', 'VAEEncode', 'TextEncodeQwenImageEditPlus', 'KSampler', 'VAEDecode', 'SaveImage']) expect(classes).toContain(c)
    expect(classes).not.toContain('CheckpointLoaderSimple')
    expect([...placeholdersIn(BUILTIN_EDIT)].sort()).toEqual(['filename_prefix', 'image', 'prompt', 'seed'])
    const g = fillWorkflow(BUILTIN_EDIT, { ...VALUES, prompt: 'add a wooden pergola over the table', image: 'cynco-in.jpg' })
    expect(Object.values(g).find(n => n.class_type === 'LoadImage')!.inputs.image).toBe('cynco-in.jpg')
    const encodes = Object.values(g).filter(n => n.class_type === 'TextEncodeQwenImageEditPlus').map(n => n.inputs.prompt)
    expect(encodes.sort()).toEqual(['', 'add a wooden pergola over the table'])
    const ks = Object.values(g).find(n => n.class_type === 'KSampler')!.inputs
    expect([ks.steps, ks.cfg, ks.sampler_name, ks.scheduler, ks.denoise]).toEqual([4, 1, 'euler', 'simple', 1])
    expect(Object.values(g).find(n => n.class_type === 'UnetLoaderGGUF')!.inputs.unet_name).toBe('Qwen-Image-Edit-2509-Q4_K_S.gguf')
    expect(Object.values(g).find(n => n.class_type === 'LoraLoaderModelOnly')!.inputs.lora_name).toBe('Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors')
    expect(EDIT_SAMPLING).toEqual({ steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple', negative: '' })
  })
  it('an edit workflow needs {{image}} and {{prompt}}: the outline graph is refused as kind edit naming the prompt', () => {
    const r = parseWorkflow(JSON.stringify(BUILTIN_OUTLINE), 'mine.json', 'edit')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('{{prompt}}')
  })
  it('an unfilled image token is left in place rather than becoming "undefined"', () => {
    const g = fillWorkflow(BUILTIN_VARY, VALUES)
    expect(Object.values(g).find(n => n.class_type === 'LoadImage')!.inputs.image).toBe('{{image}}')
  })
})
