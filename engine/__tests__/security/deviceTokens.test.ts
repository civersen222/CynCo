/**
 * Paired devices in the token store.
 *
 * A phone on the owner's tailnet pairs once and holds an `inference`-scoped
 * record of its own, so it can be listed and revoked without rotating the
 * dashboard's or the TUI's secret. The file it lives in is the one the TUI
 * reads at connect time and a child engine reads at startup, so every write
 * must be whole: a half-written tokens.json would lock out every client.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadOrCreateTokens, TokenSet, TOKEN_FILENAME, DEVICE_PREFIX, DEVICE_LABEL_MAX, DEVICE_IDLE_EXPIRY_MS, LAST_SEEN_PERSIST_MS } from '../../security/localToken.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-devices-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('addDevice', () => {
  it('mints an inference-only record named device-<8 hex> and persists it', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', new Date('2026-10-22T12:00:00Z'))
    expect(rec.name).toMatch(new RegExp(`^${DEVICE_PREFIX}[0-9a-f]{8}$`))
    expect(rec.scopes).toEqual(['inference'])
    expect(rec.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(rec.label).toBe('Pixel')
    expect(rec.createdAt).toBe('2026-10-22T12:00:00.000Z')

    const onDisk = JSON.parse(readFileSync(join(dir, TOKEN_FILENAME), 'utf-8'))
    const saved = onDisk.tokens.find((t: any) => t.name === rec.name)
    expect(saved).toEqual(rec)
    // The three minted records are untouched.
    expect(onDisk.tokens.map((t: any) => t.name).slice(0, 3)).toEqual(['tui', 'dashboard', 'admin'])
  })

  it('a device secret verifies for inference and for nothing else', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('phone')
    expect(set.verify(rec.secret, 'inference')).toBe(true)
    expect(set.verify(rec.secret, 'management')).toBe(false)
    expect(set.verify(rec.secret, 'bridge')).toBe(false)
    expect(set.isKnown(rec.secret)).toBe(true)
    expect(set.holderOf(rec.secret)?.name).toBe(rec.name)
    expect(set.holderOf('0'.repeat(64))).toBeNull()
  })

  it('survives a reload: the next engine start still knows the device', () => {
    const rec = loadOrCreateTokens(dir).addDevice('phone')
    const again = loadOrCreateTokens(dir)
    expect(again.verify(rec.secret, 'inference')).toBe(true)
    expect(again.devices()).toEqual([expect.objectContaining({ name: rec.name, label: 'phone', createdAt: rec.createdAt })])
    // Reloading did not re-mint: the dashboard secret is the same one.
    expect(again.tokenFor('inference')).toBe(loadOrCreateTokens(dir).tokenFor('inference'))
  })

  it('cleans the label: control characters dropped, length capped, empty becomes "phone"', () => {
    const set = loadOrCreateTokens(dir)
    expect(set.addDevice('  my\u0000\u0007 phone  ').label).toBe('my phone')
    expect(set.addDevice('x'.repeat(100)).label).toHaveLength(DEVICE_LABEL_MAX)
    expect(set.addDevice('').label).toBe('phone')
    expect(set.addDevice('éé').label).toBe('phone')
  })

  it('leaves no temp file behind and the file stays whole JSON', () => {
    const set = loadOrCreateTokens(dir)
    set.addDevice('a'); set.addDevice('b')
    expect(readdirSync(dir)).toEqual([TOKEN_FILENAME])
    expect(() => JSON.parse(readFileSync(join(dir, TOKEN_FILENAME), 'utf-8'))).not.toThrow()
  })
})

describe('revokeDevice', () => {
  it('removes the record, persists, and the secret stops verifying', () => {
    const set = loadOrCreateTokens(dir)
    const a = set.addDevice('a'); const b = set.addDevice('b')
    expect(set.revokeDevice(a.name)).toBe(true)
    expect(set.verify(a.secret, 'inference')).toBe(false)
    expect(set.isKnown(a.secret)).toBe(false)
    expect(set.verify(b.secret, 'inference')).toBe(true)
    expect(loadOrCreateTokens(dir).devices().map(d => d.name)).toEqual([b.name])
  })

  it('refuses to touch the three minted records and unknown names', () => {
    const set = loadOrCreateTokens(dir)
    expect(set.revokeDevice('admin')).toBe(false)
    expect(set.revokeDevice('dashboard')).toBe(false)
    expect(set.revokeDevice('tui')).toBe(false)
    expect(set.revokeDevice(DEVICE_PREFIX + 'deadbeef')).toBe(false)
    expect(set.tokenFor('management')).toBeTruthy()
    expect(set.tokenFor('bridge')).toBeTruthy()
  })
})

describe('when a device was last seen, and the idle expiry', () => {
  const DAY = 24 * 60 * 60_000
  const T0 = new Date('2026-11-11T12:00:00Z')

  it('a device is seen the moment it pairs, and expires that long after it was last seen', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    expect(set.devices()).toEqual([{
      name: rec.name, label: 'Pixel', createdAt: T0.toISOString(),
      lastSeenAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + DEVICE_IDLE_EXPIRY_MS).toISOString(),
    }])
    expect(DEVICE_IDLE_EXPIRY_MS).toBe(30 * DAY)
  })

  it('touchDevice moves lastSeenAt in memory at once and writes it at most once an hour', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    const onDisk = () => JSON.parse(readFileSync(join(dir, TOKEN_FILENAME), 'utf-8')).tokens.find((t: any) => t.name === rec.name).lastSeenAt
    const soon = new Date(T0.getTime() + 5 * 60_000)
    set.touchDevice(rec.name, soon)
    expect(set.devices()[0]!.lastSeenAt).toBe(soon.toISOString())
    expect(onDisk()).toBe(T0.toISOString()) // not yet: the last write is five minutes old
    const later = new Date(T0.getTime() + LAST_SEEN_PERSIST_MS + 1)
    set.touchDevice(rec.name, later)
    expect(onDisk()).toBe(later.toISOString())
    expect(readdirSync(dir)).toEqual([TOKEN_FILENAME])
    // Not a device, or not a known one: nothing happens and nothing throws.
    set.touchDevice('admin', later); set.touchDevice(DEVICE_PREFIX + 'deadbeef', later)
    expect(set.devices()).toHaveLength(1)
  })

  it('the hourly write changes lastSeenAt only: a device another process paired meanwhile stays on disk', () => {
    const mine = loadOrCreateTokens(dir)
    const rec = mine.addDevice('Pixel', T0)
    // A second engine on the same home pairs a tablet; `mine` still holds the older list.
    const other = loadOrCreateTokens(dir)
    const tablet = other.addDevice('Tablet', T0)
    mine.touchDevice(rec.name, new Date(T0.getTime() + LAST_SEEN_PERSIST_MS + 1))
    const names = loadOrCreateTokens(dir).devices().map(d => d.name)
    expect(names).toEqual([rec.name, tablet.name])
  })

  it('a touch whose write fails is said once and does not throw: the request it rode on is not a write', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    const broken = new TokenSet((set as any).file, join(dir, 'no-such-dir', TOKEN_FILENAME))
    const errors: string[] = []
    const orig = console.warn
    console.warn = (m: unknown) => { errors.push(String(m)) }
    try {
      expect(() => broken.touchDevice(rec.name, new Date(T0.getTime() + LAST_SEEN_PERSIST_MS + 1))).not.toThrow()
    } finally { console.warn = orig }
    expect(errors.some(e => e.includes('last-seen'))).toBe(true)
  })

  it('expireIdleDevices removes a device unseen for the whole period, keeps one seen inside it, and persists', () => {
    const set = loadOrCreateTokens(dir)
    const idle = set.addDevice('old tablet', T0)
    const used = set.addDevice('Pixel', T0)
    set.touchDevice(used.name, new Date(T0.getTime() + 10 * DAY))
    expect(set.expireIdleDevices(new Date(T0.getTime() + 30 * DAY - 1))).toEqual([])
    expect(set.expireIdleDevices(new Date(T0.getTime() + 30 * DAY))).toEqual([idle.name])
    expect(set.verify(idle.secret, 'inference')).toBe(false)
    expect(set.verify(used.secret, 'inference')).toBe(true)
    expect(loadOrCreateTokens(dir).devices().map(d => d.name)).toEqual([used.name])
    // The three minted records have no expiry at all.
    expect(set.expireIdleDevices(new Date(T0.getTime() + 3650 * DAY))).toEqual([used.name])
    expect(set.tokenFor('management')).toBeTruthy()
    expect(set.tokenFor('bridge')).toBeTruthy()
    expect(set.tokenFor('inference')).toBeTruthy()
  })

  it('a device paired before last-seen was recorded counts from the day it paired', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('pixel7pro', T0)
    delete (set as any).file.tokens.find((t: any) => t.name === rec.name).lastSeenAt
    expect(set.devices()[0]).toMatchObject({ lastSeenAt: null, expiresAt: new Date(T0.getTime() + 30 * DAY).toISOString() })
    expect(set.expireIdleDevices(new Date(T0.getTime() + 29 * DAY))).toEqual([])
    expect(set.expireIdleDevices(new Date(T0.getTime() + 31 * DAY))).toEqual([rec.name])
  })
})

describe('the page address a device uses (kept so a restarted engine still knows where the phone opens the dashboard)', () => {
  const T0 = new Date('2026-11-11T12:00:00Z')
  const NAME = 'https://longdongsilver.tail05397a.ts.net'
  const onDisk = (name: string) => JSON.parse(readFileSync(join(dir, TOKEN_FILENAME), 'utf-8')).tokens.find((t: any) => t.name === name)

  it('is written the first time and when it changes, not on every socket', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    expect(set.lastDeviceOrigin()).toBeNull()
    expect(set.setDeviceOrigin(rec.name, NAME)).toBe(true)
    expect(onDisk(rec.name).origin).toBe(NAME)
    expect(set.setDeviceOrigin(rec.name, NAME)).toBe(false) // the same address: no write
    expect(set.setDeviceOrigin(rec.name, 'http://100.101.192.101:9161')).toBe(true)
    expect(onDisk(rec.name).origin).toBe('http://100.101.192.101:9161')
    expect(readdirSync(dir)).toEqual([TOKEN_FILENAME])
  })

  it('survives a reload, and the most recently seen device speaks for "where the phone is"', () => {
    const set = loadOrCreateTokens(dir)
    const tablet = set.addDevice('Tablet', T0)
    const pixel = set.addDevice('Pixel', T0)
    set.setDeviceOrigin(tablet.name, 'http://100.101.192.101:9161')
    set.setDeviceOrigin(pixel.name, NAME)
    set.touchDevice(pixel.name, new Date(T0.getTime() + 2 * LAST_SEEN_PERSIST_MS))
    const again = loadOrCreateTokens(dir)
    expect(again.lastDeviceOrigin()).toBe(NAME)
    again.touchDevice(tablet.name, new Date(T0.getTime() + 5 * LAST_SEEN_PERSIST_MS))
    expect(again.lastDeviceOrigin()).toBe('http://100.101.192.101:9161')
  })

  it('goes with the device: once revoked, its address is nobody\u2019s', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    set.setDeviceOrigin(rec.name, NAME)
    set.revokeDevice(rec.name)
    expect(set.lastDeviceOrigin()).toBeNull()
    expect(loadOrCreateTokens(dir).lastDeviceOrigin()).toBeNull()
  })

  it('only a page address is kept: anything else, or a record that is not a device, is refused', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'not a url', '', 'https://user:pw@evil.example', 'https://x.ts.net/path?q=1']) {
      expect(set.setDeviceOrigin(rec.name, bad), bad).toBe(false)
    }
    expect(set.setDeviceOrigin('admin', NAME)).toBe(false)
    expect(set.setDeviceOrigin(DEVICE_PREFIX + 'deadbeef', NAME)).toBe(false)
    expect(set.lastDeviceOrigin()).toBeNull()
    // A file edited by hand to hold something else is not handed to the notifier either.
    ;(set as any).file.tokens.find((t: any) => t.name === rec.name).origin = 'javascript:alert(1)'
    expect(set.lastDeviceOrigin()).toBeNull()
  })

  it('a write that fails is said and does not throw: the socket it rode on still opens', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('Pixel', T0)
    const broken = new TokenSet((set as any).file, join(dir, 'no-such-dir', TOKEN_FILENAME))
    const warned: string[] = []
    const orig = console.warn
    console.warn = (m: unknown) => { warned.push(String(m)) }
    try { expect(() => broken.setDeviceOrigin(rec.name, NAME)).not.toThrow() } finally { console.warn = orig }
    expect(warned.some(w => w.includes('page address'))).toBe(true)
    expect(broken.lastDeviceOrigin()).toBe(NAME) // memory has it for this run
  })
})

describe('revokeAllDevices', () => {
  it('forgets every device, persists, and leaves the three minted records alone', () => {
    const set = loadOrCreateTokens(dir)
    const a = set.addDevice('a'); const b = set.addDevice('b')
    expect(set.revokeAllDevices().sort()).toEqual([a.name, b.name].sort())
    expect(set.devices()).toEqual([])
    expect(set.isKnown(a.secret)).toBe(false)
    expect(set.isKnown(b.secret)).toBe(false)
    const again = loadOrCreateTokens(dir)
    expect(again.devices()).toEqual([])
    expect(again.tokenFor('inference')).toBe(set.tokenFor('inference'))
    expect(again.tokenFor('management')).toBe(set.tokenFor('management'))
    expect(again.tokenFor('bridge')).toBe(set.tokenFor('bridge'))
    expect(set.revokeAllDevices()).toEqual([]) // nothing left: no write, no throw
  })

  it('a write that fails still forgets them in memory, then throws so the caller can say it', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('phone')
    const broken = new TokenSet((set as any).file, join(dir, 'no-such-dir', TOKEN_FILENAME))
    expect(() => broken.revokeAllDevices()).toThrow()
    expect(broken.verify(rec.secret, 'inference')).toBe(false)
  })
})

describe('a write that fails', () => {
  it('leaves no phantom device in memory and spends nothing', () => {
    const set = loadOrCreateTokens(dir)
    // Point the set at a file whose directory does not exist: the write throws.
    const broken = new TokenSet((set as any).file, join(dir, 'no-such-dir', TOKEN_FILENAME))
    expect(() => broken.addDevice('ghost')).toThrow()
    expect(broken.devices()).toEqual([])
    expect(loadOrCreateTokens(dir).devices()).toEqual([])
  })
  it('a revoke still removes the device from memory, then reports the write failure', () => {
    const set = loadOrCreateTokens(dir)
    const rec = set.addDevice('phone')
    const broken = new TokenSet((set as any).file, join(dir, 'no-such-dir', TOKEN_FILENAME))
    expect(() => broken.revokeDevice(rec.name)).toThrow()
    expect(broken.verify(rec.secret, 'inference')).toBe(false)
  })
})

describe('a straggler from a crash between write and rename', () => {
  it('is removed the next time the file is loaded', () => {
    loadOrCreateTokens(dir)
    const straggler = join(dir, `${TOKEN_FILENAME}.12345.tmp`)
    writeFileSync(straggler, '{"version":1,"tokens":[]}')
    const warnings: string[] = []
    const orig = console.warn
    console.warn = (m: unknown) => { warnings.push(String(m)) }
    try { loadOrCreateTokens(dir) } finally { console.warn = orig }
    expect(existsSync(straggler)).toBe(false)
    expect(warnings.some(w => w.includes('straggler'))).toBe(true)
    expect(readdirSync(dir)).toEqual([TOKEN_FILENAME])
  })
})

describe('a set without a file path', () => {
  it('still mints and verifies in memory, and says it could not persist', () => {
    const warnings: string[] = []
    const orig = console.warn
    console.warn = (m: unknown) => { warnings.push(String(m)) }
    try {
      const set = new TokenSet({ version: 1, tokens: [{ name: 'admin', scopes: ['inference', 'management'], secret: 'a'.repeat(64) }] } as any)
      const rec = set.addDevice('ephemeral')
      expect(set.verify(rec.secret, 'inference')).toBe(true)
      expect(warnings.some(w => w.includes('not persisted'))).toBe(true)
    } finally { console.warn = orig }
  })
})
