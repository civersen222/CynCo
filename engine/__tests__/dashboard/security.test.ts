/**
 * Dashboard server security: localhost binding.
 *
 * Verifies that DashboardServer defaults to 127.0.0.1 and respects
 * the LOCALCODE_DASHBOARD_HOST override.
 *
 * The bunShim forwards `hostname` to Node's http.listen(), so these
 * tests exercise the real binding path under vitest.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { DashboardServer } from '../../dashboard/server.js'

// Use ports well away from the main test suite (port 19161)
const DEFAULT_PORT = 19171
const OVERRIDE_PORT = 19172

describe('dashboard server hostname binding', () => {
  let server: DashboardServer

  afterAll(() => {
    server?.stop()
  })

  test('defaults to 127.0.0.1 when LOCALCODE_DASHBOARD_HOST is unset', async () => {
    // Ensure env var is absent
    const saved = process.env.LOCALCODE_DASHBOARD_HOST
    delete process.env.LOCALCODE_DASHBOARD_HOST

    server = new DashboardServer({ port: DEFAULT_PORT })

    // getHostname() returns the stored value used in Bun.serve()
    expect(server.getHostname()).toBe('127.0.0.1')

    // Restore
    if (saved !== undefined) process.env.LOCALCODE_DASHBOARD_HOST = saved

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
  const savedEnv = process.env.LOCALCODE_DASHBOARD_HOST

  afterAll(() => {
    server?.stop()
    if (savedEnv !== undefined) {
      process.env.LOCALCODE_DASHBOARD_HOST = savedEnv
    } else {
      delete process.env.LOCALCODE_DASHBOARD_HOST
    }
  })

  test('honors LOCALCODE_DASHBOARD_HOST env var', async () => {
    process.env.LOCALCODE_DASHBOARD_HOST = '0.0.0.0'

    server = new DashboardServer({ port: OVERRIDE_PORT })

    expect(server.getHostname()).toBe('0.0.0.0')

    // HTTP request must succeed (0.0.0.0 binds all interfaces, localhost still works)
    await new Promise(r => setTimeout(r, 100))
    const res = await fetch(`http://127.0.0.1:${OVERRIDE_PORT}/`)
    expect(res.status).toBe(200)
  })
})
