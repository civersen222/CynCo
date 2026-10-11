import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { UiImageEvent, UiSpec } from '../../bridge/protocol.js'
import { ensureHistory } from '../../projects/history.js'
import { createProject, readJournal } from '../../projects/layout.js'
import { UNSET_REASON } from '../../imagegen/config.js'
import { ImageService, CAP_REASON, CUT_OFF_REASON, PROJECT_ONLY_REASON, QUEUE_FULL_REASON, STOPPED_REASON, type AnnotateAt, type ImageServiceDeps } from '../../imagegen/service.js'
import { INTERRUPTED_REASON, originKey, partPath, pngPath, readOrigins, readSidecar, storedImageState, writeSidecar } from '../../imagegen/store.js'
import { canSymlinkFiles, closedPort, PNG_1X1, startMockComfy, until, type MockComfy } from './mockComfy.js'

const CAN_SYMLINK_FILES = canSymlinkFiles()

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
const cancels = () => mock!.calls.filter(c => c.path === '/interrupt' || c.path === '/queue').map(c => [c.path, c.body])
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

  it('a call whose pictures are all made already commits the origins it records', async () => {
    mock = await startMockComfy()
    const svc = start()
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    await until(() => terminal(keyOf(s, 0)), 'the job')
    await svc.whenIdle()
    const uncommitted = () => execFileSync('git', ['status', '--porcelain', '--', 'images', '.gitignore'], { cwd: dir, encoding: 'utf8' })
    expect(uncommitted()).toBe('')
    // A cache hit records a new origin and queues nothing, so no job's commit will carry it.
    const hit = svc.annotate(spec(['alien']), at({ toolId: 'tool-2' }))
    expect(hit.note).toBe('Pictures: 1 already made — shown in their cards.')
    hit.start()
    await svc.whenIdle()
    expect(readOrigins(dir)[originKey({ chatFile: 'c.jsonl', toolId: 'tool-2', elementId: 'img-0' })]).toBe(keyOf(s, 0))
    expect(uncommitted()).toBe('')
    expect(execFileSync('git', ['log', '-1', '--name-only', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n')).toEqual(['images: 1 shown again', '', 'images/index.json'])
    expect(posts()).toHaveLength(1)
    expect(logs.some(l => l.includes('history commit'))).toBe(false)
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
    // ComfyUI queued nothing, so there is nothing to cancel.
    expect(cancels()).toEqual([])
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

describe('ImageService: how long a probe is trusted', () => {
  const stats = () => mock!.calls.filter(c => c.path === '/system_stats').length
  /** One picture through the worker at the clock's current time; resolves to its terminal event. */
  async function paint(svc: ImageService, prompt: string, toolId: string): Promise<UiImageEvent> {
    const s = spec([prompt])
    svc.annotate(s, at({ toolId })).start()
    const key = keyOf(s, 0)
    await until(() => terminal(key), `the job for "${prompt}"`)
    await svc.whenIdle()
    return events.filter(e => e.key === key).at(-1)!
  }

  it('a failed probe is reused for 60 s, then asked again', async () => {
    mock = await startMockComfy({ stats: '404' })
    let clock = 1_000_000
    const svc = start({ now: () => clock })
    expect(await svc.probe()).toMatchObject({ ok: false })
    expect(stats()).toBe(1)
    mock.mode.stats = 'ok'
    clock += 60_000 - 1
    expect(await paint(svc, 'alien one', 't1')).toMatchObject({ status: 'failed', reason: `${mock.url} answered /system_stats with HTTP 404 — is that ComfyUI?` })
    expect(stats()).toBe(1)
    expect(posts()).toHaveLength(0)
    clock += 1
    expect((await paint(svc, 'alien two', 't2')).status).toBe('done')
    expect(stats()).toBe(2)
  })

  it('a good probe is reused for 10 minutes, then asked again', async () => {
    mock = await startMockComfy()
    let clock = 1_000_000
    const svc = start({ now: () => clock })
    expect(await svc.probe()).toMatchObject({ ok: true })
    expect(stats()).toBe(1)
    mock.mode.stats = '404'
    clock += 10 * 60_000 - 1
    expect((await paint(svc, 'alien one', 't1')).status).toBe('done')
    expect(stats()).toBe(1)
    clock += 1
    expect(await paint(svc, 'alien two', 't2')).toMatchObject({ status: 'failed', reason: `${mock.url} answered /system_stats with HTTP 404 — is that ComfyUI?` })
    expect(stats()).toBe(2)
    expect(posts()).toHaveLength(1)
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

  it('shutdown stays within its 3 s bound when ComfyUI stops answering, with every record already failed', async () => {
    // /interrupt and /queue each hang past their own 2 s timeout: the cancel alone would take 4 s.
    mock = await startMockComfy({ neverFinish: true, delay: { '/interrupt': 10_000, '/queue': 10_000 } })
    const svc = start()
    const s = spec(['alien one', 'alien two'])
    svc.annotate(s, at()).start()
    await until(() => events.some(e => e.status === 'running'), 'running')
    const t0 = Date.now()
    await svc.shutdown()
    const took = Date.now() - t0
    expect(took).toBeGreaterThanOrEqual(2900)
    expect(took).toBeLessThan(3600)
    expect(logs).toContain('[imagegen] shutdown passed its 3 s bound; leaving the rest')
    for (const i of [0, 1]) {
      expect(readSidecar(dir, keyOf(s, i))).toMatchObject({ status: 'failed', reason: STOPPED_REASON })
      expect(events).toContainEqual({ type: 'ui.image', key: keyOf(s, i), slug, status: 'failed', reason: STOPPED_REASON })
    }
    // the cancel did go out, by id; it is the answer that never came
    const id = (posts()[0].body as { prompt_id: string }).prompt_id
    expect(mock.calls.find(c => c.path === '/interrupt')?.body).toEqual({ prompt_id: id })
  }, 15_000)

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

describe('ImageService: nothing of ours is left on ComfyUI', () => {
  it('three failed /history polls withdraw the prompt before the next job goes out', async () => {
    mock = await startMockComfy({ pendingPolls: 5 })
    let dropped = 0
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      // A LAN blip: the prompt is queued on the server, but three polls in a row get no answer.
      if (String(url).includes('/history/') && dropped < 3) { dropped++; throw new TypeError('fetch failed') }
      return fetch(url, init)
    }) as typeof fetch
    const svc = start({ fetchFn })
    const s = spec(['alien one', 'alien two'])
    svc.annotate(s, at()).start()
    await until(() => terminal(keyOf(s, 0)) && terminal(keyOf(s, 1)), 'both jobs')
    const first = (posts()[0].body as { prompt_id: string }).prompt_id
    expect(events.find(e => e.key === keyOf(s, 0) && e.status !== 'running')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^ComfyUI did not answer at .* \(fetch failed\)/) })
    expect(cancels()).toEqual([['/interrupt', { prompt_id: first }], ['/queue', { delete: [first] }]])
    expect(mock.maxInFlight).toBe(1)
  })

  it('a POST whose answer was lost withdraws the id it sent before the next job goes out', async () => {
    mock = await startMockComfy({ pendingPolls: 5 })
    let lost = false
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(url, init)
      // ComfyUI queued the prompt, but its answer did not arrive in time.
      if (String(url).endsWith('/prompt') && !lost) { lost = true; throw new DOMException('The operation timed out.', 'TimeoutError') }
      return res
    }) as typeof fetch
    const svc = start({ fetchFn })
    const s = spec(['alien one', 'alien two'])
    svc.annotate(s, at()).start()
    await until(() => terminal(keyOf(s, 0)) && terminal(keyOf(s, 1)), 'both jobs')
    const first = (posts()[0].body as { prompt_id: string }).prompt_id
    expect(events.find(e => e.key === keyOf(s, 0) && e.status !== 'running')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^ComfyUI did not answer at .* \(timeout\)/) })
    expect(cancels()).toEqual([['/interrupt', { prompt_id: first }], ['/queue', { delete: [first] }]])
    expect(mock.maxInFlight).toBe(1)
    expect(events.find(e => e.key === keyOf(s, 1) && e.status !== 'running')?.status).toBe('done')
  })

  it('shutdown while a finished picture is committing cancels nothing', async () => {
    mock = await startMockComfy({ pendingPolls: 0 })
    let stopping: Promise<void> | null = null
    const svc: ImageService = start({ emit: e => { events.push(e); if (e.status === 'done') stopping ??= svc.shutdown() } })
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    await until(() => stopping !== null, 'the picture')
    await stopping
    expect(cancels()).toEqual([])
    expect(readSidecar(dir, keyOf(s, 0))).toMatchObject({ status: 'done' })
  })

  it('shutdown while a refused job is committing cancels nothing: ComfyUI never took it', async () => {
    mock = await startMockComfy({ refuse: { error: { message: 'bad' }, node_errors: {} } })
    let stopping: Promise<void> | null = null
    const svc: ImageService = start({ emit: e => { events.push(e); if (e.status === 'failed') stopping ??= svc.shutdown() } })
    svc.annotate(spec(['alien']), at()).start()
    await until(() => stopping !== null, 'the refusal')
    await stopping
    expect(cancels()).toEqual([])
  })

  it('shutdown during the POST waits for its answer, so the prompt is cancelled once it is there to cancel', async () => {
    mock = await startMockComfy({ pendingPolls: 0, delay: { '/prompt': 200 } })
    const svc = start()
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    await until(() => posts().length === 1, 'the POST')
    await svc.shutdown()
    await svc.whenIdle() // the POST has been answered: the server holds the prompt unless it was cancelled after that
    const id = (posts()[0].body as { prompt_id: string }).prompt_id
    expect(cancels()).toEqual([['/interrupt', { prompt_id: id }], ['/queue', { delete: [id] }]])
    // Cancelled after the server queued it: it never runs.
    const history = await (await fetch(`${mock.url}/history/${id}`)).json()
    expect(history).toEqual({})
    expect(readSidecar(dir, keyOf(s, 0))).toMatchObject({ status: 'failed', reason: STOPPED_REASON })
  })

  it('shutdown during the POST to an older ComfyUI cancels the id the server answered with, not the one sent', async () => {
    mock = await startMockComfy({ neverFinish: true, ignoreClientId: true, delay: { '/prompt': 200 } })
    const svc = start()
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    await until(() => posts().length === 1, 'the POST')
    await svc.shutdown()
    await svc.whenIdle()
    const sent = (posts()[0].body as { prompt_id: string }).prompt_id
    const sc = readSidecar(dir, keyOf(s, 0))!
    expect(sc.comfy.promptId).not.toBe(sent)
    expect(cancels()).toEqual([['/interrupt', { prompt_id: sc.comfy.promptId }], ['/queue', { delete: [sc.comfy.promptId] }]])
  })
})

describe('ImageService: links and special files the model planted', () => {
  // The model can write anywhere in a project, links included (gradeProjectCall). The engine's own writes stay in it.
  let outside: string, victim: string
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'cynco-imagegen-outside-'))
    victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'ORIGINAL\n', 'utf8')
  })
  afterEach(() => { rmSync(outside, { recursive: true, force: true }) })

  it.skipIf(!CAN_SYMLINK_FILES)('a .gitignore linked out of the project: every picture off with the reason, the file it points at untouched', async () => {
    mock = await startMockComfy()
    rmSync(join(dir, '.gitignore'))
    symlinkSync(victim, join(dir, '.gitignore'))
    const s = spec(['alien'])
    const pics = start().annotate(s, at())
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: '.gitignore in the project is a link or not a regular file; the engine will not write through it — refused' })
    pics.start()
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL\n')
    expect(existsSync(join(dir, 'images'))).toBe(false)
  })

  it('an images folder linked out of the project: off with the reason, nothing written there', async () => {
    mock = await startMockComfy()
    symlinkSync(outside, join(dir, 'images'), 'junction')
    const s = spec(['alien'])
    const pics = start().annotate(s, at())
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: 'images/ in the project is a link; pictures are written only into a real folder inside it — refused' })
    expect(pics.note).toMatch(/^Pictures: not generated — images\/ in the project is a link/)
    pics.start()
    expect(readdirSync(outside)).toEqual(['victim.txt'])
    expect(posts()).toHaveLength(0)
  })

  it('a .cynco/tmp folder linked out of the project: off with the reason, nothing written there', async () => {
    mock = await startMockComfy()
    mkdirSync(join(dir, '.cynco'), { recursive: true })
    symlinkSync(outside, join(dir, '.cynco', 'tmp'), 'junction')
    const s = spec(['alien'])
    start().annotate(s, at()).start()
    expect(imageOf(s, 0)).toEqual({ status: 'off', reason: '.cynco/tmp/ in the project is a link; pictures are written only into a real folder inside it — refused' })
    expect(readdirSync(outside)).toEqual(['victim.txt'])
  })

  it.skipIf(!CAN_SYMLINK_FILES)('a link planted at the download\'s .part name is replaced, never written through', async () => {
    mock = await startMockComfy()
    const svc = start()
    const s = spec(['alien'])
    const pics = svc.annotate(s, at())
    const key = keyOf(s, 0)
    mkdirSync(join(dir, '.cynco', 'tmp'), { recursive: true })
    symlinkSync(victim, partPath(dir, key))
    pics.start()
    await until(() => terminal(key), 'the job')
    expect(events.at(-1)?.status).toBe('done')
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL\n')
    expect(lstatSync(pngPath(dir, key)).isFile()).toBe(true)
    expect(Buffer.from(readFileSync(pngPath(dir, key))).equals(PNG_1X1)).toBe(true)
  })

  it('an images folder swapped for a link while the job runs: the job fails with the reason, nothing lands outside', async () => {
    mock = await startMockComfy({ pendingPolls: 10 })
    const svc = start()
    const s = spec(['alien'])
    svc.annotate(s, at()).start()
    const key = keyOf(s, 0)
    await until(() => events.some(e => e.status === 'running'), 'running')
    renameSync(join(dir, 'images'), join(dir, 'images-moved'))
    symlinkSync(outside, join(dir, 'images'), 'junction')
    await until(() => terminal(key), 'the job')
    expect(events.at(-1)).toMatchObject({ status: 'failed', reason: 'images/ in the project is a link; pictures are written only into a real folder inside it — refused' })
    await svc.whenIdle()
    expect(readdirSync(outside)).toEqual(['victim.txt'])
  })

  it.skipIf(process.platform === 'win32')('a FIFO planted at images/index.json: annotate returns at once and the index is rewritten as a file', async () => {
    mock = await startMockComfy()
    mkdirSync(join(dir, 'images'), { recursive: true })
    execFileSync('mkfifo', [join(dir, 'images', 'index.json')])
    const s = spec(['alien'])
    start().annotate(s, at())
    expect(imageOf(s, 0)).toMatchObject({ status: 'queued' })
    expect(lstatSync(join(dir, 'images', 'index.json')).isFile()).toBe(true)
    expect(readOrigins(dir)[originKey({ chatFile: 'c.jsonl', toolId: 'tool-1', elementId: 'img-0' })]).toBe(keyOf(s, 0))
  })
})
