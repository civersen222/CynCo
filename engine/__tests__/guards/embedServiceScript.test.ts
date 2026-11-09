// The CynCo embedding service (docs/decisions/2026-11-08-embeddings-own-llama-server.md):
// the start script, the services row and the README must name the same server.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cmd = readFileSync(join(root, 'scripts', 'run-embed-server.cmd'), 'utf8')
const services = readFileSync(join(root, 'scripts', 'cynco-services.ps1'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')

describe('embed service', () => {
  it('serves embeddings on 127.0.0.1:9165 from the engine\'s own llama-server, CPU only, mean pooling for nomic', () => {
    expect(cmd).toContain('.cynco\\bin\\llama-server.exe')
    expect(cmd).toContain('--embeddings')
    expect(cmd).toContain('--host 127.0.0.1 --port 9165')
    expect(cmd).toContain('--pooling mean')
    expect(cmd).toContain('-ngl 0')
    expect(cmd).toContain('nomic-embed-text-v1.5.f16.gguf')
  })
  it('is a registered CynCo service the services script can start, stop and register', () => {
    expect(services).toMatch(/Name = 'embed';\s+Task = 'CynCo embed server';\s+Match = 'llama-server\.\*--embeddings'/)
    expect(services).toContain("scripts\\run-embed-server.cmd")
    expect(services).toContain('127.0.0.1:9165')
  })
  it('the README tells an operator the three variables that point the engines at it', () => {
    expect(readme).toContain('LOCALCODE_EMBED_BASE_URL=http://127.0.0.1:9165')
    expect(readme).toContain('LOCALCODE_EMBED_API=openai')
    expect(readme).toContain('LOCALCODE_EMBED_MODEL=nomic-embed-text')
  })
})
