// scripts/cynco-llama-sweep.mjs
// Which llama-server processes a mission dispatch may kill (F214).
//
// A dispatch starts from a fresh engine, so it kills the chat model's server
// left by the last one (scripts/dispatch-mission.sh), and the driver does the
// same when a teardown ends in "kill the tree by hand" (cynco-mission-driver.mjs).
// Both used to select every llama-server.exe whose path is under ~/.cynco, on the
// ground that nothing else lives there. Since 2026-11-08 the embedding service is
// that same binary from that same folder (`--embeddings --port 9165`,
// scripts/run-embed-server.cmd), so every dispatch took semantic search down with
// it and nothing brought it back. This is the one selector both use.
//
// A chat model's server is: llama-server under ~/.cynco (bin/ for the loop,
// bin-brain/ for the activations tier), and not an embedding server. Ollama ships
// a llama-server.exe of its own under AppData/Local/Programs/Ollama and puts it
// straight back when killed: it is never selected. A process whose path or
// command line cannot be read is not killed on a guess.
//
//   bun scripts/cynco-llama-sweep.mjs            the PIDs to kill, one per line
//   bun scripts/cynco-llama-sweep.mjs --explain  every llama-server.exe and what would happen to it
//
// Exit 1 when the process list cannot be read: a dispatch must not go ahead blind.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** `--embedding` and `--embeddings` are both accepted by llama.cpp. */
const EMBEDDING_FLAG = /(^|\s)--embeddings?(\s|$)/

/** @param {{ path: string, commandLine: string }} row */
export function isChatModelServer(row) {
  if (!row.path || !row.commandLine) return false
  if (!/[\\/]\.cynco[\\/]/i.test(row.path)) return false
  return !EMBEDDING_FLAG.test(row.commandLine)
}

/** Why a row is kept or killed, for --explain. */
export function verdict(row) {
  if (isChatModelServer(row)) return 'kill: a chat model server under ~/.cynco'
  if (!row.path || !row.commandLine) return 'keep: its path or command line could not be read'
  if (!/[\\/]\.cynco[\\/]/i.test(row.path)) return 'keep: not under ~/.cynco'
  return 'keep: the embedding service'
}

/** `pid|path|command line` per line; the command line may itself contain `|`. */
export function parseServerRows(out) {
  const rows = []
  for (const line of String(out).split(/\r?\n/)) {
    const a = line.indexOf('|')
    const b = line.indexOf('|', a + 1)
    if (a < 0 || b < 0) continue
    const pid = Number(line.slice(0, a))
    if (!Number.isInteger(pid) || pid <= 0) continue
    rows.push({ pid, path: line.slice(a + 1, b), commandLine: line.slice(b + 1) })
  }
  return rows
}

const LIST = "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)\" }"

function powershell() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', LIST], { encoding: 'utf-8', windowsHide: true })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`powershell exited ${r.status}: ${String(r.stderr).trim().split('\n')[0]}`)
  return r.stdout ?? ''
}

/** Every llama-server.exe on this machine. Throws when the list cannot be read. */
export function llamaServerRows({ platform = process.platform, run = powershell } = {}) {
  if (platform !== 'win32') return []
  return parseServerRows(run())
}

/** The PIDs a dispatch may kill. Throws when the list cannot be read. */
export function chatModelServerPids(deps = {}) {
  return llamaServerRows(deps).filter(isChatModelServer).map(r => r.pid)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--explain')) {
      for (const r of llamaServerRows()) console.log(`${r.pid}  ${verdict(r)}  ${r.commandLine.slice(0, 140)}`)
    } else {
      for (const pid of chatModelServerPids()) console.log(pid)
    }
  } catch (e) {
    console.error(`[llama-sweep] could not list llama-server processes: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
