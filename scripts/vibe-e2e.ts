// scripts/vibe-e2e.ts — manual E2E smoke test for the vibe loop.
//
// Spawns a headless engine in a temp directory, connects as a fake TUI over
// WebSocket, drives: vibe.start → answer → BUILD → vibe.task_complete, then
// verifies the requested file actually exists on disk.
//
// Usage:   bun scripts/vibe-e2e.ts
// Env:     inherits your normal engine env (LOCALCODE_MODEL, provider config).
//          LOCALCODE_WS_PORT is forced to 9260 to avoid clashing with a dev engine.
// Requires: the model backend (llama-server or Ollama) reachable per your config.
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const WS_PORT = 9260
const TASK = 'Create a file named hello.txt containing exactly the text: hello world'
const STARTUP_TIMEOUT_MS = 3 * 60_000   // model load can take a while
const TASK_TIMEOUT_MS = 15 * 60_000

const repoRoot = resolve(import.meta.dir, '..')
const workDir = mkdtempSync(join(tmpdir(), 'vibe-e2e-'))
console.log(`[e2e] Workdir: ${workDir}`)

const engine = Bun.spawn(['bun', join(repoRoot, 'engine', 'main.ts')], {
  cwd: workDir,
  env: { ...process.env, LOCALCODE_WS_PORT: String(WS_PORT) },
  stdout: 'inherit',
  stderr: 'inherit',
})

// Fix 1: track engine exit so the retry loop can fail fast instead of spinning
// for the full 3-minute startup window against a crashed process.
let engineExited = false
engine.exited.then(() => { engineExited = true })

function cleanup() {
  try { engine.kill() } catch {} // engine may already be dead
}

// Fix 3: ensure cleanup runs even on unhandled exceptions / synchronous throws
// so the child process is never orphaned (Windows zombie-process hazard).
process.on('exit', cleanup)

function fail(msg: string): never {
  console.error(`\n[e2e] FAIL: ${msg}`)
  cleanup()
  process.exit(1)
}

async function connect(): Promise<WebSocket> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    // Fix 1: if the engine already exited, retrying is pointless — fail immediately.
    if (engineExited) fail(`engine exited during startup (code ${engine.exitCode})`)
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`)
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res()
        ws.onerror = () => rej(new Error('connect failed'))
      })
      return ws
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  fail('engine WS never came up')
}

const ws = await connect()
console.log('[e2e] Connected — starting vibe loop')

// Fix 2: surface engine crashes mid-run instead of hanging until the 15-min timer.
// Cleared on the happy path (after `await done`) so normal teardown doesn't trip it.
ws.onclose = () => fail('WebSocket closed before vibe.task_complete')

let answeredDirective = false
const done = new Promise<void>((res) => {
  ws.onmessage = (msg) => {
    let event: any
    try { event = JSON.parse(String(msg.data)) } catch { return }
    if (typeof event?.type !== 'string' || !event.type.startsWith('vibe.')) return
    const preview = event.text ?? event.problem ?? event.analogy ?? ''
    console.log(`[e2e] <- ${event.type}${preview ? `: ${String(preview).slice(0, 100)}` : ''}`)

    if (event.type === 'vibe.question' && !answeredDirective) {
      answeredDirective = true
      ws.send(JSON.stringify({ type: 'vibe.answer', questionId: event.questionId, answer: TASK }))
      console.log('[e2e] -> vibe.answer (substantive directive — should go straight to BUILD)')
    } else if (event.type === 'vibe.question') {
      ws.send(JSON.stringify({ type: 'vibe.answer', questionId: event.questionId, answer: 'A' }))
      console.log('[e2e] -> vibe.answer (A)')
    } else if (event.type === 'vibe.escalation') {
      fail(`escalated: ${event.problem}`)
    } else if (event.type === 'vibe.task_complete') {
      res()
    }
  }
})

ws.send(JSON.stringify({ type: 'vibe.start', mode: 'new', description: TASK }))
console.log('[e2e] -> vibe.start')

const timer = setTimeout(
  () => fail(`no vibe.task_complete within ${TASK_TIMEOUT_MS / 60_000} min`),
  TASK_TIMEOUT_MS,
)
await done
clearTimeout(timer)
// Fix 2: normal teardown — clear the onclose guard before we intentionally close.
ws.onclose = null
ws.close()

const target = join(workDir, 'hello.txt')
if (!existsSync(target)) fail(`vibe.task_complete arrived but hello.txt was not created in ${workDir}`)
const content = readFileSync(target, 'utf-8')
// Fix 5a: toLowerCase + includes rather than exact-match because a nondeterministic
// local model may add a trailing newline or vary casing; the smoke goal is "the loop
// built the right file", not byte-perfect output.
if (!content.toLowerCase().includes('hello world')) {
  fail(`hello.txt content wrong: "${content.slice(0, 100)}"`)
}

console.log('\n[e2e] PASS — vibe loop built the file end-to-end')
cleanup()
// Fix 4: wait for the engine to release its cwd handle before rmSync; on Windows
// kill() returns before the process exits and rmSync on the live workdir hits EBUSY.
await engine.exited.catch(() => {})
// Fix 5c: best-effort cleanup — temp-dir removal is not critical; the OS will
// reclaim tmpdirs eventually if this fails.
try { rmSync(workDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
process.exit(0)
