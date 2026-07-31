import { describe, test, expect, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { LocalCodeWSServer } from '../../bridge/server.js'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

/**
 * The dashboard port must follow the port the bridge BOUND, not the one it was
 * asked for.
 *
 * `main.ts` parses LOCALCODE_WS_PORT into `port` and hands the bridge that
 * number. The bridge tries `[port, port + 1, port + 2]` (`bridge/server.ts`),
 * because after a restart the first is commonly still in TIME_WAIT. The
 * dashboard was then constructed on `port + 1` — the bridge's own second
 * choice. So whenever the fallback fired, the dashboard asked the OS for a
 * socket this same process had bound a few lines earlier, `Bun.serve` threw
 * EADDRINUSE, and a `try/catch` turned the loss of the entire governance UI
 * into one `console.warn` among a hundred startup lines.
 *
 * The printed URL was computed the same wrong way — `port + 1` rather than the
 * port the dashboard actually bound. A guess presented as a fact.
 *
 * `+ 1` is right in both versions; what was wrong is which number it was added
 * to. So the assertions below are about data flow, not arithmetic.
 *
 * ── On why the collision itself is not reproduced here ──────────────────────
 *
 * It cannot be, in this suite. Under vitest `Bun.serve` is
 * `engine/__tests__/setup/bunShim.ts`, which listens with `exclusive: false` —
 * SO_REUSEADDR — precisely so that rapid test re-runs do not trip over their
 * own TIME_WAIT sockets. Two servers on one port therefore both succeed, and
 * the bridge's fallback never fires. Writing a test that squats a port and
 * expects a throw produces a test that passes against the unfixed code.
 *
 * The two behavioural tests below cover what the shim CAN answer: that these
 * are real getters reporting a real bind, not echoes of the constructor
 * argument. The wiring — which getter main.ts reads — is asserted against the
 * source, in the same shape as `routingPreservesRestriction.test.ts`.
 */

const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dashport-tokens-'))
const tokens = loadOrCreateTokens(tokenDir)
afterAll(() => rmSync(tokenDir, { recursive: true, force: true }))

const BRIDGE_PORT = 19240

describe('both servers report the port they bound', () => {
  test('the dashboard reports a port nothing could have computed', async () => {
    // port 0 asks the OS to assign one. The whole point of `getPort()` is that
    // this number exists nowhere else — if it echoed the constructor argument
    // it would come back 0, and the startup URL would name port 0.
    let dashboard: DashboardServer | undefined
    try {
      dashboard = new DashboardServer({ port: 0, tokens })
      await new Promise(r => setTimeout(r, 100))
      const bound = dashboard.getPort()
      expect(bound).toBeGreaterThan(0)

      const res = await fetch(`http://127.0.0.1:${bound}/`)
      expect(res.status, 'getPort() named a port that is not serving the dashboard').toBe(200)
    } finally {
      dashboard?.stop()
    }
  })

  test('the bridge exposes its bound port at all', async () => {
    // The premise the fix rests on: there is something to derive FROM. The
    // fallback branch that makes this differ from the request is unreachable
    // under the shim (see the header), so this asserts only the free-port case.
    let bridge: LocalCodeWSServer | undefined
    try {
      bridge = new LocalCodeWSServer({ port: BRIDGE_PORT, tokens })
      expect(bridge.port).toBe(BRIDGE_PORT)
      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${bridge.port}/`)
      expect(res.status, 'bridge.port named a port the bridge is not on').toBe(401)
    } finally {
      await bridge?.close()
    }
  })
})

describe('bridge/server.ts assigns the port it bound', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', '..', 'bridge', 'server.ts'), 'utf-8')

  test('_port is set from the loop variable, not left as the request', () => {
    // Deriving the dashboard port from `wsServer.port` buys nothing if `.port`
    // reports the number the caller passed in. The shim cannot exercise the
    // fallback, so the assignment is asserted here instead.
    const loop = src.match(/for \(const port of portsToTry\)[\s\S]*?\n {2}\}/)
    expect(loop, 'the bridge fallback loop moved or changed shape').not.toBeNull()
    expect(
      loop![0],
      'the fallback loop binds a port and never records which one, so `.port` reports the ' +
        'request and the dashboard derives from a number that may be wrong',
    ).toContain('this._port = port')
  })
})

describe('main.ts startup wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', '..', 'main.ts'), 'utf-8').split('\r\n').join('\n')

  test('the dashboard is constructed on a port derived from the bridge', () => {
    const ctor = src.match(/new DashboardServer\(\{[\s\S]*?\n {4}port:\s*([^\n,]+),/)
    expect(ctor, 'the DashboardServer construction moved or changed shape').not.toBeNull()
    const portExpr = ctor![1]!.trim()
    expect(
      portExpr,
      `the dashboard is constructed on \`${portExpr}\`. That must read the port the bridge ` +
        "bound (wsServer.port), or the bridge's own fallback becomes a self-collision.",
    ).toContain('wsServer.port')
  })

  test('the printed URL asks the dashboard for its port', () => {
    const line = src.match(/console\.log\(`\[dashboard\] Governance dashboard on[^`]*`\)/)
    expect(line, 'the dashboard startup line moved or changed shape').not.toBeNull()
    expect(
      line![0],
      'the startup URL is computed rather than read back from the server, so it can name a ' +
        'port nothing is listening on',
    ).toContain('dashboardServer.getPort()')
  })

  test('losing the dashboard entirely is not reported as a warning', () => {
    const idx = src.indexOf('[dashboard] FAILED TO START')
    expect(idx, 'the dashboard failure path moved or changed its message').toBeGreaterThan(-1)

    // The whole catch block, from the `} catch (e) {` that precedes the message
    // to the brace that closes it.
    const catchStart = src.lastIndexOf('} catch (e) {', idx)
    const catchEnd = src.indexOf('\n}', idx)
    // Code only. The block explains in prose why it is not a warn, and a scan
    // that reads comments would fail on the very comment recording the fix.
    const block = src.slice(catchStart, catchEnd)
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(
      block,
      'the dashboard is the only window onto governance; losing it was reported at the same ' +
        'level as a routine notice, which is how a user ends up hunting for a UI that never ran',
    ).not.toContain('console.warn')
    expect(block).toContain('console.error')
  })
})
