/**
 * Local capability tokens for the bridge and the dashboard.
 *
 * Both servers bind loopback, and loopback was treated as the whole defence.
 * It is not. A browser is already inside loopback: a page load could open a
 * WebSocket to the bridge, displace the TUI, and send a UserMessageCommand to
 * an agent that has Bash; and it could POST to the dashboard's /config/* routes
 * whether or not it could read the reply. Neither needed a network hop.
 *
 * So the servers ask for a secret this process minted. Shape follows
 * Millwright's ApiKey { name, team, key_hash, scopes }: ONE record type with a
 * scope vector, not one type per capability. What a holder may do is data on the
 * record, so adding a capability does not add a branch to every call site.
 *
 * The secrets are stored, not hashed. Hashing protects a server operator from
 * seeing user credentials; here the engine both mints and verifies, and the TUI
 * needs the cleartext to send. A hash would only mean keeping the cleartext
 * somewhere else as well.
 */

import { randomBytes, timingSafeEqual } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'

export const TOKEN_FILENAME = 'tokens.json'

/**
 * - `bridge`      drive the agent over the WS bridge. This is Bash. Only the TUI.
 * - `inference`   read governance/session/thinking data and the event stream.
 * - `management`  mutate engine and governance config.
 */
export type TokenScope = 'bridge' | 'inference' | 'management'

export type LocalToken = {
  name: string
  scopes: TokenScope[]
  secret: string
}

type TokenFile = { version: 1; tokens: LocalToken[] }

const REQUIRED_SCOPES: TokenScope[] = ['bridge', 'inference', 'management']

function mint(): TokenFile {
  const secret = () => randomBytes(32).toString('hex')
  return {
    version: 1,
    tokens: [
      // The TUI, and nothing else. Held by a local process, never by a page.
      { name: 'tui', scopes: ['bridge'], secret: secret() },
      // Injected into the dashboard's own HTML at request time, so the page gets
      // it for free and a hostile page cannot read that response cross-origin.
      { name: 'dashboard', scopes: ['inference'], secret: secret() },
      // Printed once at startup and pasted by hand. A config mutation should
      // cost one deliberate action.
      { name: 'admin', scopes: ['inference', 'management'], secret: secret() },
    ],
  }
}

function isUsable(parsed: unknown): parsed is TokenFile {
  if (typeof parsed !== 'object' || parsed === null) return false
  const f = parsed as TokenFile
  if (f.version !== 1 || !Array.isArray(f.tokens)) return false
  const held = new Set(f.tokens.flatMap(t => t?.scopes ?? []))
  return f.tokens.every(t => typeof t?.secret === 'string' && t.secret.length > 0)
    && REQUIRED_SCOPES.every(s => held.has(s))
}

/**
 * Tighten the file to the current user.
 *
 * chmod 0600 is close to a no-op on Windows — it clears the read-only bit and
 * nothing more, so claiming the file is protected on the strength of it would be
 * a claim nobody measured. icacls is what actually removes inherited access, so
 * on win32 that is what runs. A failure is logged rather than swallowed: the
 * file still exists and the engine still starts, but nobody should believe it is
 * locked down when it is not.
 */
function restrictToOwner(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch (e) {
    console.warn(`[tokens] chmod failed on ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) {
    console.warn(`[tokens] USERNAME unset — cannot restrict ACLs on ${path}; it may be readable by other local accounts`)
    return
  }
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' })
  } catch (e) {
    console.warn(`[tokens] icacls failed on ${path}: ${e instanceof Error ? e.message : String(e)} — the file may be readable by other local accounts`)
  }
}

export class TokenSet {
  constructor(private readonly file: TokenFile) {}

  /** The secret to present for `scope`, or null if nothing holds it. */
  tokenFor(scope: TokenScope): string | null {
    return this.file.tokens.find(t => t.scopes.includes(scope))?.secret ?? null
  }

  /**
   * Does `presented` belong to a holder of `scope`?
   *
   * Compared byte-for-byte in constant time against every holder of the scope.
   * Unequal lengths short-circuit — the length of a fixed 64-char hex secret is
   * not the part worth hiding, and timingSafeEqual throws on a length mismatch.
   */
  verify(presented: string | null | undefined, scope: TokenScope): boolean {
    return this.match(presented, t => t.scopes.includes(scope))
  }

  /**
   * Is `presented` a secret this process minted, whatever its scopes?
   *
   * Lets a caller separate "I do not know you" from "I know you and you may not
   * do this" — 401 from 403. Says nothing about authorization on its own.
   */
  isKnown(presented: string | null | undefined): boolean {
    return this.match(presented, () => true)
  }

  private match(presented: string | null | undefined, eligible: (t: LocalToken) => boolean): boolean {
    if (!presented) return false
    const given = Buffer.from(presented, 'utf-8')
    let ok = false
    for (const t of this.file.tokens) {
      if (!eligible(t)) continue
      const expected = Buffer.from(t.secret, 'utf-8')
      if (expected.length !== given.length) continue
      // No early return: keep comparing so the work does not depend on which
      // holder matched.
      if (timingSafeEqual(expected, given)) ok = true
    }
    return ok
  }
}

/**
 * Read `<dir>/tokens.json`, or mint and persist it.
 *
 * A file that cannot be parsed, or that predates a scope we now need, is
 * replaced. Rotating secrets locks out a TUI that is already running, but the
 * alternative is refusing to start, and a bad token file must not be the thing
 * that stops the engine coming up.
 */
export function loadOrCreateTokens(dir?: string): TokenSet {
  const base = dir ?? join(homedir(), '.cynco')
  mkdirSync(base, { recursive: true })
  const path = join(base, TOKEN_FILENAME)

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (isUsable(parsed)) return new TokenSet(parsed)
  } catch (e) {
    // ENOENT on a first run is the ordinary path and says nothing. Anything else
    // means a token file exists and could not be read, and minting over it will
    // lock out every client already holding the old secret — that must be said
    // out loud rather than swallowed.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[tokens] ${path} unreadable (${e instanceof Error ? e.message : String(e)}) — minting a replacement; running clients must reconnect`)
    }
  }

  const file = mint()
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  restrictToOwner(path)
  return new TokenSet(file)
}
