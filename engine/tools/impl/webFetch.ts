import type { ToolImpl } from '../types.js'

/**
 * One part of a host, in any spelling `inet_aton` accepts: decimal, 0x-hex or
 * leading-zero octal. `http://0x7f.1/` is loopback and the dotted-quad test
 * never saw it.
 */
function hostPart(s: string): number | null {
  if (s === '') return null
  let n: number
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) n = parseInt(s, 16)
  else if (/^0[0-7]+$/.test(s)) n = parseInt(s, 8)
  // A leading zero that is not valid octal is not a number at all: `08` is an
  // error to inet_aton, not decimal 8. Reading it as decimal would make this
  // parser disagree with the resolver about what the host is.
  else if (/^0\d/.test(s)) return null
  else if (/^\d+$/.test(s)) n = parseInt(s, 10)
  else return null
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * A host as a 32-bit IPv4 address, or null if it is not one.
 *
 * `inet_aton` accepts a, a.b, a.b.c and a.b.c.d: the last part fills every byte
 * the leading parts did not. So 2130706433, 0x7f000001, 0177.0.0.1 and 127.1
 * are all 127.0.0.1, and every one of them reached the network before this.
 */
export function ipv4Address(host: string): number | null {
  const parts = host.split('.')
  if (parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    const n = hostPart(p)
    if (n === null) return null
    nums.push(n)
  }
  const last = nums.pop()
  if (last === undefined) return null
  if (nums.some(n => n > 255)) return null
  if (last >= Math.pow(256, 4 - nums.length)) return null
  let addr = last
  for (let i = 0; i < nums.length; i++) addr += nums[i] * Math.pow(256, 3 - i)
  return addr
}

/**
 * The IPv4 address an IPv6 host carries, or null if it carries none.
 *
 * WHATWG rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` before this ever
 * sees it, so a check for a dotted tail finds nothing on the exact input it was
 * written for. Both the dotted and the hextet spelling are read here.
 */
function mappedIpv4(v6: string): number | null {
  const dotted = v6.slice(v6.lastIndexOf(':') + 1)
  if (dotted.includes('.')) return ipv4Address(dotted)
  const m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
  if (!m) return null
  return parseInt(m[1], 16) * 65536 + parseInt(m[2], 16)
}

/** Reject URLs targeting private/internal networks (SSRF protection). */
export function validateUrl(urlStr: string): { ok: boolean; reason?: string } {
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

  const host = parsed.hostname.toLowerCase()
  if (host === '') return { ok: false, reason: 'Blocked: no host' }
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local')) {
    return { ok: false, reason: `Blocked host: ${host}` }
  }

  // WHATWG keeps the brackets on an IPv6 hostname. The old code tested
  // `host.startsWith('fc')` against every host, which blocked fcbank.com and
  // let ::ffff:127.0.0.1 through — wrong in both directions.
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1)
    if (v6 === '::1' || v6 === '::') return { ok: false, reason: 'Blocked: IPv6 loopback' }
    if (/^f[cd]/.test(v6)) return { ok: false, reason: 'Blocked: IPv6 unique-local' }
    if (/^fe[89ab]/.test(v6)) return { ok: false, reason: 'Blocked: IPv6 link-local' }
    const asV4 = mappedIpv4(v6)
    if (asV4 !== null) {
      const v4 = blockedIpv4(asV4)
      if (v4) return { ok: false, reason: `Blocked: IPv4-mapped ${v4}` }
    }
    return { ok: true }
  }

  const addr = ipv4Address(host)
  if (addr !== null) {
    const why = blockedIpv4(addr)
    if (why) return { ok: false, reason: `Blocked: ${why}` }
  }

  return { ok: true }
}

/** Why this address is off limits, or '' if it is routable public space. */
function blockedIpv4(addr: number): string {
  const a = (addr >>> 24) & 255
  const b = (addr >>> 16) & 255
  if (a === 0) return 'this-network (0/8)'
  if (a === 127) return 'loopback'
  if (a === 10) return 'private (10/8)'
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16/12)'
  if (a === 192 && b === 168) return 'private (192.168/16)'
  if (a === 169 && b === 254) return 'link-local (169.254/16)'
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)'
  if (a >= 224) return 'multicast/reserved'
  return ''
}

export const MAX_REDIRECTS = 5

/**
 * Fetch with every hop validated, not just the one the caller typed.
 *
 * `fetch` follows redirects itself, so validating only the supplied URL bought
 * nothing: a public host that answers 302 with `Location: http://127.0.0.1:9161/`
 * put the loopback response in the model's hands. Redirects are therefore taken
 * manually and each destination goes back through `validateUrl`.
 *
 * `doFetch` is injectable so the redirect chain can be measured without a
 * network: the first URL of a real redirect test would have to be public, which
 * a test may not depend on.
 */
export async function fetchGuarded(
  urlStr: string,
  doFetch: typeof fetch = fetch,
  maxRedirects = MAX_REDIRECTS,
): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  let current = urlStr
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = validateUrl(current)
    if (!check.ok) return { ok: false, reason: check.reason ?? 'Blocked' }
    const response = await doFetch(current, {
      headers: { 'User-Agent': 'CynCo/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    })
    if (response.status < 300 || response.status > 399) return { ok: true, response }
    const location = response.headers.get('location')
    if (!location) return { ok: true, response }
    current = new URL(location, current).toString()
  }
  return { ok: false, reason: `too many redirects (>${maxRedirects})` }
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
  core: false,
  execute: async (input) => {
    const url = input.url as string
    const maxLen = (input.max_length as number) ?? 50000

    try {
      const result = await fetchGuarded(url)
      if (!result.ok) return { output: `URL blocked: ${result.reason}`, isError: true }
      const resp = result.response
      if (!resp.ok) return { output: `HTTP ${resp.status}: ${resp.statusText}`, isError: true }
      let text = await resp.text()
      if (text.length > maxLen) text = text.slice(0, maxLen) + `\n... (truncated at ${maxLen} chars)`
      return { output: text, isError: false }
    } catch (err) {
      return { output: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
