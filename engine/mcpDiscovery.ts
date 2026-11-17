/**
 * engine/mcpDiscovery.ts — which MCP servers the user has configured.
 *
 * This reads config files and nothing else. The engine has no MCP client: it
 * connects to no server and calls no tool of one (the 2026-11-17 work order's
 * mission D1 is that client). So a server found here is `configured`, or
 * `disabled` when its entry says so. It used to be reported as `connected`,
 * which the TUI drew in green beside a server nothing had ever spoken to.
 */
import { existsSync, readFileSync } from 'fs'
import type { MCPServerInfo } from './bridge/protocol.js'

/**
 * The servers named by the config files at `paths`, in order; the first file to
 * name a server wins. A file may hold `{ mcpServers: {…} }`, `{ servers: {…} }`
 * or the name map itself. A file that is not there is skipped silently; one
 * that cannot be read is said through `log` and skipped.
 */
export function readMcpServers(paths: string[], log: (line: string) => void = console.warn): MCPServerInfo[] {
  const servers: MCPServerInfo[] = []
  for (const configPath of paths) {
    if (!existsSync(configPath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (e) {
      log(`[mcp] ${configPath} was not read: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const holder = raw as Record<string, unknown>
    const named = holder.mcpServers ?? holder.servers ?? holder
    if (typeof named !== 'object' || named === null || Array.isArray(named)) continue
    for (const [name, config] of Object.entries(named as Record<string, unknown>)) {
      if (servers.some(s => s.name === name)) continue
      const disabled = typeof config === 'object' && config !== null && (config as { disabled?: unknown }).disabled === true
      servers.push({ name, status: disabled ? 'disabled' : 'configured' })
    }
  }
  return servers
}
