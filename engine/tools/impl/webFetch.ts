import type { ToolImpl } from '../types.js'
import { wrapUntrusted } from '../untrusted.js'

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
 * An IPv6 address (no brackets, lower case, no zone id) as its eight 16-bit
 * groups, or null if the text is not one. Every spelling comes out the same:
 * `::1`, `0:0:0:0:0:0:0:1` and `0000::0001` are one address, and a dotted
 * IPv4 tail (`::ffff:127.0.0.1`) is two groups. WHATWG rewrites a URL's
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` before anything here sees it; a
 * resolver's answer arrives however the resolver spelled it.
 */
function ipv6Groups(v6: string): number[] | null {
  let text = v6
  const tail = text.slice(text.lastIndexOf(':') + 1)
  if (tail.includes('.')) {
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail)
    if (!octets || octets.slice(1).some(o => Number(o) > 255)) return null
    const [a, b, c, d] = octets.slice(1).map(Number)
    text = `${text.slice(0, text.length - tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const part = (s: string): number[] | null => {
    if (s === '') return []
    const groups = s.split(':')
    if (!groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null
    return groups.map(g => parseInt(g, 16))
  }
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : []
  if (head === null || rest === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const gap = 8 - head.length - rest.length
  if (gap < 1) return null
  return [...head, ...new Array<number>(gap).fill(0), ...rest]
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
    const why = blockedIpv6(host.slice(1, -1))
    return why ? { ok: false, reason: `Blocked: ${why}` } : { ok: true }
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

/**
 * Why this IPv6 address (no brackets, lower case) is off limits, or '' if it is
 * not; text that is not an IPv6 address is 'not an address'.
 *
 * Its own ranges: loopback and unspecified, unique-local (fc00::/7), link-local
 * (fe80::/10) and the older site-local (fec0::/10). And three ways it can carry
 * an IPv4 address, each held to the IPv4 ranges: IPv4-mapped and
 * IPv4-compatible (the last 32 bits behind 96 zero bits, with or without
 * ffff), NAT64 (64:ff9b::/96, and the local-use 64:ff9b:1::/48: the last 32
 * bits) and 6to4 (2002::/16: bits 16 to 48). The last three ranges came on
 * 2026-11-17 with the owner's yes (decision sheet, row 17): until then
 * `64:ff9b::7f00:1` was a way to write 127.0.0.1 that nothing refused.
 */
function blockedIpv6(v6: string): string {
  const g = ipv6Groups(v6)
  if (g === null) return 'not an address'
  const v4At = (i: number) => g[i] * 65536 + g[i + 1]
  const carried = (label: string, v4: number) => { const why = blockedIpv4(v4); return why ? `${label} ${why}` : '' }
  const leadingZeros = (n: number) => g.slice(0, n).every(x => x === 0)

  if (leadingZeros(7) && g[7] <= 1) return 'IPv6 loopback'
  if ((g[0] & 0xfe00) === 0xfc00) return 'IPv6 unique-local'
  if ((g[0] & 0xffc0) === 0xfe80) return 'IPv6 link-local'
  if ((g[0] & 0xffc0) === 0xfec0) return 'IPv6 site-local'
  if (leadingZeros(5) && (g[5] === 0xffff || g[5] === 0)) return carried('IPv4-mapped', v4At(6))
  if (g[0] === 0x64 && g[1] === 0xff9b && (g[2] === 1 || g.slice(2, 6).every(x => x === 0))) return carried('NAT64', v4At(6))
  if (g[0] === 0x2002) return carried('6to4', v4At(1))
  return ''
}

/**
 * Why an address a resolver handed back is off limits, or '' if it is not: the
 * same ranges a literal address in a URL is held to. An answer that is not an
 * address at all is refused rather than connected to.
 */
export function blockedAddress(address: string): string {
  const a = address.trim().toLowerCase().replace(/%.*$/, '') // an IPv6 zone id is not part of the address
  if (a.includes(':')) return blockedIpv6(a)
  const v4 = ipv4Address(a)
  return v4 === null ? 'not an address' : blockedIpv4(v4)
}

export const MAX_REDIRECTS = 5
/** How many of a name's addresses are tried before the fetch gives up. */
const MAX_ADDRESSES_TRIED = 2

/** Every address a host name has. */
export type Resolver = (host: string) => Promise<string[]>
/** One request. `address` is the checked address of the URL's host (null when the host is itself an address). */
export type GuardedFetch = (url: string, init: RequestInit, address: string | null) => Promise<Response>
export type FetchGuardOptions = {
  /** The request itself; the default connects to the address it is handed. A stand-in ignores it. */
  fetch?: GuardedFetch | typeof fetch
  /** The name lookup; the default is the system's. A test that passes `fetch` passes this too. */
  resolve?: Resolver
  maxRedirects?: number
}

const systemResolve: Resolver = async (host) => {
  const { lookup } = await import('node:dns/promises')
  return (await lookup(host, { all: true, verbatim: true })).map(a => a.address)
}

/**
 * Where a request for `url` goes when it must reach `address` and nothing else:
 * the same URL with the address as its host, the name it was asked under as the
 * `Host` header, and that name again for the TLS handshake and the certificate
 * check. Pure.
 */
export function pinTarget(url: string, address: string): { url: string; host: string; serverName: string } {
  const u = new URL(url)
  const host = u.host
  const serverName = u.hostname
  u.hostname = address.includes(':') ? `[${address}]` : address
  return { url: u.toString(), host, serverName }
}

/**
 * The default request: `fetch`, connected to the address that was checked.
 *
 * Checking a name's address and then handing the name to `fetch` leaves a gap:
 * `fetch` looks the name up again, and a DNS server that answers a public
 * address the first time and 127.0.0.1 the second walks through it. So the
 * request goes to the address, with the name in `Host` and in the TLS
 * handshake. Measured under Bun 1.3.13 against a public site (2026-11-17): the
 * right name connects and is served, a wrong name fails the handshake, and no
 * name fails it too, so the certificate is still checked against the name.
 * (`tls` is Bun's option; the engine runs under Bun.)
 */
export const pinnedFetch: GuardedFetch = (url, init, address) => {
  if (address === null) return fetch(url, init)
  const pin = pinTarget(url, address)
  const headers = new Headers(init.headers)
  headers.set('Host', pin.host)
  return fetch(pin.url, { ...init, headers, tls: { serverName: pin.serverName } } as RequestInit)
}

/**
 * Fetch with every hop validated, not just the one the caller typed, and every
 * name resolved before anything connects to it.
 *
 * `fetch` follows redirects itself, so validating only the supplied URL bought
 * nothing: a public host that answers 302 with `Location: http://127.0.0.1:9161/`
 * put the loopback response in the model's hands. Redirects are therefore taken
 * manually and each destination goes back through `validateUrl`.
 *
 * `validateUrl` reads the URL and nothing else, so a public-looking name that
 * resolves to 127.0.0.1 or to a tailnet address passed it (the 2026-10-27
 * review's item 6). Each hop's name is now looked up first: if ANY of its
 * addresses is in a range a literal address would be refused for, the hop is
 * refused before a request is made, and otherwise the request is sent to an
 * address that was checked (`pinnedFetch`). IPv4 addresses are tried first and
 * a second address is tried when the first cannot be reached, because a pinned
 * request has no fallback of its own. A name that does not resolve throws, as
 * the fetch of it always did.
 *
 * `fetch` and `resolve` are injectable so a redirect chain and a hostile DNS
 * answer can both be measured without a network.
 */
export async function fetchGuarded(
  urlStr: string,
  opts: FetchGuardOptions = {},
): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  const doFetch = (opts.fetch ?? pinnedFetch) as GuardedFetch
  const resolve = opts.resolve ?? systemResolve
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS
  let current = urlStr
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = validateUrl(current)
    if (!check.ok) return { ok: false, reason: check.reason ?? 'Blocked' }

    const host = new URL(current).hostname
    // A host that is itself an address was judged by validateUrl; only a name has anything to look up.
    let addresses: Array<string | null> = [null]
    if (!host.startsWith('[') && ipv4Address(host) === null) {
      const found = await resolve(host)
      if (found.length === 0) throw new Error(`no address found for ${host}`)
      for (const address of found) {
        const why = blockedAddress(address)
        if (why) return { ok: false, reason: `Blocked: ${host} resolves to ${address} (${why})` }
      }
      addresses = [...found.filter(a => !a.includes(':')), ...found.filter(a => a.includes(':'))].slice(0, MAX_ADDRESSES_TRIED)
    }

    let response: Response | null = null
    let failure: unknown = null
    for (const address of addresses) {
      try {
        response = await doFetch(current, {
          headers: { 'User-Agent': 'CynCo/1.0' },
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
        }, address)
        break
      } catch (err) {
        failure = err
      }
    }
    if (!response) throw failure

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
      // A page is data, however it is worded (S4, 2026-11-06): see tools/untrusted.ts.
      return { output: wrapUntrusted(url, text), isError: false }
    } catch (err) {
      return { output: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
