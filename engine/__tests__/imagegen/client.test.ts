import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ComfyClient, ComfyError, probeComfy } from '../../imagegen/client.js'
import { comfyConfig, type ComfyConfig } from '../../imagegen/config.js'
import { RUN_ID } from '../../imagegen/store.js'
import { BUILTIN_WORKFLOW, fillWorkflow } from '../../imagegen/workflow.js'
import { closedPort, PNG_1X1, startMockComfy, type MockComfy } from './mockComfy.js'

let mock: MockComfy | null = null
afterEach(async () => { await mock?.close(); mock = null })

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ComfyError)
    return (e as ComfyError).reason
  }
  throw new Error('expected a ComfyError')
}

function cfgFor(url: string, env: Record<string, string> = {}): ComfyConfig {
  const r = comfyConfig({ LOCALCODE_COMFYUI_URL: url, ...env })
  if (!r.ok) throw new Error(r.reason)
  return r.cfg
}

const PROMPT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('ComfyClient against the mock', () => {
  it('system stats, checkpoints and nodes', async () => {
    mock = await startMockComfy()
    const c = new ComfyClient(mock.url)
    expect(await c.systemStats()).toEqual({ version: '0.3.60', device: 'cuda:0 NVIDIA GeForce RTX 4070 Ti SUPER : cudaMallocAsync', vramGB: 16 })
    expect(await c.checkpoints()).toEqual(['juggernautXL_v9.safetensors', 'sd15.safetensors'])
    expect(await c.hasNode('KSampler')).toBe(true)
    expect(await c.hasNode('Hunyuan3Dv2Conditioning')).toBe(false)
    expect(mock.calls.map(x => x.path)).toEqual(['/system_stats', '/models/checkpoints', '/object_info/KSampler', '/object_info/Hunyuan3Dv2Conditioning'])
  })

  it('a server that is not ComfyUI is named', async () => {
    mock = await startMockComfy({ stats: '404' })
    expect(await reasonOf(new ComfyClient(mock.url).systemStats())).toBe(`${mock.url} answered /system_stats with HTTP 404 — is that ComfyUI?`)
    mock.mode.stats = 'not-comfy'
    expect(await reasonOf(new ComfyClient(mock.url).systemStats())).toBe(`${mock.url} answered /system_stats with HTTP 200 — is that ComfyUI?`)
  })

  it('submit sends the graph, our prompt_id and a client id, and returns the server id', async () => {
    mock = await startMockComfy()
    const c = new ComfyClient(mock.url)
    expect(await c.submit(BUILTIN_WORKFLOW, PROMPT_ID)).toBe(PROMPT_ID)
    const call = mock.calls.find(x => x.path === '/prompt')!
    expect(call.method).toBe('POST')
    expect(call.body).toMatchObject({ prompt: BUILTIN_WORKFLOW, prompt_id: PROMPT_ID, client_id: `cynco-${RUN_ID}` })
    // An older server ignores the client's id: its own is authoritative.
    mock.mode.ignoreClientId = true
    const other = await c.submit(BUILTIN_WORKFLOW, PROMPT_ID)
    expect(other).not.toBe(PROMPT_ID)
    expect(other).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a 400 becomes the server reason with the first node error, cut to 300 characters', async () => {
    mock = await startMockComfy({
      refuse: {
        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
        node_errors: { '4': { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'missing.safetensors' not in ['a.safetensors']", extra_info: {} }], dependent_outputs: ['9'], class_type: 'CheckpointLoaderSimple' } },
      },
    })
    const reason = await reasonOf(new ComfyClient(mock.url).submit(BUILTIN_WORKFLOW, PROMPT_ID))
    expect(reason).toBe("ComfyUI refused the workflow: Prompt outputs failed validation; node 4 (CheckpointLoaderSimple): Value not in list: ckpt_name: 'missing.safetensors' not in ['a.safetensors']")
    mock.mode.refuse = { error: { message: 'x'.repeat(400) }, node_errors: {} }
    const long = await reasonOf(new ComfyClient(mock.url).submit(BUILTIN_WORKFLOW, PROMPT_ID))
    expect(long.length).toBe(300)
    expect(long.endsWith('…')).toBe(true)
  })

  it('history: null while pending, then the entry', async () => {
    mock = await startMockComfy({ pendingPolls: 2 })
    const c = new ComfyClient(mock.url)
    const graph = fillWorkflow(BUILTIN_WORKFLOW, { prompt: 'p', negative: 'n', seed: 1, width: 1024, height: 1024, steps: 40, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', checkpoint: 'c', filename_prefix: 'cynco/0123456789abcdef0123456789abcdef' })
    const id = await c.submit(graph, PROMPT_ID)
    expect(await c.history(id)).toBeNull()
    expect(await c.history(id)).toBeNull()
    const entry = await c.history(id)
    expect(entry?.status.status_str).toBe('success')
    expect(entry?.outputs['9']).toEqual({ images: [{ filename: '0123456789abcdef0123456789abcdef_00001_.png', subfolder: 'cynco', type: 'output' }] })
    expect(await c.history('a6c0f0a4-0000-4000-8000-000000000000')).toBeNull()
  })

  it('download: the filename goes only into the query string; PNG bytes come back', async () => {
    mock = await startMockComfy()
    const c = new ComfyClient(mock.url)
    const bytes = await c.download({ filename: '../../x.png', subfolder: 'C:\\x', type: 'output' }, 1024)
    expect(Buffer.from(bytes).equals(PNG_1X1)).toBe(true)
    const view = mock.calls.find(x => x.path === '/view')!
    expect(view.query).toEqual({ filename: '../../x.png', subfolder: 'C:\\x', type: 'output' })
  })

  it('download refuses a bad reference before asking', async () => {
    mock = await startMockComfy()
    const c = new ComfyClient(mock.url)
    expect(await reasonOf(c.download({ filename: 'x'.repeat(256), subfolder: '', type: 'output' }, 1024))).toMatch(/will not fetch/)
    expect(await reasonOf(c.download({ filename: 42 as unknown as string, subfolder: '', type: 'output' }, 1024))).toMatch(/will not fetch/)
    expect(await reasonOf(c.download({ filename: 'a.png', subfolder: '', type: 'input' as 'output' }, 1024))).toMatch(/only output and temp/)
    expect(mock.calls.filter(x => x.path === '/view')).toEqual([])
  })

  it('download refuses an oversized body, with and without Content-Length', async () => {
    mock = await startMockComfy({ view: 'oversized-cl', oversizedBytes: 8192 })
    const c = new ComfyClient(mock.url)
    expect(await reasonOf(c.download({ filename: 'a.png', subfolder: '', type: 'output' }, 4096))).toMatch(/^the picture from ComfyUI is larger than \d+ MB; refused$/)
    mock.mode.view = 'oversized-chunked'
    expect(await reasonOf(c.download({ filename: 'a.png', subfolder: '', type: 'output' }, 4096))).toMatch(/^the picture from ComfyUI is larger than \d+ MB; refused$/)
    mock.mode.oversizedBytes = 40 * 1024 * 1024
    mock.mode.view = 'oversized-cl'
    expect(await reasonOf(c.download({ filename: 'a.png', subfolder: '', type: 'output' }, 32 * 1024 * 1024))).toBe('the picture from ComfyUI is larger than 32 MB; refused')
  })

  it('download refuses a body that is not a PNG', async () => {
    mock = await startMockComfy({ view: 'not-png' })
    expect(await reasonOf(new ComfyClient(mock.url).download({ filename: 'a.png', subfolder: '', type: 'output' }, 1024))).toBe('ComfyUI sent a 17-byte file that is not a PNG')
  })

  it('interrupt and dequeue name the prompt id', async () => {
    mock = await startMockComfy()
    const c = new ComfyClient(mock.url)
    await c.interrupt(PROMPT_ID)
    await c.dequeue([PROMPT_ID])
    expect(mock.calls.map(x => [x.method, x.path, x.body])).toEqual([['POST', '/interrupt', { prompt_id: PROMPT_ID }], ['POST', '/queue', { delete: [PROMPT_ID] }]])
  })

  it('an unreachable server names --listen and the port', async () => {
    const port = await closedPort()
    const url = `http://127.0.0.1:${port}`
    const reason = await reasonOf(new ComfyClient(url).systemStats())
    expect(reason).toMatch(new RegExp(`^ComfyUI did not answer at ${url.replace(/[.]/g, '\\.')} \\(\\w+\\) — it listens on 127\\.0\\.0\\.1 unless started with --listen, and the PC's firewall must allow port ${port}$`))
  })

  it('a slow server times out with a named reason', async () => {
    mock = await startMockComfy({ delay: { '/system_stats': 400 } })
    const reason = await reasonOf(new ComfyClient(mock.url, fetch, { stats: 50 }).systemStats())
    expect(reason).toMatch(/^ComfyUI did not answer at .* \(timeout\) — it listens on 127\.0\.0\.1 unless started with --listen/)
  })
})

describe('probeComfy', () => {
  it('picks the alphabetically first Juggernaut checkpoint and checks every node', async () => {
    mock = await startMockComfy({ checkpoints: ['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors', 'JuggernautXL_v10.safetensors'] })
    const r = await probeComfy(cfgFor(mock.url), fetch)
    expect(r).toEqual({ ok: true, version: '0.3.60', device: 'cuda:0 NVIDIA GeForce RTX 4070 Ti SUPER : cudaMallocAsync', vramGB: 16, checkpoint: 'JuggernautXL_v10.safetensors', picked: true, checkpointCount: 3, checkpoints: ['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors', 'JuggernautXL_v10.safetensors'] })
    expect(mock.calls.filter(x => x.path.startsWith('/object_info/')).map(x => x.path)).toHaveLength(6)
  })

  it('else the first /xl/ checkpoint; with neither it refuses rather than guess', async () => {
    mock = await startMockComfy({ checkpoints: ['v1-5.safetensors', 'sd_xl_base_1.0.safetensors'] })
    expect(await probeComfy(cfgFor(mock.url))).toMatchObject({ ok: true, checkpoint: 'sd_xl_base_1.0.safetensors', picked: true })
    mock.mode.checkpoints = ['flux1-dev-fp8.safetensors', 'v1-5.safetensors']
    expect(await probeComfy(cfgFor(mock.url))).toEqual({ ok: false, reason: `ComfyUI at 127.0.0.1:${mock.port} has no SDXL checkpoint to pick (it has: flux1-dev-fp8.safetensors, v1-5.safetensors); set LOCALCODE_COMFYUI_CHECKPOINT, or LOCALCODE_COMFYUI_WORKFLOW for another model family` })
  })

  it('a configured checkpoint must be listed exactly', async () => {
    mock = await startMockComfy()
    expect(await probeComfy(cfgFor(mock.url, { LOCALCODE_COMFYUI_CHECKPOINT: 'sd15.safetensors' }))).toMatchObject({ ok: true, checkpoint: 'sd15.safetensors', picked: false })
    expect(await probeComfy(cfgFor(mock.url, { LOCALCODE_COMFYUI_CHECKPOINT: 'juggernaut.safetensors' }))).toEqual({ ok: false, reason: `ComfyUI at 127.0.0.1:${mock.port} has no checkpoint "juggernaut.safetensors" (it has: juggernautXL_v9.safetensors, sd15.safetensors)` })
  })

  // F179: the service checks the checkpoint a picture was keyed on against this list before it POSTs.
  it("a good probe carries the server's checkpoint list as sent when the workflow has {{checkpoint}}, configured or picked; none when it has not", async () => {
    mock = await startMockComfy({ checkpoints: ['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors', 42 as unknown as string] })
    expect(await probeComfy(cfgFor(mock.url))).toMatchObject({ ok: true, checkpoint: 'juggernautXL_v9.safetensors', picked: true, checkpointCount: 2, checkpoints: ['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors'] })
    expect(await probeComfy(cfgFor(mock.url, { LOCALCODE_COMFYUI_CHECKPOINT: 'sd_xl_base_1.0.safetensors' }))).toMatchObject({ ok: true, checkpoint: 'sd_xl_base_1.0.safetensors', picked: false, checkpoints: ['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors'] })
    const d = mkdtempSync(join(tmpdir(), 'cynco-imagegen-client-'))
    try {
      const wf = join(d, 'fixed.json')
      writeFileSync(wf, JSON.stringify({ ...BUILTIN_WORKFLOW, '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' } } }))
      const fixed = cfgFor(mock.url, { LOCALCODE_COMFYUI_WORKFLOW: wf })
      expect(fixed.workflow.usesCheckpoint).toBe(false)
      const before = mock.calls.length
      const r = await probeComfy(fixed)
      expect(r).toEqual({ ok: true, version: '0.3.60', device: 'cuda:0 NVIDIA GeForce RTX 4070 Ti SUPER : cudaMallocAsync', vramGB: 16, checkpoint: null, picked: false, checkpointCount: 0 })
      expect(mock.calls.slice(before).some(c => c.path === '/models/checkpoints')).toBe(false)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('a missing node is named', async () => {
    mock = await startMockComfy({ nodes: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'SaveImage', 'VAEDecode'] })
    expect(await probeComfy(cfgFor(mock.url))).toEqual({ ok: false, reason: `ComfyUI at 127.0.0.1:${mock.port} has no "KSampler" node, which the workflow uses — install it or change the workflow` })
  })

  it('an unreachable server is a reason, not a throw', async () => {
    const port = await closedPort()
    const r = await probeComfy(cfgFor(`http://127.0.0.1:${port}`))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/did not answer .* --listen/)
  })
})
