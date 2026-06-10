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
import { describe, test, expect } from 'vitest'
import { LocalCodeWSServer } from '../../bridge/server.js'

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
      server = new LocalCodeWSServer({ port: DEFAULT_PORT })
      expect(server.getHostname()).toBe('127.0.0.1')

      // Non-upgrade HTTP request to loopback must reach the server (426)
      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(res.status).toBe(426)
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
      server = new LocalCodeWSServer({ port: OVERRIDE_PORT })
      expect(server.getHostname()).toBe('0.0.0.0')

      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(res.status).toBe(426)
    } finally {
      await server?.close()
      restoreEnv(saved)
    }
  })

  test('connection to non-loopback IP is refused when bound to 127.0.0.1', async () => {
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

    // Skip gracefully if no non-internal IPv4 exists (e.g. CI with only loopback)
    if (!externalIP) return

    const saved = process.env.LOCALCODE_BRIDGE_HOST
    delete process.env.LOCALCODE_BRIDGE_HOST
    let server: LocalCodeWSServer | undefined

    try {
      server = new LocalCodeWSServer({ port: NEGATIVE_PORT })
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
