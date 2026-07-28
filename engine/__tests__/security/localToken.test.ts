/**
 * The local token store.
 *
 * Two holes needed the same thing. The WS bridge accepted any connection, so a
 * page load could displace the TUI and drive the agent — which has Bash. The
 * dashboard's POST /config/* routes accept a "simple" cross-origin request that
 * lands regardless of whether the reply can be read, so dropping CORS did not
 * close them. Both want "prove you are a local client we minted a secret for."
 *
 * Scopes rather than separate key types, following Millwright's
 * ApiKey { name, team, key_hash, scopes }: one shape, and what a holder may do
 * is data on the record instead of a branch in the caller.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadOrCreateTokens, TOKEN_FILENAME } from '../../security/localToken.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-tokens-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('minting', () => {
  it('creates a token file when none exists', () => {
    const set = loadOrCreateTokens(dir)
    expect(existsSync(join(dir, TOKEN_FILENAME))).toBe(true)
    expect(set.tokenFor('bridge')).toMatch(/^[0-9a-f]{64}$/)
    expect(set.tokenFor('inference')).toMatch(/^[0-9a-f]{64}$/)
    expect(set.tokenFor('management')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints a distinct secret per scope', () => {
    const set = loadOrCreateTokens(dir)
    const secrets = new Set([set.tokenFor('bridge'), set.tokenFor('inference'), set.tokenFor('management')])
    expect(secrets.size).toBe(3)
  })

  /**
   * The TUI reads this file at connect time and the engine writes it at startup.
   * If a second load rotated the secrets, every engine restart would lock out a
   * TUI that was already running.
   */
  it('reuses the existing secrets on a later load', () => {
    const first = loadOrCreateTokens(dir)
    const second = loadOrCreateTokens(dir)
    expect(second.tokenFor('bridge')).toBe(first.tokenFor('bridge'))
    expect(second.tokenFor('management')).toBe(first.tokenFor('management'))
  })

  it('replaces a file it cannot parse rather than failing to start', () => {
    writeFileSync(join(dir, TOKEN_FILENAME), 'not json at all', 'utf-8')
    const set = loadOrCreateTokens(dir)
    expect(set.tokenFor('bridge')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('replaces a file that parses but is missing a scope', () => {
    writeFileSync(
      join(dir, TOKEN_FILENAME),
      JSON.stringify({ version: 1, tokens: [{ name: 'tui', scopes: ['bridge'], secret: 'x'.repeat(64) }] }),
      'utf-8',
    )
    const set = loadOrCreateTokens(dir)
    expect(set.tokenFor('management')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not write the secrets anywhere a reader would not expect', () => {
    loadOrCreateTokens(dir)
    const raw = readFileSync(join(dir, TOKEN_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(parsed.tokens.map((t: any) => t.name).sort()).toEqual(['admin', 'dashboard', 'tui'])
  })
})

describe('verification', () => {
  it('accepts a secret for a scope its holder has', () => {
    const set = loadOrCreateTokens(dir)
    expect(set.verify(set.tokenFor('bridge'), 'bridge')).toBe(true)
  })

  /**
   * The whole point of the scope vector. The dashboard page is handed the
   * inference secret in its own HTML, so that secret is the one most likely to
   * leak — it must not be able to flip `ablation` or `contractEnforcement` off
   * and silently corrupt the measurements the research rests on.
   */
  it('refuses a secret for a scope its holder lacks', () => {
    const set = loadOrCreateTokens(dir)
    expect(set.verify(set.tokenFor('inference'), 'management')).toBe(false)
    expect(set.verify(set.tokenFor('bridge'), 'inference')).toBe(false)
  })

  it('lets the admin holder do both of its scopes', () => {
    const set = loadOrCreateTokens(dir)
    const admin = set.tokenFor('management')
    expect(set.verify(admin, 'management')).toBe(true)
    expect(set.verify(admin, 'inference')).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a wrong secret of the right shape', 'a'.repeat(64)],
    ['a prefix of the real secret', null], // filled in below
  ])('refuses %s', (name, presented) => {
    const set = loadOrCreateTokens(dir)
    const value = name === 'a prefix of the real secret'
      ? set.tokenFor('bridge')!.slice(0, 32)
      : presented
    expect(set.verify(value, 'bridge')).toBe(false)
  })
})

/**
 * Separating "I do not know you" from "I know you and you may not do this" is
 * what lets the dashboard answer 401 and 403 differently. Rendering both as 401
 * would tell a holder of the page's own token that its secret was rejected as
 * unrecognised, and send them looking for the wrong fault.
 */
describe('recognising a secret regardless of scope', () => {
  it('knows a secret that lacks the scope being asked for', () => {
    const set = loadOrCreateTokens(dir)
    const inference = set.tokenFor('inference')!
    expect(set.verify(inference, 'management')).toBe(false)
    expect(set.isKnown(inference)).toBe(true)
  })

  it.each([
    ['null', null],
    ['empty', ''],
    ['a wrong secret of the right shape', 'a'.repeat(64)],
  ])('does not know %s', (_name, presented) => {
    expect(loadOrCreateTokens(dir).isKnown(presented)).toBe(false)
  })
})
