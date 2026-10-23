/**
 * The pure half of phone access (engine/dashboard/access.ts), pinned on its own
 * terms: where a request came from, the Host rule on loopback, which addresses
 * to listen on, the single-use pairing code and its lockout, the Origin rule,
 * and the pairing page.
 */
import { describe, it, expect } from 'vitest'
import {
  isLoopbackAddress, classifyClient, loopbackHostRefusal, hostRefusal, parseListenHosts, isWildcardHost,
  PairingGate, mintPairingCode, PAIRING_CODE_LENGTH, PAIRING_MAX_FAILURES, PAIRING_LOCKOUT_MS,
  originMismatch, pairingPage, DEVICE_TOKEN_STORAGE_KEY,
} from '../../dashboard/access.js'

describe('isLoopbackAddress / classifyClient', () => {
  it('loopback in every spelling', () => {
    for (const a of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::1%lo0', ' 127.0.0.1 ']) {
      expect(isLoopbackAddress(a), a).toBe(true)
    }
  })
  it('a tailnet, LAN, public, wildcard or unknown address is not loopback', () => {
    for (const a of ['100.101.192.101', '192.168.1.20', '10.0.0.5', '203.0.113.1', 'fd7a:115c:a1e0::c039:c066', '::ffff:100.64.0.1', '0.0.0.0', '', '1270.0.0.1', '127.0.0.1.5', '::2']) {
      expect(isLoopbackAddress(a), a || '<empty>').toBe(false)
    }
    expect(isLoopbackAddress(null)).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
  it('local needs a loopback peer AND a loopback (or wildcard) listener', () => {
    expect(classifyClient({ peer: '127.0.0.1', listenerHost: '127.0.0.1' })).toBe('local')
    expect(classifyClient({ peer: '::1', listenerHost: 'localhost' })).toBe('local')
    expect(classifyClient({ peer: '127.0.0.1', listenerHost: '0.0.0.0' })).toBe('local')
    expect(classifyClient({ peer: '127.0.0.1', listenerHost: undefined })).toBe('local')
    // A reverse proxy on this machine hands phone requests to the loopback
    // listener from a loopback peer; one that targets the Tailscale listener
    // arrives there from loopback too — and is remote, as it should be.
    expect(classifyClient({ peer: '127.0.0.1', listenerHost: '100.101.192.101' })).toBe('remote')
    expect(classifyClient({ peer: '100.101.192.101', listenerHost: '100.101.192.101' })).toBe('remote')
    expect(classifyClient({ peer: '100.101.192.101', listenerHost: '127.0.0.1' })).toBe('remote')
    expect(classifyClient({ peer: null, listenerHost: '127.0.0.1' })).toBe('remote')
    // A listener that did not say which it is counts as "not the loopback one".
    expect(classifyClient({ peer: '127.0.0.1', listenerHost: 'unknown-listener' })).toBe('remote')
  })
})

describe('hostRefusal (every listener)', () => {
  it('a local client follows the loopback rule', () => {
    expect(hostRefusal('localhost:9161', 'local', '127.0.0.1')).toBeNull()
    expect(hostRefusal('evil.example:9161', 'local', '127.0.0.1')).toMatch(/does not name this machine/)
  })
  it('a remote client may use an IP literal, the listener address, or a MagicDNS name', () => {
    for (const h of ['100.101.192.101:9161', '100.101.192.101', '127.0.0.1:19190', '[fd7a:115c:a1e0::c039:c066]:9161', 'longdongsilver.tail05397a.ts.net:9161', 'PC.Tail05397a.TS.NET']) {
      expect(hostRefusal(h, 'remote', '100.101.192.101'), h).toBeNull()
    }
    expect(hostRefusal(null, 'remote', '100.101.192.101')).toBeNull()
  })
  it('a remote client under any other DNS name is a rebound one and is refused', () => {
    for (const h of ['evil.example:9161', 'evil.example', '100.101.192.101.evil.example:9161', 'ts.net.evil.example', 'localhost:9161']) {
      expect(hostRefusal(h, 'remote', '100.101.192.101'), h).toMatch(/not an address of this listener/)
    }
  })
})

describe('loopbackHostRefusal', () => {
  it('this machine, by any of its loopback names, with or without a port, or no Host at all', () => {
    for (const h of ['localhost:9161', 'localhost', '127.0.0.1:9161', '127.0.0.1', '[::1]:9161', '[::1]', 'LOCALHOST:19190', '127.5.5.5:1']) {
      expect(loopbackHostRefusal(h), h).toBeNull()
    }
    expect(loopbackHostRefusal(null)).toBeNull()
    expect(loopbackHostRefusal('')).toBeNull()
  })
  it('a rebound or foreign name is refused with a reason', () => {
    for (const h of ['evil.example:9161', 'evil.example', '100.101.192.101:9161', 'pc.tail05397a.ts.net:9161', '127.0.0.1.evil.example:9161', '[fd7a::1]:9161']) {
      expect(loopbackHostRefusal(h), h).toMatch(/does not name this machine/)
    }
  })
})

describe('parseListenHosts', () => {
  it('one host, a list, blanks and duplicates; order kept', () => {
    expect(parseListenHosts(undefined)).toEqual(['127.0.0.1'])
    expect(parseListenHosts('')).toEqual(['127.0.0.1'])
    expect(parseListenHosts('127.0.0.1')).toEqual(['127.0.0.1'])
    expect(parseListenHosts('127.0.0.1, 100.101.192.101')).toEqual(['127.0.0.1', '100.101.192.101'])
    expect(parseListenHosts(' ,127.0.0.1,,100.1.2.3, 127.0.0.1 ,')).toEqual(['127.0.0.1', '100.1.2.3'])
    expect(parseListenHosts('100.1.2.3,127.0.0.1')[0]).toBe('100.1.2.3')
  })
  it('names the wildcard binds', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true)
    expect(isWildcardHost('::')).toBe(true)
    expect(isWildcardHost('[::]')).toBe(true)
    expect(isWildcardHost('127.0.0.1')).toBe(false)
    expect(isWildcardHost('100.101.192.101')).toBe(false)
  })
})

describe('PairingGate', () => {
  it('mints a zero-padded numeric code of the declared length', () => {
    for (let i = 0; i < 50; i++) expect(mintPairingCode()).toMatch(new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`))
  })
  it('accepts the code with spaces or dashes typed in, then rotates it: a code works once', () => {
    const rotations: string[] = []
    const g = new PairingGate(() => 0, '012345', (code, why) => rotations.push(`${why}:${code}`))
    expect(g.attempt('99').ok).toBe(false)
    expect(g.attempt('012 345')).toEqual({ ok: true })
    expect(rotations).toHaveLength(1)
    expect(rotations[0].startsWith('used:')).toBe(true)
    expect(g.code).not.toBe('012345')
    expect(g.attempt('012-345')).toMatchObject({ ok: false, reason: 'wrong' })
    expect(g.attempt(g.code.replace(/(\d{3})(\d{3})/, '$1-$2'))).toEqual({ ok: true })
    expect(g.attempt(12345)).toMatchObject({ ok: false, reason: 'wrong' })
    expect(g.attempt(null)).toMatchObject({ ok: false, reason: 'wrong' })
  })
  it('locks after the fifth wrong code (rotating it), refuses even the right one while locked, reopens after the lockout', () => {
    let t = 1_000
    const rotations: string[] = []
    const g = new PairingGate(() => t, '000000', (_c, why) => rotations.push(why))
    for (let i = 1; i < PAIRING_MAX_FAILURES; i++) {
      expect(g.attempt('111111')).toEqual({ ok: false, reason: 'wrong', retryAfterMs: 0, attemptsLeft: PAIRING_MAX_FAILURES - i })
    }
    expect(g.attempt('111111')).toEqual({ ok: false, reason: 'locked', retryAfterMs: PAIRING_LOCKOUT_MS, attemptsLeft: 0 })
    expect(rotations).toEqual(['locked'])
    const fresh = g.code
    expect(fresh).not.toBe('000000')
    expect(g.lockedForMs()).toBe(PAIRING_LOCKOUT_MS)
    t += PAIRING_LOCKOUT_MS - 1
    expect(g.attempt(fresh)).toMatchObject({ ok: false, reason: 'locked', retryAfterMs: 1 })
    t += 1
    expect(g.lockedForMs()).toBe(0)
    expect(g.attempt(fresh)).toEqual({ ok: true })
  })
  it('a success between wrong codes starts the count over; rotate() on request', () => {
    const g = new PairingGate(() => 0, '000000')
    for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++) g.attempt('x')
    expect(g.attempt('000000')).toEqual({ ok: true })
    expect(g.attempt('x')).toMatchObject({ attemptsLeft: PAIRING_MAX_FAILURES - 1 })
    const before = g.code
    const after = g.rotate()
    expect(after).toBe(g.code)
    expect(after).not.toBe(before)
  })
  it('a code asked for from the desk lifts a lockout; a rotation by use or lockout does not', () => {
    const g = new PairingGate(() => 0, '000000')
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++) g.attempt('x')
    expect(g.lockedForMs()).toBe(PAIRING_LOCKOUT_MS)
    g.rotate('locked')
    expect(g.lockedForMs()).toBe(PAIRING_LOCKOUT_MS)
    const fresh = g.rotate('asked')
    expect(g.lockedForMs()).toBe(0)
    expect(g.attempt(fresh)).toEqual({ ok: true })
  })
})

describe('originMismatch', () => {
  it('no Origin passes; a matching Origin passes regardless of scheme and case', () => {
    expect(originMismatch(null, '127.0.0.1:9161')).toBeNull()
    expect(originMismatch('', '127.0.0.1:9161')).toBeNull()
    expect(originMismatch('http://127.0.0.1:9161', '127.0.0.1:9161')).toBeNull()
    expect(originMismatch('https://PC.tail05397a.ts.net', 'pc.tail05397a.ts.net')).toBeNull()
    expect(originMismatch('http://[::1]:9161', '[::1]:9161')).toBeNull()
  })
  it('another host, another port, an opaque or garbage origin, or no Host is refused with a reason', () => {
    expect(originMismatch('http://evil.example', '127.0.0.1:9161')).toMatch(/does not match/)
    expect(originMismatch('http://127.0.0.1:9162', '127.0.0.1:9161')).toMatch(/does not match/)
    expect(originMismatch('null', '127.0.0.1:9161')).toBe('opaque origin')
    expect(originMismatch('not a url', '127.0.0.1:9161')).toMatch(/unparseable/)
    expect(originMismatch('http://127.0.0.1:9161', null)).toMatch(/no Host/)
  })
})

describe('pairingPage', () => {
  it('is a self-contained page that posts to /api/pair, stores the token it gets back, and carries no secret', () => {
    const html = pairingPage()
    expect(html).toContain('<form')
    expect(html).toContain("fetch('/api/pair'")
    expect(html).toContain(`localStorage.setItem('${DEVICE_TOKEN_STORAGE_KEY}'`)
    expect(html).toContain("location.replace('/')")
    expect(html).toContain('autocomplete="one-time-code"')
    expect(html).toContain('name="viewport"')
    expect(html).not.toMatch(/__CYNCO_TOKEN|Bearer|[0-9a-f]{64}/)
  })
  it('its inline script parses as a function body (the F150 guard, applied here too)', () => {
    const m = /<script>([\s\S]*?)<\/script>/.exec(pairingPage())
    expect(m).toBeTruthy()
    expect(() => new Function(m![1]!)).not.toThrow()
  })
  it('says so when pairing is locked (wait rounded up to minutes) or the device was revoked', () => {
    const locked = pairingPage({ locked: true, retryAfterMs: 61_000 })
    expect(locked).toContain('about 2 minutes')
    expect(locked).toContain('disabled')
    expect(pairingPage({ locked: true, retryAfterMs: 1 })).toContain('about 1 minute.')
    expect(pairingPage({ revoked: true })).toContain('no longer paired')
  })
})
