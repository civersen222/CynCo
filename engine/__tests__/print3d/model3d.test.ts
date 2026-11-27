/**
 * The Model3D component across the engine: the validator keeps only a model
 * path of the project (`projectModelPath`), the annotator gives it the
 * engine-only `model` state in a project chat (off elsewhere) and takes the
 * paths out of its props, the tool result names a model file that is not
 * there, and the file route serves an .stl or .3mf as a download under its
 * fixed type with the same guards as a picture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { validateSpec, projectModelPath, PROJECT_MODEL_PATH_RE } from '../../genui/spec.js'
import { annotateFileImages, fileModels, MODELS_ONLY_REASON, servedProjectFile } from '../../imagegen/store.js'
import { ImageService } from '../../imagegen/service.js'
import { createProject } from '../../projects/layout.js'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import type { IngestEvent } from '../../projects/ingest.js'
import { asciiStl, binaryStl, box } from './fixtures.js'

const spec = (props: Record<string, unknown>) => ({ root: 'm', elements: { m: { type: 'Model3D', props } } })

describe('validateSpec: Model3D', () => {
  it('keeps the .stl of a model in the project and a model file to download, in any letter case', () => {
    const r = validateSpec(spec({ Src: './models/hook/hook.stl', DOWNLOAD: 'models/hook/hook.3mf', alt: 'Hook' }))
    expect(r.errors).toEqual([])
    expect(r.spec!.elements.m).toEqual({ type: 'Model3D', props: { src: 'models/hook/hook.stl', download: 'models/hook/hook.3mf', alt: 'Hook' } })
  })

  it('drops the element without an .stl, and a download that is not a model file of the project, saying the rule', () => {
    const none = validateSpec({ root: 'g', elements: { g: { type: 'Stack', children: ['m', 't'] }, m: { type: 'Model3D', props: { src: 'models/hook/hook.3mf', alt: 'Hook' } }, t: { type: 'Text', props: { content: 'x' } } } })
    expect(none.spec!.elements.m).toBeUndefined()
    expect(none.errors.join('\n')).toContain('m.src: "models/hook/hook.3mf" is not the .stl of a model in the project (MakeModel writes models/<name>/<name>.stl; build the model first) — dropped')
    expect(none.errors.join('\n')).toContain('m (Model3D): missing src — the element was dropped')
    const badDl = validateSpec(spec({ src: 'models/a/a.stl', download: '../../secret.3mf', alt: 'A' }))
    expect(badDl.spec!.elements.m.props).toEqual({ src: 'models/a/a.stl', alt: 'A' })
    expect(badDl.errors[0]).toMatch(/^m\.download: "\.\.\/\.\.\/secret\.3mf" is not a model file in the project/)
  })

  it('projectModelPath is the image rule\'s characters with .stl or .3mf', () => {
    expect(projectModelPath('models/my part (v2)/part.STL')).toBe('models/my part (v2)/part.STL')
    for (const bad of ['', '/abs.stl', 'C:/x.stl', '.cynco/x.stl', 'a/../b.stl', 'a\\b.stl', 'x.obj', 'x.stl?v=2', 'é.stl']) expect(projectModelPath(bad), bad).toBeNull()
    expect(PROJECT_MODEL_PATH_RE.source).toContain('(?:stl|3mf)')
  })
})

describe('annotateFileImages: Model3D', () => {
  const validated = () => validateSpec(spec({ src: 'models/hook/hook.stl', download: 'models/hook/hook.3mf', alt: 'Hook' })).spec!

  it('in a project chat: the file state with the slug, the paths taken out of props; outside one: off with the reason', () => {
    const s = validated()
    expect(annotateFileImages(s, 'zoo')).toEqual([{ id: 'm', path: 'models/hook/hook.stl', kind: 'model' }, { id: 'm', path: 'models/hook/hook.3mf', kind: 'model' }])
    expect(s.elements.m).toEqual({ type: 'Model3D', props: { alt: 'Hook' }, model: { status: 'file', slug: 'zoo', path: 'models/hook/hook.stl', download: 'models/hook/hook.3mf' } })
    expect(annotateFileImages(s, 'zoo')).toEqual([]) // again: a no-op
    const t = validated()
    annotateFileImages(t, null)
    expect(t.elements.m.model).toEqual({ status: 'off', reason: MODELS_ONLY_REASON })
    expect(MODELS_ONLY_REASON).toBe('3D models are shown in project chats only')
  })

  it('fileModels checks the path again: an element the validator never saw with a bad path gets no state', () => {
    const raw = { root: 'm', elements: { m: { type: 'Model3D', props: { src: '../x.stl' } } } }
    expect(fileModels(raw as never)).toEqual([])
  })
})

let home: string, slug: string, dir: string, outside: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-model3d-'))
  outside = mkdtempSync(join(tmpdir(), 'cynco-model3d-out-'))
  slug = createProject(home, { name: 'Zoo' }).slug
  dir = join(home, slug)
  mkdirSync(join(dir, 'models', 'hook'), { recursive: true })
  writeFileSync(join(dir, 'models', 'hook', 'hook.stl'), binaryStl(box(0, 0, 0, 10, 10, 10)))
  writeFileSync(join(dir, 'models', 'hook', 'ascii.stl'), asciiStl(box(0, 0, 0, 1, 1, 1)))
  writeFileSync(join(dir, 'models', 'hook', 'hook.3mf'), zipSync({ '3D/3dmodel.model': new TextEncoder().encode('<model/>') }))
  writeFileSync(join(dir, 'models', 'hook', 'fake.stl'), '<html><script>alert(1)</script></html>')
  writeFileSync(join(dir, 'models', 'hook', 'fake.3mf'), 'not a zip')
  writeFileSync(join(outside, 'secret.stl'), binaryStl(box(0, 0, 0, 1, 1, 1)))
  // A host that cannot make a junction answers 404 for the path below all the same: no link, no file.
  try { symlinkSync(outside, join(dir, 'models', 'elsewhere'), 'junction') } catch (e) { console.log(`[model3d.test] no junction on this host: ${(e as Error).message}`) }
})
afterAll(() => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })

describe('servedProjectFile: model files', () => {
  it('serves an .stl and a .3mf under their fixed types as a download named after the file', () => {
    const stl = servedProjectFile(home, slug, 'models/hook/hook.stl')
    expect([stl.status, stl.type, stl.download, stl.bytes?.length]).toEqual([200, 'model/stl', 'hook.stl', 84 + 12 * 50])
    expect(servedProjectFile(home, slug, 'models/hook/ascii.stl').status).toBe(200)
    const mf = servedProjectFile(home, slug, 'models/hook/hook.3mf')
    expect([mf.status, mf.type, mf.download]).toEqual([200, 'model/3mf', 'hook.3mf'])
    expect(servedProjectFile(home, slug, 'models/hook/missing.stl')).toEqual({ status: 404, json: { error: 'no such file' } })
  })

  it('refuses bytes that are not what the name says, a bad path, and a link out of the project', () => {
    expect(servedProjectFile(home, slug, 'models/hook/fake.stl')).toEqual({ status: 415, json: { error: 'models/hook/fake.stl is not a STL file; refused' } })
    expect(servedProjectFile(home, slug, 'models/hook/fake.3mf')).toEqual({ status: 415, json: { error: 'models/hook/fake.3mf is not a 3MF file; refused' } })
    expect(servedProjectFile(home, slug, 'models/../x.stl')).toEqual({ status: 400, json: { error: 'bad file path' } })
    expect(servedProjectFile(home, slug, 'models/hook/x.obj')).toEqual({ status: 400, json: { error: 'bad file path' } })
    if (servedProjectFile(home, slug, 'models/elsewhere/secret.stl').status !== 200) {
      expect(servedProjectFile(home, slug, 'models/elsewhere/secret.stl')).toEqual({ status: 404, json: { error: 'no such file' } })
    } else {
      throw new Error('a link out of the project was served')
    }
  })
})

describe('the tool result names a model file that is not there', () => {
  it('Models: … build the model with MakeModel first', () => {
    const svc = new ImageService({ env: {}, emit: () => {}, log: () => {} })
    const s = validateSpec(spec({ src: 'models/gone/gone.stl', download: 'models/hook/hook.3mf', alt: 'Gone' })).spec!
    const a = svc.annotate(s, { project: { dir, slug, chatFile: 'c.jsonl' }, toolId: 't1', surfaceId: 's1', cutOff: false })
    expect(a.note).toBe('Models: not in the project — models/gone/gone.stl; build the model with MakeModel first (a .3mf exists only after a slice).')
    expect(s.elements.m.model).toEqual({ status: 'file', slug, path: 'models/gone/gone.stl', download: 'models/hook/hook.3mf' })
    void svc.shutdown()
  })
})

describe('GET /api/projects/:slug/files/<model> over HTTP', () => {
  it('goes out as an attachment with the inert headers, behind the token', async () => {
    const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-model3d-tokens-'))
    const tokens = loadOrCreateTokens(tokenDir)
    const server = new DashboardServer({ port: 0, tokens, deps: { projects: { home, embed: null, embedModel: 'stub', emit: (_e: IngestEvent) => {}, contextLength: 8192 } } })
    try {
      const deadline = Date.now() + 2000
      while (server.getPort() === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
      const url = `http://127.0.0.1:${server.getPort()}/api/projects/${slug}/files/models/hook/hook.3mf`
      expect((await fetch(url)).status).toBe(401)
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.tokenFor('inference')}` } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('model/3mf')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="hook.3mf"')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      server.stop()
      rmSync(tokenDir, { recursive: true, force: true })
    }
  })
})
