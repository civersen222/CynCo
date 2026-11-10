import { describe, it, expect } from 'bun:test'
import { BUILTIN_EDIT, BUILTIN_EDIT_SHA, BUILTIN_OUTLINE_SHA, EDIT_SAMPLING, OUTLINE_INSTRUCTION, outlinePrompt, fixQuestion, withFix, SHEET_QUESTION, sheetFromPhoto, BUILTIN_OUTLINE, BUILTIN_VARY, BUILTIN_WORKFLOW, fillWorkflow, parseWorkflow, placeholdersIn, workflowClasses, GENERATE_PLACEHOLDERS, PLACEHOLDERS, type ComfyGraph, type FillValues, fitToArea } from '../../imagegen/workflow.js'

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
  it('outline is a tracing sheet drawn by the edit recipe (2026-11-09, owner): the same graph as edit, a fixed instruction in front of whatever the model adds; no line-art node, no pack', () => {
    expect(BUILTIN_OUTLINE_SHA).toBe('builtin-outline-2')
    expect(workflowClasses(BUILTIN_OUTLINE)).toEqual(workflowClasses(BUILTIN_EDIT))
    expect(workflowClasses(BUILTIN_OUTLINE)).not.toContain('LineArtPreprocessor')
    expect(parseWorkflow(JSON.stringify(BUILTIN_OUTLINE), 'builtin-outline', 'outline').ok).toBe(true)
    expect(OUTLINE_INSTRUCTION).toMatch(/black ink/i); expect(OUTLINE_INSTRUCTION).toMatch(/white/i); expect(OUTLINE_INSTRUCTION).toMatch(/no shading/i)
    expect(outlinePrompt('')).toBe(OUTLINE_INSTRUCTION)
    expect(outlinePrompt('draw the horizon line and mark the vanishing point')).toBe(OUTLINE_INSTRUCTION + ' Also: draw the horizon line and mark the vanishing point')
  })
  it('a redo carries what was wrong (F196): fixQuestion asks about the original photo without judging the remark; withFix puts the owner\'s words, and what the photo shows when known, behind the instruction', () => {
    expect(fixQuestion('the ferns are gone')).toBe('A new picture was made from this photo, and its owner says the new picture got something wrong: "the ferns are gone". You cannot see the new picture, only this photo. In one or two short sentences, say what this photo shows of the thing the owner means and exactly where it is in the frame (top or bottom, left or right, how much of the frame). Name only things visible in this photo, and do not judge the owner\'s remark.')
    expect(fixQuestion('the "ferns" are gone')).toContain('wrong: "the \'ferns\' are gone". You')
    expect(withFix('add a pergola', 'the ferns are gone')).toBe('add a pergola. An earlier attempt got this wrong — the owner said: "the ferns are gone". Put that right, working only from the photo.')
    expect(withFix(OUTLINE_INSTRUCTION, 'the "ferns" are gone', '  Ferns fill\n the top third ')).toBe(OUTLINE_INSTRUCTION + ' An earlier attempt got this wrong — the owner said: "the \'ferns\' are gone". What the photo shows: Ferns fill the top third. Put that right, working only from the photo.')
    // a rambling answer is cut, and still reads as a sentence before the closing order
    const long = withFix('x.', 'y', 'z'.repeat(2000))
    expect(long.startsWith('x. An earlier attempt')).toBe(true)
    expect(long.length).toBeLessThan(800)
    expect(long.endsWith('z… Put that right, working only from the photo.')).toBe(true)
  })
  it('a second sheet is drawn from what the photo shows (F197): SHEET_QUESTION asks about the photo and nothing else; sheetFromPhoto puts what was seen in front of the request, and the request in quotes', () => {
    expect(SHEET_QUESTION).toBe('Someone will trace this photo. In two short sentences, say what the main subject is, which parts of it can be seen and which are hidden or cut off by the frame, and where it sits in the frame (top or bottom, left or right, how much of the frame). Name only things visible in this photo.')
    const tail = ' Guide lines may be drawn over it; of the scene, draw only what the photo shows, where it is.'
    // unseen: the form the picture's key is built on
    expect(sheetFromPhoto(' only the "eye line" ')).toBe(OUTLINE_INSTRUCTION + ` The painter asked for this sheet: "only the 'eye line'".` + tail)
    expect(sheetFromPhoto('an eye line', "  A cat's head fills\n the lower half ")).toBe(OUTLINE_INSTRUCTION + ` What the photo shows: A cat's head fills the lower half. The painter asked for this sheet: "an eye line".` + tail)
    // a rambling answer is cut, and the request still follows it
    const long = sheetFromPhoto('x', 'z'.repeat(2000))
    expect(long.length).toBeLessThan(OUTLINE_INSTRUCTION.length + 800)
    expect(long.endsWith('z… The painter asked for this sheet: "x".' + tail)).toBe(true)
  })
  it('an outline workflow needs {{image}} and {{prompt}} like an edit: the generate graph is refused as kind outline naming the image', () => {
    const r = parseWorkflow(JSON.stringify(BUILTIN_WORKFLOW), 'mine.json', 'outline')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('{{image}}')
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
  it('an edit workflow needs {{prompt}}: the edit graph with its prompt hard-wired is refused naming it', () => {
    const noPrompt = JSON.parse(JSON.stringify(BUILTIN_EDIT)) as typeof BUILTIN_EDIT
    for (const n of Object.values(noPrompt)) if (n.class_type === 'TextEncodeQwenImageEditPlus') n.inputs.prompt = 'fixed'
    const r = parseWorkflow(JSON.stringify(noPrompt), 'mine.json', 'edit')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('{{prompt}}')
  })
  it('an unfilled image token is left in place rather than becoming "undefined"', () => {
    const g = fillWorkflow(BUILTIN_VARY, VALUES)
    expect(Object.values(g).find(n => n.class_type === 'LoadImage')!.inputs.image).toBe('{{image}}')
  })
})
