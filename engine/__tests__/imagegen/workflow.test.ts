import { describe, it, expect } from 'bun:test'
import { BUILTIN_WORKFLOW, fillWorkflow, parseWorkflow, placeholdersIn, workflowClasses, PLACEHOLDERS, type ComfyGraph, type FillValues } from '../../imagegen/workflow.js'

const VALUES: FillValues = {
  prompt: 'a tall green alien', negative: 'blurry', seed: 123456789012, width: 1024, height: 768, steps: 40, cfg: 6,
  sampler: 'dpmpp_2m', scheduler: 'karras', checkpoint: 'juggernautXL_v9.safetensors', filename_prefix: 'cynco/0123456789abcdef0123456789abcdef',
}

describe('the built-in graph', () => {
  it('passes parseWorkflow and uses every placeholder', () => {
    const r = parseWorkflow(JSON.stringify(BUILTIN_WORKFLOW), 'builtin')
    expect(r.ok).toBe(true)
    expect([...placeholdersIn(BUILTIN_WORKFLOW)].sort()).toEqual([...PLACEHOLDERS].sort())
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
