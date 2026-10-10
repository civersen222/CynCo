import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { UiImageEvent, UiSpec } from '../../bridge/protocol.js'
import { ensureHistory } from '../../projects/history.js'
import { createProject, readJournal } from '../../projects/layout.js'
import { UNSET_REASON } from '../../imagegen/config.js'
import { ImageService, CAP_REASON, CUT_OFF_REASON, PROJECT_ONLY_REASON, QUEUE_FULL_REASON, STOPPED_REASON, type AnnotateAt, type ImageServiceDeps } from '../../imagegen/service.js'
import { INTERRUPTED_REASON, originKey, pngPath, readOrigins, readSidecar, storedImageState, writeSidecar } from '../../imagegen/store.js'
import { closedPort, PNG_1X1, startMockComfy, until, type MockComfy } from './mockComfy.js'

let home: string, dir: string, slug: string
let mock: MockComfy | null = null
let service: ImageService | null = null
let events: UiImageEvent[], logs: string[]

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cynco-imagegen-svc-'))
  slug = createProject(home, { name: 'Aliens' }).slug
  dir = join(home, slug)
  await ensureHistory(dir)
  events = []
  logs = []
})
afterEach(async () => {
  // Stop the worker, then let it unwind: a commit still running would race the rmSync below.
  await service?.shutdown()
  await service?.whenIdle()
  service = null
  await mock?.close()
  mock = null
  rmSync(home, { recursive: true, force: true })
})

function start(deps: Partial<ImageServiceDeps> & { env?: NodeJS.ProcessEnv } = {}): ImageService {
  service = new ImageService({
    env: { LOCALCODE_COMFYUI_URL: mock?.url ?? '' },
    emit: e => events.push(e), log: l => logs.push(l), pollMs: 5,
    ...deps,
  })
  return service
}

/** A Grid of Cards, one Image per prompt, ids img-0, img-1, … */
function spec(prompts: string[]): UiSpec {
  const elements: UiSpec['elements'] = Object.create(null)
  elements.grid = { type: 'Grid', props: {}, children: prompts.map((_, i) => `card-${i}`) }
  prompts.forEach((p, i) => {
    elements[`card-${i}`] = { type: 'Card', props: { title: `Option ${i}` }, children: [`img-${i}`] }
    elements[`img-${i}`] = { type: 'Image', props: { prompt: p, alt: `Alien ${i}` } }
  })
  return { root: 'grid', elements }
}

const at = (over: Partial<AnnotateAt> = {}): AnnotateAt => ({ project: { dir, slug, chatFile: 'c.jsonl' }, toolId: 'tool-1', surfaceId: 'aliens', cutOff: false, ...over })
const imageOf = (s: UiSpec, i: number) => s.elements[`img-${i}`].image!
const keyOf = (s: UiSpec, i: number) => { const st = imageOf(s, i); if (st.status === 'off') throw new Error(`img-${i} is off: ${st.reason}`); return st.key }
const posts = () => mock!.calls.filter(c => c.path === '/prompt')
const terminal = (key: string) => events.some(e => e.key === key && (e.status === 'done' || e.status === 'failed'))

function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === '.git') continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(root, p).split('\\').join('/'))
    }
  }
  walk(root)
  return out.sort()
}

describe('ImageService: a picture end to end', () => {
  it('annotates queued, runs the job, stores the PNG and its record, journals, commits and emits', async () => {
    mock = await startMockComfy({ pendingPolls: 2 })
    const svc = start()
    const before = filesUnder(dir)
    const s = spec(['  a tall   green alien in a silver suit '])
    const pics = svc.annotate(s, at())
    const key = keyOf(s, 0)
    expect(imageOf(s, 0)).toEqual({ status: 'queued', key, slug, w: 1024, h: 1024 })
    expect(pics.note).toBe(`Pictures: 1 generating on ComfyUI at 127.0.0.1:${mock.port} — they appear in their cards by themselves; do not call RenderUI again for them.`)
    expect(readSidecar(dir, key)).toMatchObject({ status: 'queued', prompt: 'a tall green alien in a silver suit', alt: 'Alien 0', checkpoint: 'auto', apiPrompt: null, origin: { chatFile: 'c.jsonl', toolId: 'tool-1', elementId: 'img-0', surfaceId: 'aliens' } })
    expect(readOrigins(dir)[originKey({ chatFile: 'c.jsonl', toolId: 'tool-1', elementId: 'img-0' })]).toBe(key)
    expect(posts()).toHaveLength(0) // nothing leaves before start()

    pics.start()
    await until(() => terminal(key), 'the job to finish')
    expect(events.map(e => [e.type, e.key, e.slug, e.status])).toEqual([['ui.image', key, slug, 'running'], ['ui.image', key, slug, 'done']])

    expect(Buffer.from(readFileSync(pngPath(dir, key))).equals(PNG_1X1)).toBe(true)
    const sc = readSidecar(dir, key)!
    expect(sc).toMatchObject({ status: 'done', checkpoint: 'juggernautXL_v9.safetensors', bytes: PNG_1X1.length, comfy: { host: `127.0.0.1:${mock.port}`, outputs: [{ filename: `${key}_00001_.png`, subfolder: 'cynco', type: 'output' }] } })
    expect(sc.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sc.apiPrompt).toMatchObject({ '6': { inputs: { text: 'a tall green alien in a silver suit' } }, '9': { inputs: { filename_prefix: `cynco/${key}` } }, '4': { inputs: { ckpt_name: 'juggernautXL_v9.safetensors' } } })
    expect(typeof sc.queueMs).toBe('number')
    expect(typeof sc.genMs).toBe('number')
    expect(sc.execMs).toBe(1234)
    expect((posts()[0].body as { prompt_id: string }).prompt_id).toBe(sc.comfy.promptId)

    expect(readJournal(dir)[0]).toMatchObject({ event: 'image.generated', detail: `Alien 0 (${key.slice(0, 8)}) — 1024x1024, juggernautXL_v9.safetensors` })
    await svc.whenIdle()
    const committed = execFileSync('git', ['log', '--name-only', '--format=%s'], { cwd: dir, encoding: 'utf8' })
    expect(committed).toContain(`image: Alien 0 (${key.slice(0, 8)})`)
    expect(committed).toContain(`images/${key}.json`)
    expect(committed).toContain('images/index.json')
    expect(committed).not.toContain(`images/${key}.png`)
    execFileSync('git', ['check-ignore', '-q', `images/${key}.png`], { cwd: dir }) // exits 0: ignored
    expect(readJournal(dir).some(j => j.event === 'history.failed')).toBe(false)

    // Nothing written outside images/ (and the .gitignore line, the journal).
    const added = filesUnder(dir).filter(f => !before.includes(f))
    expect(added).toEqual([`images/${key}.json`, `images/${key}.png`, 'images/index.json'])
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.cynco/\nimages/*.png\n')

    expect(logs.find(l => l.startsWith('[imagegen] RenderUI'))).toBe('[imagegen] RenderUI tool-1 (surface aliens): 1 pictures — 1 queued, 0 already made')
    expect(logs.find(l => l.startsWith(`[imagegen] ${key.slice(0, 8)} done`))).toMatch(new RegExp(`^\\[imagegen\\] ${key.slice(0, 8)} done in [\\d.]+s \\(queue [\\d.]+s, gen [\\d.]+s, exec 1\\.2s\\) 1024x1024 40 steps juggernautXL_v9\\.safetensors on 127\\.0\\.0\\.1:\\d+ → images/${key}\\.png \\(0\\.0 MB\\)$`))
    expect(logs.some(l => l.startsWith('[imagegen] ready: ComfyUI 0.3.60 at 127.0.0.1:') && l.includes('checkpoint juggernautXL_v9.safetensors (picked from 2); 1024x1024, 40 steps, cfg 6, dpmpp_2m/karras'))).toBe(true)
  })

  it('runs one job at a time, first in first out', async () => {
    mock = await startMockComfy({ pendingPolls: 3 })
    const svc = start()
    const s = spec(['alien one', 'alien two', 'alien three'])
    svc.annotate(s, at()).start()
    await until(() => [0, 1, 2].every(i => terminal(keyOf(s, i))), 'three jobs')
    expect(mock.prompts).toEqual(['alien one', 'alien two', 'alien three'])
    expect(mock.maxInFlight).toBe(1)
    expect(events.filter(e => e.status === 'done')).toHaveLength(3)
  })

  it('one job for two Images with the same prompt; a made picture is a cache hit with no POST', async () => {
    mock = await startMockComfy()
    const svc = start()
    const s = spec(['alien', ' alien '])
    const pics = svc.annotate(s, at())
    expect(keyOf(s, 0)).toBe(keyOf(s, 1))
    expect(pics.note).toMatch(/^Pictures: 2 generating/)
    pics.start()
    await until(() => terminal(keyOf(s, 0)), 'the job')
    expect(posts()).toHaveLength(1)
    const origins = readOrigins(dir)
    expect(origins[originKey({ chatFile: 'c.jsonl', toolId: 'tool-1', elementId: 'img-1' })]).toBe(keyOf(s, 0))

    // A re-render (ids renamed, a new call) of the same prompt: done at once, no job.
    const again: UiSpec = { root: 'pic', elements: Object.assign(Object.create(null), { pic: { type: 'Image', props: { prompt: 'alien', alt: 'Again' } } }) }
    const hit = svc.annotate(again, at({ toolId: 'tool-2' }))
    expect(again.elements.pic.image).toEqual({ status: 'done', key: keyOf(s, 0), slug, w: 1024, h: 1024 })
    expect(hit.note).toBe('Pictures: 1 already made — shown in their cards.')
    hit.start()
    await new Promise(r => setTimeout(r, 30))
    expect(posts()).toHaveLength(1)
  })

  it('a picture asked for again the moment it fails gets a fresh job, never the old failure', async () => {
    mock = await startMockComfy({ executionError: { node_id: '3', node_type: 'KSampler', exception_message: 'boom' } })
    let again: UiSpec | null = null
    const svc = start({
      emit: e => {
        events.push(e)
        // Re-render inside the failure's own event: the worst-timed re-request there is.
        if (e.status === 'failed' && !again) {
          mock!.mode.executionError = null
          again = spec(['alien'])
          svc.annotate(again, at({ toolId: 'tool-2' })).start()
        }
      },
    })
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    const key = keyOf(s, 0)
    await until(() => events.some(e => e.key === key && e.status === 'done'), 'the second attempt')
    expect(imageOf(again!, 0)).toMatchObject({ status: 'queued', key })
    expect(events.map(e => e.status)).toEqual(['running', 'failed', 'running', 'done'])
    expect(posts()).toHaveLength(2)
    await svc.whenIdle()
    expect(readSidecar(dir, key)).toMatchObject({ status: 'done' })
  })

  it('an Image whose prompt is in flight joins that job', async () => {
    mock = await startMockComfy({ pendingPolls: 20 })
    const svc = start()
    const a = spec(['alien'])
    svc.annotate(a, at()).start()
    await until(() => events.some(e => e.status === 'running'), 'running')
    const b = spec(['alien'])
    const pics = svc.annotate(b, at({ toolId: 'tool-2' }))
    expect(imageOf(b, 0)).toEqual({ status: 'running', key: keyOf(a, 0), slug, w: 1024, h: 1024 })
    pics.start()
    await until(() => terminal(keyOf(a, 0)), 'the job')
    expect(posts()).toHaveLength(1)
  })

  it('a hostile output filename still lands only at images/<key>.png and reaches /view only as a query parameter', async () => {
    mock = await startMockComfy({ filename: '../../x.png', subfolder: 'C:\\x' })
    const svc = start()
    const before = filesUnder(home)
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    const key = keyOf(s, 0)
    await until(() => terminal(key), 'the job')
    expect(events.at(-1)?.status).toBe('done')
    const view = mock.calls.find(c => c.path === '/view')!
    expect(view.query).toEqual({ filename: '../../x.png', subfolder: 'C:\\x', type: 'output' })
    const added = filesUnder(home).filter(f => !before.includes(f))
    expect(added).toEqual([`${slug}/images/${key}.json`, `${slug}/images/${key}.png`, `${slug}/images/index.json`])
    expect(existsSync(join(home, '..', 'x.png'))).toBe(false)
  })
})

describe('ImageService: failures are named', () => {
  async function failureOf(overrides: Parameters<typeof startMockComfy>[0], deps: Partial<ImageServiceDeps> = {}): Promise<string> {
    mock = await startMockComfy(overrides)
    const svc = start(deps)
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    const key = keyOf(s, 0)
    await until(() => terminal(key), 'the job')
    const ev = events.at(-1)!
    expect(ev.status).toBe('failed')
    const sc = readSidecar(dir, key)!
    expect(sc.status).toBe('failed')
    expect(sc.reason).toBe(ev.reason)
    expect(readJournal(dir)[0]).toMatchObject({ event: 'image.failed', detail: `Alien 0 (${key.slice(0, 8)}): ${ev.reason}` })
    expect(logs.some(l => l.startsWith(`[imagegen] ${key.slice(0, 8)} failed after `) && l.includes(`(queue `) && l.endsWith(ev.reason!))).toBe(true)
    expect(existsSync(pngPath(dir, key))).toBe(false)
    return ev.reason!
  }

  it('an execution error names the node, and an allocation failure says out of GPU memory', async () => {
    expect(await failureOf({ executionError: { node_id: '3', node_type: 'KSampler', exception_message: 'mat1 and mat2 shapes cannot be multiplied' } }))
      .toBe('ComfyUI failed in KSampler (node 3): mat1 and mat2 shapes cannot be multiplied')
  })

  it('out of memory', async () => {
    expect(await failureOf({ executionError: { node_id: '8', node_type: 'VAEDecode', exception_message: 'Allocation on device', exception_type: 'torch.OutOfMemoryError' } }))
      .toBe('ComfyUI failed in VAEDecode (node 8): Allocation on device — out of GPU memory; lower LOCALCODE_COMFYUI_SIZE')
  })

  it('an interruption on the PC', async () => {
    expect(await failureOf({ interrupted: true })).toBe('interrupted on the ComfyUI PC')
  })

  it('a refused workflow', async () => {
    expect(await failureOf({ refuse: { error: { message: 'Prompt outputs failed validation' }, node_errors: {} } })).toBe('ComfyUI refused the workflow: Prompt outputs failed validation')
  })

  it('no saved image', async () => {
    expect(await failureOf({ noOutputs: true })).toBe('the workflow saved no image (add a SaveImage node)')
  })

  it('a non-PNG download', async () => {
    expect(await failureOf({ view: 'not-png' })).toBe('ComfyUI sent a 17-byte file that is not a PNG')
  })

  it('a missing checkpoint (the probe)', async () => {
    expect(await failureOf({ checkpoints: ['v1-5.safetensors'] })).toMatch(/has no SDXL checkpoint to pick \(it has: v1-5\.safetensors\)/)
  })

  it('a timeout interrupts and dequeues the prompt by id', async () => {
    const reason = await failureOf({ neverFinish: true }, { timeoutMs: 60 })
    expect(reason).toBe('ComfyUI did not finish within 0 s (it may be busy with other work)')
    const id = (posts()[0].body as { prompt_id: string }).prompt_id
    expect(mock!.calls.filter(c => c.path === '/interrupt' || c.path === '/queue').map(c => [c.path, c.body])).toEqual([['/interrupt', { prompt_id: id }], ['/queue', { delete: [id] }]])
  })

  it('an unreachable server', async () => {
    const port = await closedPort()
    const svc = start({ env: { LOCALCODE_COMFYUI_URL: `http://127.0.0.1:${port}` } })
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    await until(() => terminal(keyOf(s, 0)), 'the job')
    expect(events.at(-1)).toMatchObject({ status: 'failed', reason: expect.stringMatching(new RegExp(`^ComfyUI did not answer at http://127\\.0\\.0\\.1:${port} .*--listen, and the PC's firewall must allow port ${port}$`)) })
    // The failed probe is reused for 60 s, and the next call's note says so.
    const next = spec(['another alien'])
    const pics = svc.annotate(next, at({ toolId: 'tool-2' }))
    expect(pics.note).toMatch(/do not call RenderUI again for them\. The last check of ComfyUI failed \(ComfyUI did not answer at .*\); if it still fails, the cards will say so\.$/)
    expect(logs.filter(l => l.startsWith('[imagegen] not ready:'))).toHaveLength(1)
  })
})

describe('ImageService: what is not generated', () => {
  it('unset URL: every Image off with the reason, and no network call', async () => {
    let fetched = 0
    const svc = start({ env: {}, fetchFn: (async () => { fetched++; throw new Error('no') }) as unknown as typeof fetch })
    const s = spec(['alien', 'base'])
    const pics = svc.annotate(s, at())
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: UNSET_REASON })
    expect(imageOf(s, 1)).toEqual({ status: 'off', reason: UNSET_REASON })
    expect(pics.note).toBe(`Pictures: not generated — ${UNSET_REASON}. The cards show their alt text; tell the user if they want pictures.`)
    pics.start()
    expect(await svc.probe()).toEqual({ ok: false, reason: UNSET_REASON })
    expect(logs).toContain('[imagegen] off: LOCALCODE_COMFYUI_URL unset')
    expect(fetched).toBe(0)
    expect(existsSync(join(dir, 'images'))).toBe(false)
  })

  it('a coding session, a cut-off call, and a spec with no prompted Image', async () => {
    mock = await startMockComfy()
    const svc = start()
    const s = spec(['alien'])
    expect(svc.annotate(s, at({ project: null })).note).toBe(`Pictures: not generated — ${PROJECT_ONLY_REASON}. The cards show their alt text; tell the user if they want pictures.`)
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: PROJECT_ONLY_REASON })
    svc.annotate(s, at({ cutOff: true }))
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: CUT_OFF_REASON })
    const url: UiSpec = { root: 'i', elements: Object.assign(Object.create(null), { i: { type: 'Image', props: { src: 'https://example.com/a.png', alt: 'A' } } }) }
    expect(svc.annotate(url, at()).note).toBeNull()
    expect(url.elements.i.image).toBeUndefined()
    expect(mock.calls).toEqual([])
  })

  it('only the first 6 distinct pictures in a call are generated', async () => {
    mock = await startMockComfy()
    const svc = start()
    const s = spec(Array.from({ length: 8 }, (_, i) => `alien number ${i}`))
    const pics = svc.annotate(s, at())
    expect([0, 1, 2, 3, 4, 5].map(i => imageOf(s, i).status)).toEqual(Array(6).fill('queued'))
    expect(imageOf(s, 6)).toEqual({ status: 'off', reason: CAP_REASON })
    expect(imageOf(s, 7)).toEqual({ status: 'off', reason: CAP_REASON })
    expect(pics.note).toBe(`Pictures: 6 generating on ComfyUI at 127.0.0.1:${mock.port} — they appear in their cards by themselves; do not call RenderUI again for them. Only the first 6 pictures in a surface are generated.`)
  })

  it('the queue holds 24; the next picture is refused with a reason', async () => {
    mock = await startMockComfy()
    const svc = start()
    for (let call = 0; call < 4; call++) svc.annotate(spec(Array.from({ length: 6 }, (_, i) => `alien ${call}-${i}`)), at({ toolId: `t${call}` }))
    const s = spec(['one more alien'])
    const pics = svc.annotate(s, at({ toolId: 't5' }))
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: QUEUE_FULL_REASON })
    expect(pics.note).toBe(`Pictures: not generated — ${QUEUE_FULL_REASON}. The cards show their alt text; tell the user if they want pictures.`)
    expect(mock.calls).toEqual([])
  })

  it('annotate never throws: an unwritable project turns its pictures off with the reason', async () => {
    mock = await startMockComfy()
    const svc = start()
    const notADir = join(home, 'file.txt')
    writeFileSync(notADir, 'x', 'utf8')
    const s = spec(['alien'])
    const pics = svc.annotate(s, at({ project: { dir: notADir, slug, chatFile: 'c.jsonl' } }))
    expect(imageOf(s, 0)).toMatchObject({ status: 'off', reason: expect.stringMatching(/^picture generation failed inside the engine/) })
    expect(pics.note).toMatch(/^Pictures: not generated — picture generation failed inside the engine/)
    expect(logs.some(l => l.startsWith('[imagegen] annotating RenderUI tool-1 threw'))).toBe(true)
  })
})

describe('ImageService: lifecycle', () => {
  it('shutdown interrupts the running prompt by id and marks it and the queued ones failed', async () => {
    mock = await startMockComfy({ neverFinish: true })
    const svc = start()
    const s = spec(['alien one', 'alien two'])
    svc.annotate(s, at()).start()
    await until(() => events.some(e => e.status === 'running'), 'running')
    await svc.shutdown()
    const id = (posts()[0].body as { prompt_id: string }).prompt_id
    expect(mock.calls.filter(c => c.path === '/interrupt' || c.path === '/queue').map(c => [c.path, c.body])).toEqual([['/interrupt', { prompt_id: id }], ['/queue', { delete: [id] }]])
    for (const i of [0, 1]) {
      expect(readSidecar(dir, keyOf(s, i))).toMatchObject({ status: 'failed', reason: STOPPED_REASON })
      expect(events).toContainEqual({ type: 'ui.image', key: keyOf(s, i), slug, status: 'failed', reason: STOPPED_REASON })
    }
    expect(posts()).toHaveLength(1)
    // A stopped engine generates nothing more.
    const later = spec(['alien three'])
    svc.annotate(later, at({ toolId: 'tool-2' }))
    expect(imageOf(later, 0).status).toBe('off')
  })

  it('a record left queued or running by another engine run reloads as interrupted and is re-queued, not a cache hit', async () => {
    mock = await startMockComfy()
    const svc = start()
    const s = spec(['alien'])
    svc.annotate(s, at()) // queued, never started
    const key = keyOf(s, 0)
    const sc = readSidecar(dir, key)!
    writeSidecar(dir, { ...sc, status: 'running', runId: 'an-engine-that-crashed' })
    const origin = originKey({ chatFile: 'c.jsonl', toolId: 'tool-1', elementId: 'img-0' })
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'failed', key, slug, w: 1024, h: 1024, reason: INTERRUPTED_REASON })
    await svc.shutdown()
    service = start()
    const again = spec(['alien'])
    const pics = service.annotate(again, at({ toolId: 'tool-2' }))
    expect(imageOf(again, 0)).toMatchObject({ status: 'queued', key })
    pics.start()
    await until(() => events.some(e => e.key === key && e.status === 'done'), 'the re-queued job')
  })

  it('probe() logs the ready line once per state change', async () => {
    mock = await startMockComfy()
    const svc = start()
    expect(await svc.probe()).toMatchObject({ ok: true, checkpoint: 'juggernautXL_v9.safetensors', picked: true })
    await svc.probe()
    expect(logs.filter(l => l.startsWith('[imagegen] ready:'))).toHaveLength(1)
    mock.mode.stats = '404'
    expect(await svc.probe()).toMatchObject({ ok: false })
    expect(logs.filter(l => l.startsWith('[imagegen] not ready:'))).toEqual([`[imagegen] not ready: ${mock.url} answered /system_stats with HTTP 404 — is that ComfyUI?`])
  })

  it('a configured checkpoint the workflow ignores is logged once at start', () => {
    const wf = join(home, 'flux.json')
    writeFileSync(wf, JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'SaveImage', inputs: { filename_prefix: '{{filename_prefix}}', images: ['1', 0] } },
    }), 'utf8')
    start({ env: { LOCALCODE_COMFYUI_URL: 'http://pc:8188', LOCALCODE_COMFYUI_WORKFLOW: wf, LOCALCODE_COMFYUI_CHECKPOINT: 'x.safetensors' } })
    expect(logs).toEqual([`[imagegen] LOCALCODE_COMFYUI_CHECKPOINT="x.safetensors" is ignored: the workflow at ${wf} has no {{checkpoint}}`])
  })
})
