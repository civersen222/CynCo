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
import { loadOrCreateTokens, TokenSet, TOKEN_FILENAME, DEVICE_PREFIX, DEVICE_LABEL_MAX } from '../../security/localToken.js'

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
    expect(again.devices()).toEqual([{ name: rec.name, label: 'phone', createdAt: rec.createdAt }])
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
