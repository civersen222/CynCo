import { describe, it, expect, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cyncoHome } from '../../paths.js'
import {
  comfyCfg, comfyCheckpoint, comfyConfig, comfySize, comfySteps, comfyTimeoutS, comfyUrl, comfyWorkflow, PER_CALL_CAP, QUEUE_CAP, resolveWorkflowPath, UNSET_REASON,
} from '../../imagegen/config.js'
import { BUILTIN_WORKFLOW, BUILTIN_WORKFLOW_SHA } from '../../imagegen/workflow.js'

const URL_OK = { LOCALCODE_COMFYUI_URL: 'http://192.168.1.50:8188' }
const cleanup: string[] = []
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }) })

function tempFile(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'cynco-imagegen-cfg-'))
  cleanup.push(d)
  const p = join(d, name)
  writeFileSync(p, content, 'utf8')
  return p
}

// The operator asked for three designs × six takes in one surface (~21 s a
// picture on the SDXL base: about six minutes of GPU per surface).
describe('caps', () => {
  it('18 pictures per call, 48 waiting behind the one in flight', () => {
    expect(PER_CALL_CAP).toBe(18)
    expect(QUEUE_CAP).toBe(48)
  })
})

describe('readers', () => {
  it('string knobs: unset and blank read as empty (or the size default); values are trimmed', () => {
    expect(comfyUrl({})).toBe('')
    expect(comfyUrl({ LOCALCODE_COMFYUI_URL: '   ' })).toBe('')
    expect(comfyUrl({ LOCALCODE_COMFYUI_URL: ' http://pc:8188 ' })).toBe('http://pc:8188')
    expect(comfyCheckpoint({})).toBe('')
    expect(comfyCheckpoint({ LOCALCODE_COMFYUI_CHECKPOINT: ' juggernautXL.safetensors ' })).toBe('juggernautXL.safetensors')
    expect(comfyWorkflow({ LOCALCODE_COMFYUI_WORKFLOW: '' })).toBe('')
    expect(comfySize({})).toBe('1024x1024')
    expect(comfySize({ LOCALCODE_COMFYUI_SIZE: '' })).toBe('1024x1024')
    expect(comfySize({ LOCALCODE_COMFYUI_SIZE: ' 768x1344 ' })).toBe('768x1344')
  })

  it('numeric knobs: defaults for unset, empty, 0, negative and garbage; clamps otherwise', () => {
    for (const v of [undefined, '', '0', '-3', 'lots', 'NaN']) {
      expect(comfySteps({ LOCALCODE_COMFYUI_STEPS: v })).toBe(40)
      expect(comfyCfg({ LOCALCODE_COMFYUI_CFG: v })).toBe(6)
      expect(comfyTimeoutS({ LOCALCODE_COMFYUI_TIMEOUT_S: v })).toBe(300)
    }
    expect(comfySteps({ LOCALCODE_COMFYUI_STEPS: '25' })).toBe(25)
    expect(comfySteps({ LOCALCODE_COMFYUI_STEPS: '0.2' })).toBe(1)
    expect(comfySteps({ LOCALCODE_COMFYUI_STEPS: '900' })).toBe(150)
    expect(comfyCfg({ LOCALCODE_COMFYUI_CFG: '4.5' })).toBe(4.5)
    expect(comfyCfg({ LOCALCODE_COMFYUI_CFG: '0.01' })).toBe(0.01)
    expect(comfyCfg({ LOCALCODE_COMFYUI_CFG: '99' })).toBe(30)
    expect(comfyTimeoutS({ LOCALCODE_COMFYUI_TIMEOUT_S: '5' })).toBe(30)
    expect(comfyTimeoutS({ LOCALCODE_COMFYUI_TIMEOUT_S: '600' })).toBe(600)
    expect(comfyTimeoutS({ LOCALCODE_COMFYUI_TIMEOUT_S: '99999' })).toBe(3600)
  })
})

describe('comfyConfig', () => {
  it('unset: names the variable and an example address', () => {
    expect(comfyConfig({})).toEqual({ ok: false, reason: UNSET_REASON })
    expect(UNSET_REASON).toBe('image generation is not set up — set LOCALCODE_COMFYUI_URL to the ComfyUI server (e.g. http://192.168.1.50:8188)')
  })

  it('refuses a URL that is not http(s)', () => {
    for (const v of ['192.168.1.50:8188', 'localhost:8188', 'ftp://pc:21', 'not a url']) {
      expect(comfyConfig({ LOCALCODE_COMFYUI_URL: v })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_URL="${v}" is not an http(s) URL like http://192.168.1.50:8188` })
    }
  })

  it('keeps a path prefix, strips the trailing slash, and fills the defaults', () => {
    const r = comfyConfig({ LOCALCODE_COMFYUI_URL: 'https://proxy.lan/comfy/' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.cfg).toMatchObject({ url: 'https://proxy.lan/comfy', host: 'proxy.lan', port: '443', checkpoint: null, width: 1024, height: 1024, steps: 40, cfg: 6, timeoutMs: 300_000, sampler: 'dpmpp_2m', scheduler: 'karras' })
    expect(r.cfg.workflow).toEqual({ source: 'builtin', sha256: BUILTIN_WORKFLOW_SHA, graph: BUILTIN_WORKFLOW, usesCheckpoint: true })
    expect(r.cfg.negative).toMatch(/^text, watermark, signature, logo, lowres/)
    const plain = comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_CHECKPOINT: 'juggernautXL_v9.safetensors' })
    if (!plain.ok) throw new Error(plain.reason)
    expect(plain.cfg).toMatchObject({ url: 'http://192.168.1.50:8188', host: '192.168.1.50:8188', port: '8188', checkpoint: 'juggernautXL_v9.safetensors' })
  })

  it('refuses a size that is not WxH in multiples of 64 from 512 to 2048', () => {
    for (const v of ['1000x1000', '256x256', '4096x1024', 'big', '1024']) {
      expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_SIZE: v })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_SIZE="${v}" must be WIDTHxHEIGHT, each a multiple of 64 from 512 to 2048` })
    }
    const r = comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_SIZE: '832x1216' })
    expect(r.ok && [r.cfg.width, r.cfg.height]).toEqual([832, 1216])
  })
})

describe('workflow file', () => {
  const api = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...BUILTIN_WORKFLOW, ...extra })

  it('an absolute path is used as is; a relative one sits under cyncoHome()', () => {
    const p = tempFile('wf.json', api())
    expect(resolveWorkflowPath(p)).toBe(p)
    mkdirSync(join(cyncoHome(), 'workflows'), { recursive: true })
    writeFileSync(join(cyncoHome(), 'workflows', 'mine.json'), api(), 'utf8')
    cleanup.push(join(cyncoHome(), 'workflows'))
    expect(resolveWorkflowPath('workflows/mine.json')).toBe(join(cyncoHome(), 'workflows', 'mine.json'))
    const r = comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: 'workflows/mine.json' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.cfg.workflow.source).toBe(join(cyncoHome(), 'workflows', 'mine.json'))
    expect(r.cfg.workflow.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.cfg.workflow.usesCheckpoint).toBe(true)
  })

  it('names each problem', () => {
    const missing = join(tmpdir(), 'cynco-no-such-dir', 'wf.json')
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: missing })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: no file at ${missing}` })
    const big = tempFile('big.json', ' '.repeat(1024 * 1024 + 1))
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: big })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${big} is over 1 MB` })
    const ui = tempFile('ui.json', JSON.stringify({ last_node_id: 9, nodes: [{ id: 3, type: 'KSampler' }], links: [] }))
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: ui })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${ui} is a ComfyUI UI workflow; export it with "Export (API)"` })
    const notApi = tempFile('na.json', JSON.stringify({ '1': { inputs: {} } }))
    const na = comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: notApi })
    expect(!na.ok && na.reason).toBe(`LOCALCODE_COMFYUI_WORKFLOW: ${notApi} is not an API-format workflow (node "1" is not {class_type: string, inputs: object})`)
    const notJson = tempFile('nj.json', '{ nope')
    const nj = comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: notJson })
    expect(!nj.ok && nj.reason).toMatch(new RegExp(`^LOCALCODE_COMFYUI_WORKFLOW: .*nj\\.json is not an API-format workflow \\(not valid JSON`))
  })

  it('refuses a missing {{prompt}}, an unknown placeholder, an embedded numeric token and no SaveImage', () => {
    const noPrompt = tempFile('np.json', api({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } } }))
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: noPrompt })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${noPrompt} has no "{{prompt}}" placeholder, so nothing would describe the picture` })
    const unknown = tempFile('uk.json', api({ '10': { class_type: 'Note', inputs: { text: '{{style}}' } } }))
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: unknown })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${unknown} uses "{{style}}", which is not one of: prompt, negative, seed, width, height, steps, cfg, sampler, scheduler, checkpoint, filename_prefix` })
    const embedded = tempFile('em.json', api({ '5': { class_type: 'EmptyLatentImage', inputs: { width: 'w{{width}}', height: '{{height}}', batch_size: 1 } } }))
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: embedded })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${embedded}: "{{width}}" must be a whole string value, not part of a longer one` })
    const { '9': _save, ...noSaveGraph } = BUILTIN_WORKFLOW
    const noSave = tempFile('ns.json', JSON.stringify({ ...noSaveGraph, '9': { class_type: 'PreviewImage', inputs: { images: ['8', 0] } } }))
    expect(comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: noSave })).toEqual({ ok: false, reason: `LOCALCODE_COMFYUI_WORKFLOW: ${noSave} has no SaveImage node; the engine downloads saved images only` })
  })

  it('a workflow without {{checkpoint}} does not ask for one', () => {
    const p = tempFile('flux.json', api({ '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' } } }))
    const r = comfyConfig({ ...URL_OK, LOCALCODE_COMFYUI_WORKFLOW: p })
    expect(r.ok && r.cfg.workflow.usesCheckpoint).toBe(false)
  })
})
