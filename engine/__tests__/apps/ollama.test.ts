// Apps that use Ollama (docs/decisions/2026-11-11-local-llm-apps.md, slice 4; F218, F220).
//
// screenplayer, wagetheory and Gilded never hold CynCo's model port: they ask
// Ollama, and Ollama keeps their model in the 5090's memory. CynCo then either
// refuses to load its own model (F140) or a one-shot is deferred. These tests
// run against a stand-in Ollama on a port the OS chooses; the suite refuses the
// real one on 11434.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freeOllamaForCynco, findModelUsers, ollamaLoaded, FINDING_MAX_AGE_MS, type FreeOllamaCtx } from '../../apps/ollama.js'
import { loadOllamaApps, loadRegistry } from '../../apps/registry.js'
import type { ListedProc } from '../../apps/portTree.js'

type Loaded = { name: string; size_vram: number }
let server: Server | null = null
let url = ''
let loaded: Loaded[] = []
let unloads: string[] = []
let refuseUnload = false
let home = ''
let registry = ''

async function standInOllama(models: Loaded[]): Promise<void> {
  loaded = models
  unloads = []
  refuseUnload = false
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/ps') { res.end(JSON.stringify({ models: loaded })); return }
      if (req.method === 'POST' && req.url === '/api/generate') {
        const j = JSON.parse(body || '{}')
        if (refuseUnload) { res.statusCode = 500; res.end('{"error":"no"}'); return }
        // As Ollama does: keep_alive 0 with no prompt drops the model.
        if (j.keep_alive === 0 && j.prompt === undefined) { unloads.push(j.model); loaded = loaded.filter(m => m.name !== j.model) }
        res.end(JSON.stringify({ model: j.model, done: true, done_reason: 'unload' })); return
      }
      res.statusCode = 404; res.end('{}')
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-ollama-'))
  registry = join(home, 'apps.json')
})
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

/** A project folder whose config names an Ollama model, as the owner's apps do. */
function project(name: string, file: string, text: string): string {
  const dir = join(home, name)
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
  return dir
}
const names = (r: { projects: Array<{ name: string }> }) => r.projects.map(p => p.name)
const running = (root: string): ListedProc[] => [{ pid: 9, ppid: 1, exe: 'python.exe', commandLine: `python ${root}\\main.py` }]

const GB = 1024 ** 3

describe('ollamaLoaded', () => {
  it('lists what Ollama holds in GPU memory, and nothing for a model that is on the CPU', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }, { name: 'tiny:latest', size_vram: 0 }])
    expect(await ollamaLoaded(url)).toEqual([{ name: 'qwen3.6:27b', vramMib: 17 * 1024 }])
  })

  it('Ollama not running is nothing loaded, not an error', async () => {
    expect(await ollamaLoaded('http://127.0.0.1:1')).toEqual([])
  })
})

describe('findModelUsers: which projects name a model', () => {
  it('a project whose own files name the model beside Ollama is found, whatever the tag spelling', async () => {
    const sp = project('screenplayer', 'screenplayer/documents/ai/backend.py', 'DEFAULT_BASE_URL = "http://localhost:11434"\nDEFAULT_MODEL = "qwen3.6:27b"\n')
    const gilded = project('civkings', 'gilded/saga/narrator.py', 'MODEL_URL = "http://127.0.0.1:11434/v1/chat/completions"\nMODEL_NAME = "qwen3.6"\n')
    const notes = project('notes', 'README.md', 'I like qwen3.6:27b')
    const roots = [sp, gilded, notes]
    expect(names(await findModelUsers('qwen3.6:27b', roots))).toEqual(['screenplayer'])
    // `qwen3.6` in a config is what Ollama lists as `qwen3.6:latest`.
    expect(names(await findModelUsers('qwen3.6:latest', roots))).toEqual(['civkings'])
    expect(await findModelUsers('llama3.2:latest', roots)).toEqual({ projects: [], complete: true })
  })

  it('does not look inside dependencies, virtual environments or version control', async () => {
    const dir = project('game', 'node_modules/x/config.js', 'ollama 11434 qwen3.6:27b')
    project('game', '.git/config', 'ollama 11434 qwen3.6:27b')
    project('game', '.venv/lib/x.py', 'ollama 11434 qwen3.6:27b')
    expect((await findModelUsers('qwen3.6:27b', [dir])).projects).toEqual([])
  })

  it('CynCo\'s own repository is not one of the owner\'s apps: it names every model in its tests and docs (F220)', async () => {
    // Any checkout of CynCo, a worktree, a campaign copy or one from before this module: it has the failure log.
    const self = project('localcode-campaign', 'engine/config.ts', 'ollama qwen3.6:27b')
    writeFileSync(join(project('localcode-campaign', 'docs/x', ''), 'docs', 'cynco-failure-log.md'), '# failures')
    const sp = project('screenplayer', 'config.py', 'ollama "qwen3.6:27b"')
    expect(names(await findModelUsers('qwen3.6:27b', [self, sp]))).toEqual(['screenplayer'])
  })

  it('stops at its time budget and says the search was not finished (F220: 31 s on the real folders, inside the engine)', async () => {
    const roots = ['a', 'b', 'c', 'd'].map(n => project(n, 'config.py', 'ollama "qwen3.6:27b"'))
    let t = 0
    // Each look at the clock is a second later: the budget runs out after the first project.
    const r = await findModelUsers('qwen3.6:27b', roots, { budgetMs: 1500, now: () => (t += 1000) })
    expect(r.complete).toBe(false)
    expect(r.projects.length).toBeLessThan(4)
  })
})

describe('freeOllamaForCynco', () => {
  const ctx = (said: string[], over: Partial<FreeOllamaCtx> = {}): FreeOllamaCtx => ({
    url, registryFile: registry, roots: [], by: 'the chat engine', say: (m: string) => said.push(m), log: () => {},
    listProcesses: async () => [], ...over,
  })

  it('an app the registry knows uses the model is named, and nothing is searched', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [], ollamaApps: [{ id: 'screenplayer', name: 'screenplayer', root: 'C:\\x', models: ['qwen3.6:27b'], manage: true, source: 'by hand' }] }))
    const said: string[] = []
    let searched = 0
    expect(await freeOllamaForCynco(ctx(said, { search: async () => { searched++; return { projects: [], complete: true } } }))).toBe(1)
    expect(searched).toBe(0)
    expect(unloads).toEqual(['qwen3.6:27b'])
    expect(await ollamaLoaded(url)).toEqual([])
    expect(said).toEqual(['Ollama held qwen3.6:27b (17.0 GB of GPU memory) for screenplayer. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on screenplayer\'s next request.'])
  })

  it('the one project that names the model and is running is the app: named, and registered with that evidence', async () => {
    await standInOllama([{ name: 'qwen3.6:latest', size_vram: 17 * GB }])
    const gilded = project('civkings', 'gilded/saga/narrator.py', 'MODEL_URL = "http://127.0.0.1:11434"\nMODEL_NAME = "qwen3.6"\n')
    const sp = project('screenplayer', 'config.py', 'ollama model = "qwen3.6"')
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said, { roots: [gilded, sp], listProcesses: async () => running(gilded) }))).toBe(1)
    expect(said[0]).toBe('Ollama held qwen3.6:latest (17.0 GB of GPU memory) for civkings. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on civkings\'s next request.')
    const apps = loadOllamaApps(registry)
    expect(apps).toMatchObject([{ id: 'civkings', name: 'civkings', root: gilded, models: ['qwen3.6:latest'], manage: true }])
    expect(apps[0].source).toMatch(/names that model beside Ollama and was running/)
  })

  it('projects that name the model but are not running here are listed, not registered: who asked Ollama cannot be read', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const a = project('screenplayer', 'config.py', 'ollama 11434 "qwen3.6:27b"')
    const b = project('civkings', 'settings.py', 'OLLAMA_HOST model "qwen3.6:27b"')
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said, { roots: [a, b] }))).toBe(1)
    expect(said).toEqual(['Ollama held qwen3.6:27b (17.0 GB of GPU memory). Projects of yours that name this model: screenplayer, civkings. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on the next request for it.'])
    expect(loadOllamaApps(registry)).toEqual([])
  })

  it('two running projects that name the model are both listed and neither is registered', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const a = project('screenplayer', 'config.py', 'ollama "qwen3.6:27b"')
    const b = project('civkings', 'settings.py', 'ollama "qwen3.6:27b"')
    const said: string[] = []
    await freeOllamaForCynco(ctx(said, { roots: [a, b], listProcesses: async () => [...running(a), ...running(b)] }))
    expect(said[0]).toContain('Projects of yours that name this model: screenplayer, civkings.')
    expect(loadOllamaApps(registry)).toEqual([])
  })

  it('more than three are listed as three and a count', async () => {
    await standInOllama([{ name: 'llama3.2:latest', size_vram: 3 * GB }])
    const roots = ['chess', 'agent', 'wage', 'notes', 'tools'].map(n => project(n, 'c.py', 'ollama "llama3.2"'))
    const said: string[] = []
    await freeOllamaForCynco(ctx(said, { roots }))
    expect(said[0]).toContain('Projects of yours that name this model: chess, agent, wage and 2 more.')
  })

  it('what a search found is remembered: the second time the folders are not read again; after a week they are', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const a = project('screenplayer', 'config.py', 'ollama "qwen3.6:27b"')
    let searched = 0
    let now = Date.parse('2026-11-11T18:00:00Z')
    const c = ctx([], { roots: [a], now: () => new Date(now), search: async (m, r, o) => { searched++; return findModelUsers(m, r, o) } })
    await freeOllamaForCynco(c)
    expect(searched).toBe(1)
    expect(loadRegistry(registry).ollamaFindings).toMatchObject([{ model: 'qwen3.6:27b', projects: [{ name: 'screenplayer', root: a }] }])
    loaded = [{ name: 'qwen3.6:27b', size_vram: 17 * GB }]
    await freeOllamaForCynco(c)
    expect(searched).toBe(1)
    now += FINDING_MAX_AGE_MS + 1
    loaded = [{ name: 'qwen3.6:27b', size_vram: 17 * GB }]
    await freeOllamaForCynco(c)
    expect(searched).toBe(2)
  })

  it('a remembered finding damaged by hand does not break the unload: the bad project is dropped', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [], ollamaFindings: [{ model: 'qwen3.6:27b', at: new Date().toISOString(), projects: [{ name: 'screenplayer' }, null, { name: 'civkings', root: 'C:\\c' }] }] }))
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said, { search: async () => { throw new Error('not searched') } }))).toBe(1)
    expect(said[0]).toContain('Projects of yours that name this model: civkings.')
  })

  it('a search that ran out of time is used for this notice and not remembered', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const said: string[] = []
    await freeOllamaForCynco(ctx(said, { search: async () => ({ projects: [{ name: 'screenplayer', root: 'C:\\s' }], complete: false }) }))
    expect(said[0]).toContain('Projects of yours that name this model: screenplayer.')
    expect(loadRegistry(registry).ollamaFindings).toEqual([])
    loaded = [{ name: 'qwen3.6:27b', size_vram: 17 * GB }]
    await freeOllamaForCynco(ctx(said, { search: async () => ({ projects: [], complete: false }) }))
    expect(said[1]).toBe('Ollama held qwen3.6:27b (17.0 GB of GPU memory); CynCo did not finish looking through your projects for who uses it. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on the next request for it.')
  })

  it('a model no project names is still unloaded, and said by its own name', async () => {
    await standInOllama([{ name: 'mystery:7b', size_vram: 5 * GB }])
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(1)
    expect(said).toEqual(['Ollama held mystery:7b (5.0 GB of GPU memory); none of your projects was found naming it. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on the next request for it.'])
  })

  it('an app the owner switched off keeps its model: nothing is unloaded and CynCo says why it is short', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [], ollamaApps: [{ id: 'screenplayer', name: 'screenplayer', root: 'C:\\x', models: ['qwen3.6:27b'], manage: false, source: 'by hand' }] }))
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(0)
    expect(unloads).toEqual([])
    expect(said).toEqual(['Ollama holds qwen3.6:27b (17.0 GB of GPU memory) for screenplayer, which CynCo does not manage ("manage": false in apps.json): it stays loaded.'])
  })

  it('Ollama management switched off as a whole: Ollama is not even asked', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [], ollama: { url, manage: false } }))
    expect(await freeOllamaForCynco({ registryFile: registry, by: 'x', say: () => {}, log: () => {} })).toBe(0)
    expect(unloads).toEqual([])
  })

  it('the address comes from the registry when the caller gives none', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    writeFileSync(registry, JSON.stringify({ version: 1, apps: [], ollama: { url } }))
    expect(loadRegistry(registry).ollama).toEqual({ url, manage: true })
    expect(await freeOllamaForCynco({ registryFile: registry, roots: [], by: 'x', say: () => {}, log: () => {}, listProcesses: async () => [] })).toBe(1)
  })

  it('nothing loaded, or no Ollama: nothing is said and nothing is searched', async () => {
    await standInOllama([])
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(0)
    expect(await freeOllamaForCynco(ctx(said, { url: 'http://127.0.0.1:1' }))).toBe(0)
    expect(said).toEqual([])
  })

  it('an unload Ollama refuses is said, counted as not unloaded, and does not throw', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    refuseUnload = true
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(0)
    expect(said[0]).toMatch(/^Ollama did not unload qwen3\.6:27b: HTTP 500/)
  })

  it('a process list that cannot be read registers nobody and still unloads', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const a = project('screenplayer', 'config.py', 'ollama "qwen3.6:27b"')
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said, { roots: [a], listProcesses: async () => { throw new Error('powershell is gone') } }))).toBe(1)
    expect(loadOllamaApps(registry)).toEqual([])
    expect(said[0]).toContain('Projects of yours that name this model: screenplayer.')
  })
})
