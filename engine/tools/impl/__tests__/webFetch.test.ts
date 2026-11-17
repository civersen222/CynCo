import { describe, test, expect } from 'bun:test'
import { ipv4Address, validateUrl, fetchGuarded, blockedAddress, pinTarget, MAX_REDIRECTS, webFetchTool, type Resolver } from '../webFetch.js'
import { hostname } from 'os'
import { lookup } from 'dns/promises'

describe('ipv4Address', () => {
  test('reads the four spellings inet_aton accepts for loopback', () => {
    const loopback = 0x7f000001
    expect(ipv4Address('127.0.0.1')).toBe(loopback)
    expect(ipv4Address('2130706433')).toBe(loopback)
    expect(ipv4Address('0x7f000001')).toBe(loopback)
    expect(ipv4Address('0177.0.0.1')).toBe(loopback)
    expect(ipv4Address('127.1')).toBe(loopback)
    expect(ipv4Address('127.0.1')).toBe(loopback)
  })

  test('a hostname is not an address', () => {
    expect(ipv4Address('example.com')).toBeNull()
    expect(ipv4Address('fcbank.com')).toBeNull()
    expect(ipv4Address('127.0.0.1.5')).toBeNull()
    expect(ipv4Address('127.0.0.')).toBeNull()
    expect(ipv4Address('999.0.0.1')).toBeNull()
    expect(ipv4Address('08.0.0.1')).toBeNull()
  })

  test('a leading part over 255 or a trailing part past its width is not an address', () => {
    expect(ipv4Address('256.0.0.1')).toBeNull()
    expect(ipv4Address('127.0.0.256')).toBeNull()
    expect(ipv4Address('127.16777216')).toBeNull()
    expect(ipv4Address('127.16777215')).toBe(0x7fffffff)
  })
})

describe('validateUrl', () => {
  test('permits ordinary public https', () => {
    expect(validateUrl('https://example.com/docs').ok).toBe(true)
    expect(validateUrl('http://93.184.216.34/').ok).toBe(true)
  })

  test('refuses non-http schemes', () => {
    expect(validateUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateUrl('ftp://example.com/x').ok).toBe(false)
    expect(validateUrl('not a url at all').ok).toBe(false)
  })

  test('refuses localhost by name', () => {
    expect(validateUrl('http://localhost:8080/').ok).toBe(false)
    expect(validateUrl('http://localhost.localdomain/').ok).toBe(false)
    expect(validateUrl('http://printer.local/').ok).toBe(false)
  })

  test('refuses every private and reserved IPv4 range', () => {
    const blocked = [
      'http://0.0.0.0/',
      'http://127.0.0.1:9161/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://224.0.0.1/',
      'http://255.255.255.255/',
    ]
    for (const url of blocked) {
      expect(validateUrl(url).ok).toBe(false)
    }
  })

  test('permits the public addresses that neighbour those ranges', () => {
    const allowed = [
      'http://172.15.0.1/',
      'http://172.32.0.1/',
      'http://192.167.1.1/',
      'http://169.253.0.1/',
      'http://100.63.0.1/',
      'http://100.128.0.1/',
      'http://223.255.255.255/',
    ]
    for (const url of allowed) {
      expect(validateUrl(url).ok).toBe(true)
    }
  })

  test('refuses loopback written in every spelling, not just dotted-quad', () => {
    expect(validateUrl('http://2130706433/').ok).toBe(false)
    expect(validateUrl('http://0x7f000001/').ok).toBe(false)
    expect(validateUrl('http://0177.0.0.1/').ok).toBe(false)
    expect(validateUrl('http://127.1/').ok).toBe(false)
  })

  test('refuses IPv6 loopback, unique-local and link-local', () => {
    expect(validateUrl('http://[::1]:8080/').ok).toBe(false)
    expect(validateUrl('http://[::]/').ok).toBe(false)
    expect(validateUrl('http://[fc00::1]/').ok).toBe(false)
    expect(validateUrl('http://[fd12:3456::1]/').ok).toBe(false)
    expect(validateUrl('http://[fe80::1]/').ok).toBe(false)
  })

  test('refuses loopback wearing an IPv6 coat', () => {
    expect(validateUrl('http://[::ffff:127.0.0.1]/').ok).toBe(false)
    expect(validateUrl('http://[::ffff:169.254.169.254]/').ok).toBe(false)
  })

  test('permits a public IPv6 host', () => {
    expect(validateUrl('http://[2606:2800:220:1:248:1893:25c8:1946]/').ok).toBe(true)
    expect(validateUrl('http://[::ffff:93.184.216.34]/').ok).toBe(true)
  })

  test('a hostname beginning with the unique-local prefix is still a hostname', () => {
    // The old check ran `host.startsWith('fc')` against every host, so a bank
    // was refused and ::ffff:127.0.0.1 was allowed. Both directions matter.
    expect(validateUrl('https://fcbank.com/').ok).toBe(true)
    expect(validateUrl('https://fd-media.example/').ok).toBe(true)
    expect(validateUrl('https://fe80networks.io/').ok).toBe(true)
  })
})

/** A fetch stand-in that answers from a script, so no test touches the network. */
function scriptedFetch(script: Record<string, { status: number; location?: string; body?: string }>) {
  const seen: string[] = []
  const inits: RequestInit[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url)
    seen.push(key)
    inits.push(init ?? {})
    const hit = script[key]
    if (!hit) throw new Error(`unscripted fetch: ${key}`)
    const headers = new Headers()
    if (hit.location) headers.set('location', hit.location)
    return new Response(hit.body ?? '', { status: hit.status, headers })
  }) as unknown as typeof fetch
  return { impl, seen, inits }
}

/** A public address (example.com's block): what a name resolves to when a test says nothing else. */
const PUBLIC_ADDRESS = '93.184.216.34'
/** A stand-in network: the scripted fetch, and a DNS in which every name is public. */
const net = (impl: typeof fetch, resolve: Resolver = async () => [PUBLIC_ADDRESS]) => ({ fetch: impl, resolve })
/** A DNS that answers from a table and refuses any name it was not given. */
const dns = (table: Record<string, string[]>): Resolver => async (host) => {
  const found = table[host]
  if (!found) throw new Error(`unscripted lookup: ${host}`)
  return found
}

describe('fetchGuarded', () => {
  test('returns the response when no redirect occurs', async () => {
    const { impl, seen } = scriptedFetch({
      'https://example.com/doc': { status: 200, body: 'hello' },
    })
    const result = await fetchGuarded('https://example.com/doc', net(impl))
    expect(result.ok).toBe(true)
    if (result.ok) expect(await result.response.text()).toBe('hello')
    expect(seen).toEqual(['https://example.com/doc'])
  })

  test('refuses a public host that redirects to loopback', async () => {
    const { impl, seen } = scriptedFetch({
      'https://example.com/redir': { status: 302, location: 'http://127.0.0.1:9161/secrets' },
    })
    const result = await fetchGuarded('https://example.com/redir', net(impl))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('loopback')
    // The blocked hop must never have been requested.
    expect(seen).toEqual(['https://example.com/redir'])
  })

  test('refuses a redirect to the cloud metadata address', async () => {
    const { impl } = scriptedFetch({
      'https://example.com/r': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    })
    const result = await fetchGuarded('https://example.com/r', net(impl))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('link-local')
  })

  test('follows a redirect chain to a public destination', async () => {
    const { impl, seen } = scriptedFetch({
      'https://a.example/': { status: 301, location: 'https://b.example/' },
      'https://b.example/': { status: 302, location: '/final' },
      'https://b.example/final': { status: 200, body: 'arrived' },
    })
    const result = await fetchGuarded('https://a.example/', net(impl))
    expect(result.ok).toBe(true)
    if (result.ok) expect(await result.response.text()).toBe('arrived')
    expect(seen).toEqual(['https://a.example/', 'https://b.example/', 'https://b.example/final'])
  })

  test('gives up rather than looping forever', async () => {
    const { impl, seen } = scriptedFetch({
      'https://loop.example/': { status: 302, location: 'https://loop.example/' },
    })
    const result = await fetchGuarded('https://loop.example/', { ...net(impl), maxRedirects: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too many redirects (>3)')
    expect(seen.length).toBe(4)
  })

  test('a redirect without a Location header ends the chain', async () => {
    const { impl } = scriptedFetch({
      'https://example.com/': { status: 302, body: 'no location' },
    })
    const result = await fetchGuarded('https://example.com/', net(impl))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.response.status).toBe(302)
  })

  test('every hop is requested in manual redirect mode', async () => {
    // A stand-in cannot follow a redirect on its own, so nothing else here can
    // tell 'manual' from 'follow'. Real fetch can: under 'follow' it would chase
    // the loopback hop itself and hand back its body, and the revalidation loop
    // below would never see the address it exists to refuse.
    const { impl, inits } = scriptedFetch({
      'https://a.example/': { status: 301, location: 'https://b.example/' },
      'https://b.example/': { status: 200, body: 'ok' },
    })
    await fetchGuarded('https://a.example/', net(impl))
    expect(inits.length).toBe(2)
    for (const init of inits) expect(init.redirect).toBe('manual')
  })

  test('the default redirect budget is finite', () => {
    expect(MAX_REDIRECTS).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_REDIRECTS)).toBe(true)
  })
})

/**
 * The one bypass the 2026-10-27 review left open (its item 6): `validateUrl`
 * reads the URL, so a public-looking NAME that resolves to 127.0.0.1:9161 or to
 * a tailnet address passed it. A name is now looked up before anything connects
 * to it, and held to the ranges a literal address is held to.
 */
describe('fetchGuarded: a name is resolved before it is fetched', () => {
  const page = { 'https://docs.example/': { status: 200, body: 'hello' } }

  test('a name that resolves to loopback is refused before any request', async () => {
    const { impl, seen } = scriptedFetch(page)
    const result = await fetchGuarded('https://docs.example/', net(impl, dns({ 'docs.example': ['127.0.0.1'] })))
    expect(result).toEqual({ ok: false, reason: 'Blocked: docs.example resolves to 127.0.0.1 (loopback)' })
    expect(seen).toEqual([])
  })

  test('each range a literal address is refused for is refused for a resolved one', async () => {
    const cases: Array<[string, string]> = [
      ['10.0.0.5', 'private (10/8)'],
      ['172.20.1.1', 'private (172.16/12)'],
      ['192.168.0.47', 'private (192.168/16)'],
      ['169.254.169.254', 'link-local (169.254/16)'],
      ['100.101.192.101', 'carrier-grade NAT (100.64/10)'], // a tailnet address
      ['0.0.0.0', 'this-network (0/8)'],
      ['::1', 'IPv6 loopback'],
      ['fd7a:115c:a1e0::1', 'IPv6 unique-local'], // Tailscale's IPv6 range
      ['fe80::1%eth0', 'IPv6 link-local'],
      ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ]
    for (const [address, why] of cases) {
      const { impl, seen } = scriptedFetch(page)
      const result = await fetchGuarded('https://docs.example/', net(impl, dns({ 'docs.example': [address] })))
      expect(result, address).toEqual({ ok: false, reason: `Blocked: docs.example resolves to ${address} (${why})` })
      expect(seen, address).toEqual([])
    }
  })

  test('one private address among public ones refuses the name', async () => {
    const { impl, seen } = scriptedFetch(page)
    const result = await fetchGuarded('https://docs.example/', net(impl, dns({ 'docs.example': [PUBLIC_ADDRESS, '10.0.0.5'] })))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('Blocked: docs.example resolves to 10.0.0.5 (private (10/8))')
    expect(seen).toEqual([])
  })

  test('every hop of a redirect chain is resolved, and a private hop is never requested', async () => {
    const { impl, seen } = scriptedFetch({
      'https://a.example/': { status: 301, location: 'https://b.example/' },
      'https://b.example/': { status: 302, location: 'https://inside.example/admin' },
      'https://inside.example/admin': { status: 200, body: 'the dashboard' },
    })
    const looked: string[] = []
    const table = dns({ 'a.example': [PUBLIC_ADDRESS], 'b.example': ['93.184.216.35'], 'inside.example': ['127.0.0.1'] })
    const result = await fetchGuarded('https://a.example/', net(impl, async (h) => { looked.push(h); return table(h) }))
    expect(result).toEqual({ ok: false, reason: 'Blocked: inside.example resolves to 127.0.0.1 (loopback)' })
    expect(looked).toEqual(['a.example', 'b.example', 'inside.example'])
    expect(seen).toEqual(['https://a.example/', 'https://b.example/'])
  })

  test('the request is handed the address that was checked', async () => {
    const sent: Array<[string, string | null]> = []
    const impl = async (url: string, _init: RequestInit, address: string | null) => { sent.push([url, address]); return new Response('ok') }
    const result = await fetchGuarded('https://docs.example/a', { fetch: impl, resolve: dns({ 'docs.example': [PUBLIC_ADDRESS] }) })
    expect(result.ok).toBe(true)
    expect(sent).toEqual([['https://docs.example/a', PUBLIC_ADDRESS]])
  })

  test('IPv4 is tried before IPv6, and a second address when the first cannot be reached', async () => {
    const tried: Array<string | null> = []
    const impl = async (_url: string, _init: RequestInit, address: string | null) => {
      tried.push(address)
      if (address === PUBLIC_ADDRESS) throw new Error('connect ECONNREFUSED')
      return new Response('ok')
    }
    const resolve = dns({ 'docs.example': ['2606:2800:220:1::1', PUBLIC_ADDRESS, '93.184.216.35'] })
    const result = await fetchGuarded('https://docs.example/', { fetch: impl, resolve })
    expect(result.ok).toBe(true)
    expect(tried).toEqual([PUBLIC_ADDRESS, '93.184.216.35'])
  })

  test('when no address can be reached the last failure is thrown, as a failed fetch always was', async () => {
    const impl = async () => { throw new Error('connect ETIMEDOUT') }
    await expect(fetchGuarded('https://docs.example/', { fetch: impl, resolve: dns({ 'docs.example': [PUBLIC_ADDRESS] }) })).rejects.toThrow('ETIMEDOUT')
  })

  test('a host that is itself an address is not looked up', async () => {
    const { impl, seen } = scriptedFetch({ 'https://93.184.216.34/': { status: 200, body: 'ok' } })
    const result = await fetchGuarded('https://93.184.216.34/', { fetch: impl, resolve: async () => { throw new Error('looked up an address') } })
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['https://93.184.216.34/'])
  })

  test('a name that does not resolve throws, and one that resolves to nothing does too', async () => {
    const { impl, seen } = scriptedFetch(page)
    const notFound: Resolver = async () => { throw new Error('getaddrinfo ENOTFOUND docs.example') }
    await expect(fetchGuarded('https://docs.example/', net(impl, notFound))).rejects.toThrow('ENOTFOUND')
    await expect(fetchGuarded('https://docs.example/', net(impl, async () => []))).rejects.toThrow('no address found for docs.example')
    expect(seen).toEqual([])
  })

  test('an answer that is not an address is refused, not connected to', () => {
    expect(blockedAddress('not-an-address')).toBe('not an address')
    expect(blockedAddress(PUBLIC_ADDRESS)).toBe('')
    expect(blockedAddress('2606:2800:220:1::1')).toBe('')
  })
})

describe('pinTarget: the request goes to the checked address under the name it was asked for', () => {
  test('the address replaces the host; the name is kept for Host and for TLS', () => {
    expect(pinTarget('https://docs.example/a/b?q=1', '93.184.216.34')).toEqual({
      url: 'https://93.184.216.34/a/b?q=1', host: 'docs.example', serverName: 'docs.example',
    })
  })

  test('a port stays on the URL and in Host, and is not part of the TLS name', () => {
    expect(pinTarget('https://docs.example:8443/x', '93.184.216.34')).toEqual({
      url: 'https://93.184.216.34:8443/x', host: 'docs.example:8443', serverName: 'docs.example',
    })
  })

  test('an IPv6 address is bracketed', () => {
    expect(pinTarget('http://docs.example/', '2606:2800:220:1::1').url).toBe('http://[2606:2800:220:1::1]/')
  })
})

describe('webFetchTool wiring', () => {
  // This drives the tool the way the model does. It goes red if the guard is
  // ever unwired from the call site, which no unit test of validateUrl would
  // notice.
  test('the tool itself refuses a private address', async () => {
    const result = await webFetchTool.execute({ url: 'http://127.0.0.1:1/' }, '/tmp')
    expect(result.isError).toBe(true)
    expect(result.output.startsWith('URL blocked:')).toBe(true)
    expect(result.output).toContain('loopback')
  })

  test('the tool refuses loopback spelled as an integer', async () => {
    const result = await webFetchTool.execute({ url: 'http://2130706433/' }, '/tmp')
    expect(result.isError).toBe(true)
    expect(result.output.startsWith('URL blocked:')).toBe(true)
  })

  test('the tool refuses a non-http scheme', async () => {
    const result = await webFetchTool.execute({ url: 'file:///etc/passwd' }, '/tmp')
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Blocked scheme')
  })

  // The real resolver, with no network: this machine's own name resolves, locally, to its own
  // addresses, every one of them loopback, private, link-local or (on a tailnet) carrier-grade
  // NAT. It goes red if the tool is ever unwired from the lookup. A machine whose name does not
  // resolve at all cannot run it, and says so.
  test('the tool itself refuses a name that resolves to this machine', async () => {
    const name = hostname()
    let own: string[]
    try {
      own = (await lookup(name, { all: true })).map(a => a.address)
    } catch (e) {
      console.warn(`[webFetch.test] ${name} does not resolve here (${e instanceof Error ? e.message : String(e)}); the wiring test did not run`)
      return
    }
    if (own.every(a => blockedAddress(a) === '')) {
      console.warn(`[webFetch.test] ${name} resolves only to public addresses (${own.join(', ')}); the wiring test did not run`)
      return
    }
    const result = await webFetchTool.execute({ url: `http://${name}:1/` }, '/tmp')
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(new RegExp(`^URL blocked: Blocked: \\S+ resolves to `))
  })
})

/**
 * Three IPv6 spellings of a private IPv4 address that the literal check let through, and so
 * the lookup check did too (decision sheet of 2026-11-17, row 17): NAT64 and 6to4 carry an
 * IPv4 address inside an IPv6 one, and site-local is the old private IPv6 range.
 */
describe('IPv6 forms that carry or are a private address', () => {
  const refused: Array<[string, string]> = [
    ['64:ff9b::7f00:1', 'NAT64 loopback'],                    // 127.0.0.1
    ['64:ff9b::127.0.0.1', 'NAT64 loopback'],                 // the same, dotted
    ['64:ff9b::c0a8:2f', 'NAT64 private (192.168/16)'],       // 192.168.0.47
    ['64:ff9b:1::a00:5', 'NAT64 private (10/8)'],             // local-use NAT64 prefix, 10.0.0.5
    ['2002:7f00:1::', '6to4 loopback'],                       // 127.0.0.1
    ['2002:6465:c065::1', '6to4 carrier-grade NAT (100.64/10)'], // 100.101.192.101, a tailnet address
    ['2002:a9fe:a9fe::', '6to4 link-local (169.254/16)'],     // 169.254.169.254
    ['fec0::1', 'IPv6 site-local'],
    ['feff:1::2', 'IPv6 site-local'],
  ]
  const allowed = [
    '64:ff9b::5db8:d822',  // NAT64 of 93.184.216.34, a public address
    '2002:5db8:d822::1',   // 6to4 of the same
    '2606:2800:220:1::1',
    '2001:db8::1',
  ]

  test('as a literal host in a URL', () => {
    for (const [address, why] of refused) {
      expect(validateUrl(`http://[${address}]/`), address).toEqual({ ok: false, reason: `Blocked: ${why}` })
    }
    for (const address of allowed) expect(validateUrl(`http://[${address}]/`), address).toEqual({ ok: true })
  })

  test('as the address a name resolves to, in any case', () => {
    for (const [address, why] of refused) {
      expect(blockedAddress(address), address).toBe(why)
      expect(blockedAddress(address.toUpperCase()), address).toBe(why)
    }
    for (const address of allowed) expect(blockedAddress(address), address).toBe('')
  })

  test('what was refused before still is, with the same words', () => {
    expect(blockedAddress('::1')).toBe('IPv6 loopback')
    expect(blockedAddress('fd00::1')).toBe('IPv6 unique-local')
    expect(blockedAddress('fe80::1')).toBe('IPv6 link-local')
    expect(blockedAddress('::ffff:10.0.0.5')).toBe('IPv4-mapped private (10/8)')
  })

  // A URL's host arrives in one spelling (WHATWG's); a resolver's answer arrives in whatever
  // spelling the resolver used, and the old text match knew only the short one.
  test('an address is the same address however it is spelled', () => {
    expect(blockedAddress('0:0:0:0:0:0:0:1')).toBe('IPv6 loopback')
    expect(blockedAddress('0000:0000:0000:0000:0000:0000:0000:0001')).toBe('IPv6 loopback')
    expect(blockedAddress('FE80:0:0:0:0:0:0:1')).toBe('IPv6 link-local')
    expect(blockedAddress('0:0:0:0:0:ffff:7f00:1')).toBe('IPv4-mapped loopback')
  })

  test('something that is not an IPv6 address is not waved through', () => {
    expect(blockedAddress('64:ff9b::zz')).toBe('not an address')
    expect(blockedAddress('1:2:3:4:5:6:7:8:9')).toBe('not an address')
  })
})
