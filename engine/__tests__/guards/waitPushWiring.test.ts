/**
 * main.ts must hand every loop event to the wait push, and build the push from
 * what is pending and who is connected (docs/NOW.md: "Tell the phone when the
 * engine waits").
 *
 * `daemon/waitPush.test.ts` pins the decision with fakes and nothing there
 * loads main.ts: delete `waitPush?.onEvent(event)` from the loop's emit, or
 * count only the dashboard's sockets and forget the TUI, and every suite stays
 * green while the phone hears nothing (or hears it while the owner is typing
 * in the TUI). This guard reads those lines, in the shape of
 * `imageServiceWiring.test.ts`.
 *
 * It also pins where the push is NOT built: the `--run-task` path. A daemon
 * one-shot must never talk to the phone itself (engine/daemon/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

function stripLineComments(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

const here = dirname(fileURLToPath(import.meta.url))
const src = stripLineComments(readFileSync(join(here, '..', '..', 'main.ts'), 'utf-8').split('\r\n').join('\n'))

describe('main.ts wait-push wiring', () => {
  const at = src.indexOf('\nconst waitPush = ')
  const built = at === -1 ? '' : src.slice(at, at + 900)

  it('builds the push only when ntfy is configured, from the same variables the daemon reads', () => {
    expect(at).toBeGreaterThan(-1)
    expect(src).toContain('ntfyOptionsFromEnv(process.env)')
    expect(built).toContain('new WaitPush(')
  })

  it('never queues a wait notice for later', () => {
    expect(built).toContain('queueOnFailure: false')
  })

  it('asks the loop what is pending and counts both the dashboard sockets and the TUI', () => {
    expect(built).toContain('loop.pendingDecisions()')
    expect(built).toContain('dashboardServer?.clientCount')
    expect(built).toContain('wsServer.connected')
  })

  it('links the notice to the address a paired device last used', () => {
    expect(built).toContain('dashboardServer?.lastRemoteOrigin')
  })

  it('hands every loop event to it', () => {
    const emitAt = src.indexOf('\nconst loop = new ConversationLoop({')
    expect(emitAt).toBeGreaterThan(-1)
    expect(src.slice(emitAt, emitAt + 500)).toContain('waitPush?.onEvent(event)')
  })

  it('is not built on the --run-task path: a one-shot never talks to the phone', () => {
    const runTask = src.indexOf("const runTaskIdx = process.argv.indexOf('--run-task')")
    expect(runTask).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(runTask)
    expect(src.slice(0, at)).not.toContain('new WaitPush(')
  })
})
