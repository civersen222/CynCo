/**
 * Dashboard server security: localhost binding.
 *
 * Verifies that DashboardServer defaults to 127.0.0.1 and respects
 * the LOCALCODE_DASHBOARD_HOST override.
 *
 * The bunShim forwards `hostname` to Node's http.listen(), so these
 * tests exercise the real binding path under vitest.
 */

import * as os from 'os'
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { DashboardServer } from '../../dashboard/server.js'

// Use ports well away from the main test suite (port 19161)
const DEFAULT_PORT = 19171
const OVERRIDE_PORT = 19172
const NEGATIVE_PORT = 19173

describe('dashboard server hostname binding', () => {
  let server: DashboardServer
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.LOCALCODE_DASHBOARD_HOST
  })

  afterEach(() => {
    server?.stop()
    if (savedEnv !== undefined) {
      process.env.LOCALCODE_DASHBOARD_HOST = savedEnv
    } else {
      delete process.env.LOCALCODE_DASHBOARD_HOST
    }
  })

  test('defaults to 127.0.0.1 when LOCALCODE_DASHBOARD_HOST is unset', async () => {
    delete process.env.LOCALCODE_DASHBOARD_HOST

    server = new DashboardServer({ port: DEFAULT_PORT })

    // getHostname() returns the stored value used in Bun.serve()
    expect(server.getHostname()).toBe('127.0.0.1')

    // HTTP request to 127.0.0.1 must succeed
    await new Promise(r => setTimeout(r, 100))
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('CynCo Governance Dashboard')
  })
})

describe('dashboard server LOCALCODE_DASHBOARD_HOST override', () => {
  let server: DashboardServer

  afterAll(() => {
    server?.stop()
  })

  test('honors LOCALCODE_DASHBOARD_HOST env var', async () => {
    const saved = process.env.LOCALCODE_DASHBOARD_HOST
    process.env.LOCALCODE_DASHBOARD_HOST = '0.0.0.0'

    try {
      server = new DashboardServer({ port: OVERRIDE_PORT })

      expect(server.getHostname()).toBe('0.0.0.0')

      // HTTP request must succeed (0.0.0.0 binds all interfaces, localhost still works)
      await new Promise(r => setTimeout(r, 100))
      const res = await fetch(`http://127.0.0.1:${OVERRIDE_PORT}/`)
      expect(res.status).toBe(200)
    } finally {
      if (saved !== undefined) {
        process.env.LOCALCODE_DASHBOARD_HOST = saved
      } else {
        delete process.env.LOCALCODE_DASHBOARD_HOST
      }
    }
  })
})

describe('dashboard server negative binding (non-loopback refused)', () => {
  let server: DashboardServer | undefined

  afterAll(() => {
    server?.stop()
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
    if (!externalIP) {
      // No non-internal IPv4 interface available — skip
      return
    }

    const saved = process.env.LOCALCODE_DASHBOARD_HOST
    delete process.env.LOCALCODE_DASHBOARD_HOST

    try {
      server = new DashboardServer({ port: NEGATIVE_PORT })
      expect(server.getHostname()).toBe('127.0.0.1')

      await new Promise(r => setTimeout(r, 100))

      // Fetching via the external IP must be refused (connection error, not a response)
      await expect(
        fetch(`http://${externalIP}:${NEGATIVE_PORT}/`, { signal: AbortSignal.timeout(2000) })
      ).rejects.toThrow()
    } finally {
      server?.stop()
      server = undefined
      if (saved !== undefined) {
        process.env.LOCALCODE_DASHBOARD_HOST = saved
      } else {
        delete process.env.LOCALCODE_DASHBOARD_HOST
      }
    }
  })
})
