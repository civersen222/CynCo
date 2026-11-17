// engine/__tests__/mcpDiscovery.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readMcpServers } from '../mcpDiscovery.js'

/**
 * The engine reads the MCP servers a user configured and tells the TUI about
 * them. It connects to none of them: there is no MCP client in the engine.
 * Until 2026-11-17 it reported every one that was not disabled as `connected`,
 * and the TUI drew it green.
 */
describe('MCP servers: read from config, never claimed connected', () => {
  let dir: string
  let logged: string[]
  const log = (line: string) => { logged.push(line) }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-mcp-')); logged = [] })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = (name: string, body: unknown) => {
    const p = join(dir, name)
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    return p
  }

  it('a configured server is `configured`, a disabled one `disabled`, and none is `connected`', () => {
    const p = file('a.json', { mcpServers: { playwright: { command: 'npx' }, off: { command: 'x', disabled: true } } })
    const servers = readMcpServers([p], log)
    expect(servers).toEqual([{ name: 'playwright', status: 'configured' }, { name: 'off', status: 'disabled' }])
    expect(servers.some(s => s.status === 'connected')).toBe(false)
  })

  it('reads the three shapes a config file comes in: mcpServers, servers, or the map itself', () => {
    const a = file('a.json', { mcpServers: { one: {} } })
    const b = file('b.json', { servers: { two: {} } })
    const c = file('c.json', { three: {} })
    expect(readMcpServers([a, b, c], log).map(s => s.name)).toEqual(['one', 'two', 'three'])
  })

  it('the first file to name a server wins, and a file that is not there is skipped', () => {
    const a = file('a.json', { mcpServers: { same: { disabled: true } } })
    const b = file('b.json', { mcpServers: { same: {} } })
    expect(readMcpServers([join(dir, 'absent.json'), a, b], log)).toEqual([{ name: 'same', status: 'disabled' }])
    expect(logged).toEqual([])
  })

  it('a file that cannot be read as JSON is said, with its path, and the others are still read', () => {
    const bad = file('bad.json', '{ not json')
    const good = file('good.json', { mcpServers: { ok: {} } })
    expect(readMcpServers([bad, good], log)).toEqual([{ name: 'ok', status: 'configured' }])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(bad)
    expect(logged[0]).toMatch(/^\[mcp\] /)
  })

  it('a file that holds a list or a bare value names no servers', () => {
    expect(readMcpServers([file('list.json', [1, 2]), file('str.json', '"hello"')], log)).toEqual([])
  })
})
