import { describe, test, expect } from 'bun:test'
import { ipv4Address, validateUrl, fetchGuarded, MAX_REDIRECTS, webFetchTool } from '../webFetch.js'

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

describe('fetchGuarded', () => {
  test('returns the response when no redirect occurs', async () => {
    const { impl, seen } = scriptedFetch({
      'https://example.com/doc': { status: 200, body: 'hello' },
    })
    const result = await fetchGuarded('https://example.com/doc', impl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(await result.response.text()).toBe('hello')
    expect(seen).toEqual(['https://example.com/doc'])
  })

  test('refuses a public host that redirects to loopback', async () => {
    const { impl, seen } = scriptedFetch({
      'https://example.com/redir': { status: 302, location: 'http://127.0.0.1:9161/secrets' },
    })
    const result = await fetchGuarded('https://example.com/redir', impl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('loopback')
    // The blocked hop must never have been requested.
    expect(seen).toEqual(['https://example.com/redir'])
  })

  test('refuses a redirect to the cloud metadata address', async () => {
    const { impl } = scriptedFetch({
      'https://example.com/r': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    })
    const result = await fetchGuarded('https://example.com/r', impl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('link-local')
  })

  test('follows a redirect chain to a public destination', async () => {
    const { impl, seen } = scriptedFetch({
      'https://a.example/': { status: 301, location: 'https://b.example/' },
      'https://b.example/': { status: 302, location: '/final' },
      'https://b.example/final': { status: 200, body: 'arrived' },
    })
    const result = await fetchGuarded('https://a.example/', impl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(await result.response.text()).toBe('arrived')
    expect(seen).toEqual(['https://a.example/', 'https://b.example/', 'https://b.example/final'])
  })

  test('gives up rather than looping forever', async () => {
    const { impl, seen } = scriptedFetch({
      'https://loop.example/': { status: 302, location: 'https://loop.example/' },
    })
    const result = await fetchGuarded('https://loop.example/', impl, 3)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too many redirects (>3)')
    expect(seen.length).toBe(4)
  })

  test('a redirect without a Location header ends the chain', async () => {
    const { impl } = scriptedFetch({
      'https://example.com/': { status: 302, body: 'no location' },
    })
    const result = await fetchGuarded('https://example.com/', impl)
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
    await fetchGuarded('https://a.example/', impl)
    expect(inits.length).toBe(2)
    for (const init of inits) expect(init.redirect).toBe('manual')
  })

  test('the default redirect budget is finite', () => {
    expect(MAX_REDIRECTS).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_REDIRECTS)).toBe(true)
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
})
