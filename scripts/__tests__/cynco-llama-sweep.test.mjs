// Which llama-server processes a mission dispatch may kill (F214).
//
// The dispatch and the driver's teardown both killed every llama-server.exe whose
// path is under ~/.cynco, on the stated ground that only the chat model's server
// lives there. Since 2026-11-08 the embedding service is that same binary from
// that same folder (`--embeddings --port 9165`), so every dispatch took semantic
// search down and nothing brought it back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isChatModelServer, parseServerRows, chatModelServerPids } from '../cynco-llama-sweep.mjs'

const CYNCO_BIN = 'C:\\Users\\civer\\.cynco\\bin\\llama-server.exe'
const chat = { pid: 4242, path: CYNCO_BIN, commandLine: `"${CYNCO_BIN}" -m C:\\Users\\civer\\.cynco\\models\\Qwen3.8-27B.gguf --port 8081 --ctx-size 131072 --jinja` }
const embed = { pid: 24996, path: CYNCO_BIN, commandLine: `"${CYNCO_BIN}"  --embeddings -m "C:\\Users\\civer\\.cynco\\models\\nomic-embed-text-v1.5.f16.gguf" --host 127.0.0.1 --port 9165 --pooling mean -c 2048` }
const brain = { pid: 5151, path: 'C:\\Users\\civer\\.cynco\\bin-brain\\llama-server.exe', commandLine: '"C:\\Users\\civer\\.cynco\\bin-brain\\llama-server.exe" -m x.gguf --port 8081' }
const ollama = { pid: 777, path: 'C:\\Users\\civer\\AppData\\Local\\Programs\\Ollama\\lib\\ollama\\llama-server.exe', commandLine: 'llama-server.exe --model blob --port 51234' }
const ollamaEmbed = { pid: 778, path: ollama.path, commandLine: 'llama-server.exe --model blob --embedding --port 51235' }

describe('isChatModelServer', () => {
  it('the chat model\'s server under ~/.cynco is one, from bin or bin-brain', () => {
    expect(isChatModelServer(chat)).toBe(true)
    expect(isChatModelServer(brain)).toBe(true)
  })

  it('the embedding service is not, though it is the same binary from the same folder', () => {
    expect(isChatModelServer(embed)).toBe(false)
    // llama.cpp accepts both spellings.
    expect(isChatModelServer({ ...embed, commandLine: embed.commandLine.replace('--embeddings', '--embedding') })).toBe(false)
  })

  it('a server that is not under ~/.cynco is never one: Ollama puts its own straight back', () => {
    expect(isChatModelServer(ollama)).toBe(false)
    expect(isChatModelServer(ollamaEmbed)).toBe(false)
  })

  it('a row with no path or no command line (access denied) is not killed on a guess', () => {
    expect(isChatModelServer({ pid: 1, path: '', commandLine: '' })).toBe(false)
    expect(isChatModelServer({ pid: 1, path: CYNCO_BIN, commandLine: '' })).toBe(false)
  })

  it('a path that merely contains the word is not under the folder', () => {
    expect(isChatModelServer({ pid: 1, path: 'C:\\tools\\my.cynco.backup\\llama-server.exe', commandLine: 'llama-server.exe --port 8081' })).toBe(false)
  })
})

describe('parseServerRows', () => {
  it('reads pid|path|command line, one per line, whatever the line ending; a command line may contain the separator', () => {
    const out = `4242|${CYNCO_BIN}|"${CYNCO_BIN}" -m a|b.gguf --port 8081\r\n24996|${CYNCO_BIN}|${embed.commandLine}\r\n\r\n`
    const rows = parseServerRows(out)
    expect(rows.map(r => r.pid)).toEqual([4242, 24996])
    expect(rows[0].commandLine).toContain('a|b.gguf')
    expect(rows[1].path).toBe(CYNCO_BIN)
  })

  it('a line that is not a row is dropped', () => {
    expect(parseServerRows('hello\nabc|x|y\n')).toEqual([])
  })
})

describe('chatModelServerPids', () => {
  it('lists the chat servers and leaves the embedding service and Ollama alone', () => {
    const rows = [chat, embed, brain, ollama, ollamaEmbed]
    const out = rows.map(r => `${r.pid}|${r.path}|${r.commandLine}`).join('\r\n')
    expect(chatModelServerPids({ platform: 'win32', run: () => out })).toEqual([4242, 5151])
  })

  it('off Windows there is nothing to list', () => {
    expect(chatModelServerPids({ platform: 'linux', run: () => { throw new Error('must not be asked') } })).toEqual([])
  })

  it('a listing that fails throws: a dispatch must not go ahead blind', () => {
    expect(() => chatModelServerPids({ platform: 'win32', run: () => { throw new Error('powershell is gone') } })).toThrow(/powershell is gone/)
  })
})

describe('both sweeps use it', () => {
  it('dispatch-mission.sh asks the sweep script, refuses when it cannot, and no longer matches by path alone', () => {
    const sh = readFileSync('scripts/dispatch-mission.sh', 'utf-8')
    expect(sh).toMatch(/bun scripts\/cynco-llama-sweep\.mjs/)
    expect(sh).toMatch(/refusing to dispatch blind/)
    expect(sh).not.toMatch(/ExecutablePath -like/)
  })

  it('the driver\'s teardown takes its llama-server roots from the same function', () => {
    const driver = readFileSync('scripts/cynco-mission-driver.mjs', 'utf-8')
    expect(driver).toMatch(/import \{ chatModelServerPids \} from '\.\/cynco-llama-sweep\.mjs'/)
    expect(driver).toMatch(/chatModelServerPids\(\)/)
    expect(driver).not.toMatch(/ExecutablePath -like/)
  })
})
