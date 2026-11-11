// Apps that use Ollama (docs/decisions/2026-11-11-local-llm-apps.md, slice 4).
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
import { freeOllamaForCynco, findOllamaApps, ollamaLoaded } from '../../apps/ollama.js'
import { loadOllamaApps, loadRegistry } from '../../apps/registry.js'

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

describe('findOllamaApps: which project uses a model', () => {
  it('a project whose own files name the model beside Ollama is the app, whatever the tag spelling', () => {
    const sp = project('screenplayer', 'screenplayer/documents/ai/backend.py', 'DEFAULT_BASE_URL = "http://localhost:11434"\nDEFAULT_MODEL = "qwen3.6:27b"\n')
    const gilded = project('civkings', 'gilded/saga/narrator.py', 'MODEL_URL = "http://127.0.0.1:11434/v1/chat/completions"\nMODEL_NAME = "qwen3.6"\n')
    const notes = project('notes', 'README.md', 'I like qwen3.6:27b')
    const roots = [sp, gilded, notes]
    expect(findOllamaApps('qwen3.6:27b', roots).map(a => a.name)).toEqual(['screenplayer'])
    // `qwen3.6` in a config is what Ollama lists as `qwen3.6:latest`.
    expect(findOllamaApps('qwen3.6:latest', roots).map(a => a.name)).toEqual(['civkings'])
    expect(findOllamaApps('llama3.2:latest', roots)).toEqual([])
  })

  it('does not look inside dependencies, virtual environments or version control', () => {
    const dir = project('game', 'node_modules/x/config.js', 'ollama 11434 qwen3.6:27b')
    project('game', '.git/config', 'ollama 11434 qwen3.6:27b')
    project('game', '.venv/lib/x.py', 'ollama 11434 qwen3.6:27b')
    expect(findOllamaApps('qwen3.6:27b', [dir])).toEqual([])
  })
})

describe('freeOllamaForCynco', () => {
  const ctx = (said: string[], roots: string[] = []) => ({ url, registryFile: registry, roots, by: 'the chat engine', say: (m: string) => said.push(m), log: () => {} })

  it('asks Ollama to unload what it holds, says which app each model belongs to, and remembers the app', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const sp = project('screenplayer', 'screenplayer/config.py', 'SCREENPLAYER_LLM_URL = "http://localhost:11434"\nmodel = "qwen3.6:27b"\n')
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said, [sp]))).toBe(1)
    expect(unloads).toEqual(['qwen3.6:27b'])
    expect(await ollamaLoaded(url)).toEqual([])
    expect(said).toEqual(['Ollama held qwen3.6:27b (17.0 GB of GPU memory) for screenplayer. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on screenplayer\'s next request.'])
    expect(loadOllamaApps(registry)).toMatchObject([{ id: 'screenplayer', name: 'screenplayer', root: sp, models: ['qwen3.6:27b'], manage: true }])
    // Known now: the second time nothing is searched.
    loaded = [{ name: 'qwen3.6:27b', size_vram: 17 * GB }]
    expect(await freeOllamaForCynco(ctx([], []))).toBe(1)
  })

  it('a model no project of the owner\'s names is still unloaded, and said by its own name', async () => {
    await standInOllama([{ name: 'mystery:7b', size_vram: 5 * GB }])
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(1)
    expect(said).toEqual(['Ollama held mystery:7b (5.0 GB of GPU memory); none of your projects was found using it. CynCo asked Ollama to unload it for the chat engine; Ollama loads it again on the next request for it.'])
  })

  it('two apps that use the same model are both named', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    const a = project('screenplayer', 'config.py', 'ollama 11434 "qwen3.6:27b"')
    const b = project('wagetheory', 'settings.py', 'OLLAMA_HOST model "qwen3.6:27b"')
    const said: string[] = []
    await freeOllamaForCynco(ctx(said, [a, b]))
    expect(said[0]).toContain('for screenplayer or wagetheory')
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
    expect(await freeOllamaForCynco({ registryFile: registry, roots: [], by: 'x', say: () => {}, log: () => {} })).toBe(1)
  })

  it('nothing loaded, or no Ollama: nothing is said and nothing is searched', async () => {
    await standInOllama([])
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(0)
    expect(await freeOllamaForCynco({ ...ctx(said), url: 'http://127.0.0.1:1' })).toBe(0)
    expect(said).toEqual([])
  })

  it('an unload Ollama refuses is said, counted as not unloaded, and does not throw', async () => {
    await standInOllama([{ name: 'qwen3.6:27b', size_vram: 17 * GB }])
    refuseUnload = true
    const said: string[] = []
    expect(await freeOllamaForCynco(ctx(said))).toBe(0)
    expect(said[0]).toMatch(/^Ollama did not unload qwen3\.6:27b: HTTP 500/)
  })
})
