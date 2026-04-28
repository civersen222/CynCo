import type { ToolImpl } from '../types.js'

/** Reject URLs targeting private/internal networks (SSRF protection). */
function validateUrl(urlStr: string): { ok: boolean; reason?: string } {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Blocked scheme: ${parsed.protocol}` }
  }

  // Block private hostnames
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local')) {
    return { ok: false, reason: `Blocked host: ${host}` }
  }

  // Block private IP ranges
  const parts = host.split('.').map(Number)
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    const [a, b] = parts
    if (a === 127) return { ok: false, reason: 'Blocked: loopback' }
    if (a === 10) return { ok: false, reason: 'Blocked: private (10/8)' }
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'Blocked: private (172.16/12)' }
    if (a === 192 && b === 168) return { ok: false, reason: 'Blocked: private (192.168/16)' }
    if (a === 169 && b === 254) return { ok: false, reason: 'Blocked: link-local (169.254/16)' }
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return { ok: false, reason: 'Blocked: IPv6 private' }
  }

  return { ok: true }
}

export const webFetchTool: ToolImpl = {
  name: 'WebFetch',
  description: 'Fetch a URL and return its text content. Useful for reading documentation. Only allows public HTTP/HTTPS URLs.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (public HTTP/HTTPS only)' },
      max_length: { type: 'number', description: 'Max response length in characters (default: 50000)' },
    },
    required: ['url'],
  },
  tier: 'auto',
  execute: async (input) => {
    const url = input.url as string
    const maxLen = (input.max_length as number) ?? 50000

    const check = validateUrl(url)
    if (!check.ok) {
      return { output: `URL blocked: ${check.reason}`, isError: true }
    }

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'CynCo/1.0' },
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return { output: `HTTP ${resp.status}: ${resp.statusText}`, isError: true }
      let text = await resp.text()
      if (text.length > maxLen) text = text.slice(0, maxLen) + `\n... (truncated at ${maxLen} chars)`
      return { output: text, isError: false }
    } catch (err) {
      return { output: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
