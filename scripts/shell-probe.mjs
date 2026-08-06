// Ask the LIVE engine to run one trivial shell command, and print what the Bash
// tool actually returned. A restart that claims to fix the shell must be proven
// from the socket the missions use, not from a fresh process launched by hand.
//
// F66: for two dispatches every Bash call came back `Command exited with code 66`
// with nothing on either stream, and there was no way to ask the engine "can you
// run anything at all?" short of burning a mission and a ledger row.
//
// The probe ABORTS the moment Bash reports, and does not wait for the model to
// finish. Without that it keeps going: the first draft matched frame types that
// do not exist (`tool.end`/`tool.result` — the bridge emits `tool.complete`), so
// nothing ever stopped it, and a probe that was asked to touch no files ran the
// suite and committed a junk file to the target repo. A diagnostic that can
// write to the tree it is diagnosing is not a diagnostic.
import { loadOrCreateTokens } from '../engine/security/localToken.js'

const ws = new WebSocket('ws://localhost:9160', {
  headers: { Authorization: `Bearer ${loadOrCreateTokens().tokenFor('bridge')}` },
})

let done = false
function finish(code, why) {
  if (done) return
  done = true
  console.log(`[probe] ${why}`)
  try { ws.send(JSON.stringify({ type: 'abort' })) } catch {}
  setTimeout(() => { try { ws.close() } catch {}; process.exit(code) }, 500)
}

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    type: 'user.message',
    text: 'Run exactly one Bash tool call with the command `python --version`. Nothing else.',
    cwd: 'C:/Users/civer/civkings',
    readOnlyPaths: [],
  }))
})

ws.addEventListener('message', (ev) => {
  let f
  try { f = JSON.parse(ev.data) } catch { return }
  if (f.type !== 'tool.complete') return
  const out = String(f.result ?? '')
  console.log(`[probe] ${f.toolName} isError=${f.isError} :: ${out.slice(0, 400)}`)
  if (f.toolName !== 'Bash') return
  finish(f.isError ? 1 : 0, f.isError ? 'the shell is NOT healthy' : 'the shell is healthy')
})

ws.addEventListener('error', (e) => { console.log(`[probe] socket error: ${e?.message ?? e}`); finish(2, 'no socket') })
setTimeout(() => finish(3, 'timed out before Bash reported anything'), 180000)
