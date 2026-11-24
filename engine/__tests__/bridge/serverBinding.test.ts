/**
 * TUI WebSocket bridge security: localhost binding.
 *
 * Verifies that LocalCodeWSServer defaults to 127.0.0.1 and respects
 * the LOCALCODE_BRIDGE_HOST override — same fix class as the dashboard
 * server (see ../dashboard/security.test.ts).
 *
 * The bunShim forwards `hostname` to Node's http.listen(), so these
 * tests exercise the real binding path under vitest.
 */

import * as os from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, test, expect, afterAll } from 'vitest'
import { LocalCodeWSServer } from '../../bridge/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

// The bridge refuses an unauthenticated upgrade; binding is a separate concern,
// so these tests just need a valid token store to construct the server at all.
const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-bind-tokens-'))
const tokens = loadOrCreateTokens(tokenDir)
// afterAll, not process.on('exit'): in a vitest worker that handler never ran, so every run left one
// cynco-bind-tokens-* in the temp folder (about 180 of them had piled up by 2026-11-24).
afterAll(() => rmSync(tokenDir, { recursive: true, force: true }))

// Ports spaced by 3: the bridge falls back to port+1/+2 on bind failure
const DEFAULT_PORT = 19180
const OVERRIDE_PORT = 19183
const NEGATIVE_PORT = 19186

function restoreEnv(saved: string | undefined) {
  if (saved !== undefined) {
    process.env.LOCALCODE_BRIDGE_HOST = saved
  } else {
    delete process.env.LOCALCODE_BRIDGE_HOST
  }
}

describe('bridge server hostname binding', () => {
  test('defaults to 127.0.0.1 when LOCALCODE_BRIDGE_HOST is unset', async () => {
    const saved = process.env.LOCALCODE_BRIDGE_HOST
    delete process.env.LOCALCODE_BRIDGE_HOST
    let server: LocalCodeWSServer | undefined

    try {
      server = new LocalCodeWSServer({ port: DEFAULT_PORT, tokens })
      expect(server.getHostname()).toBe('127.0.0.1')

      // A plain HTTP request to loopback must REACH the server. 401 rather
      // than 426: the token gate runs before the upgrade branch, so an
      // unauthenticated caller is turned away without being told whether this
      // endpoint speaks WebSocket. Either way it proves the port is bound —
      // which is all this test is about.
      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(res.status).toBe(401)
    } finally {
      await server?.close()
      restoreEnv(saved)
    }
  })

  test('honors LOCALCODE_BRIDGE_HOST env var', async () => {
    const saved = process.env.LOCALCODE_BRIDGE_HOST
    process.env.LOCALCODE_BRIDGE_HOST = '0.0.0.0'
    let server: LocalCodeWSServer | undefined

    try {
      server = new LocalCodeWSServer({ port: OVERRIDE_PORT, tokens })
      expect(server.getHostname()).toBe('0.0.0.0')

      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(res.status).toBe(401)
    } finally {
      await server?.close()
      restoreEnv(saved)
    }
  })

  test('connection to non-loopback IP is refused when bound to 127.0.0.1', async (t) => {
    // Find the first non-internal IPv4 address on this machine
    const ifaces = os.networkInterfaces()
    let externalIP: string | undefined
    for (const iface of Object.values(ifaces)) {
      if (!iface) continue
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          externalIP = addr.address
          break
        }
      }
      if (externalIP) break
    }

    // No non-internal IPv4 (a runner with only loopback): nothing to connect from, so the test is
    // marked skipped and says so. It used to return here and report a pass that had checked nothing.
    if (!externalIP) {
      console.log('[serverBinding] SKIPPED: this machine has no non-internal IPv4 address, so a refused connection from off loopback cannot be tried')
      t.skip()
      return
    }

    const saved = process.env.LOCALCODE_BRIDGE_HOST
    delete process.env.LOCALCODE_BRIDGE_HOST
    let server: LocalCodeWSServer | undefined

    try {
      server = new LocalCodeWSServer({ port: NEGATIVE_PORT, tokens })
      expect(server.getHostname()).toBe('127.0.0.1')

      await new Promise(r => setTimeout(r, 100))
      await expect(
        fetch(`http://${externalIP}:${server.port}/`, { signal: AbortSignal.timeout(2000) })
      ).rejects.toThrow()
    } finally {
      await server?.close()
      restoreEnv(saved)
    }
  })
})
