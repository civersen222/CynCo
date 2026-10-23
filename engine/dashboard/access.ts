/**
 * Who may load the dashboard page, from where — the pure half of phone access.
 *
 * The dashboard was loopback-only, and GET / hands the page its `inference`
 * token in the HTML. That is safe on loopback because a cross-origin page cannot
 * read the response. It is not safe the moment the dashboard also listens on the
 * owner's Tailscale interface: every device on the tailnet could load GET / and
 * walk away with a token that drives the agent. So a client that is not on this
 * machine gets a page with no token in it, pairs once — types a code the engine
 * printed — and then holds a device token of its own, kept in that browser's
 * local storage and revocable without rotating anyone else's secret.
 *
 * Everything here is a pure function or a small state machine with an injected
 * clock, so the boundary is specified on its own terms (the same reason
 * `dashboardCommandRefusal` is exported from server.ts). server.ts wires it.
 */

import { randomInt, timingSafeEqual } from 'crypto'

// ---------------------------------------------------------------------------
// Where a request came from
// ---------------------------------------------------------------------------

/** `local` is this machine over the loopback listener; everything else — including "could not tell" — is `remote`. */
export type ClientKind = 'local' | 'remote'

/**
 * 127.0.0.0/8, ::1 and their IPv4-mapped / zone-suffixed spellings. An absent
 * or unparseable address is NOT loopback: the safe failure is to ask for
 * pairing, never to hand over the page's token. X-Forwarded-For is deliberately
 * not consulted — nothing in front of this server is trusted to set it.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (typeof address !== 'string') return false
  let a = address.trim().toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  const zone = a.indexOf('%')
  if (zone !== -1) a = a.slice(0, zone)
  if (a === '::1') return true
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length)
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/** `0.0.0.0` / `::` listen everywhere, which the README says not to do; named so the startup log can shout. */
export function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '[::]'
}

/**
 * Local = a loopback peer that arrived on a loopback (or wildcard) listener.
 * Both halves matter: a reverse proxy on this machine (`tailscale serve`, say)
 * hands every phone request to the loopback listener FROM a loopback address,
 * and must still not be local — it must target a non-loopback listener of its
 * own. The desktop opening the Tailscale address of its own machine is
 * `remote` too (its peer is the Tailscale address), which is what lets the
 * phone path be tried from the desk.
 */
export function classifyClient(c: { peer: string | null | undefined; listenerHost: string | null | undefined }): ClientKind {
  if (!isLoopbackAddress(c.peer)) return 'remote'
  const l = (c.listenerHost ?? '').trim()
  if (l.length > 0 && !isLoopbackAddress(l) && !isWildcardHost(l) && l.toLowerCase() !== 'localhost') return 'remote'
  return 'local'
}

/**
 * On the loopback listener the Host header must name this machine. A page at
 * evil.example whose DNS answer is rebound to 127.0.0.1 is same-origin to the
 * browser that loaded it, so it could READ what GET / delivers — the one
 * ungated route, carrying the shared token. Origin never helps there (a
 * navigation sends none). Null when the request may proceed; otherwise the
 * refusal to log. No Host at all is a non-browser client, and allowed.
 */
export function loopbackHostRefusal(hostHeader: string | null | undefined): string | null {
  if (hostHeader === null || hostHeader === undefined || hostHeader.trim() === '') return null
  const name = hostName(hostHeader)
  if (name === 'localhost' || name === '[::1]' || isLoopbackAddress(name)) return null
  return `host ${JSON.stringify(hostHeader)} does not name this machine`
}

/** The name part of a Host header, lower-cased, brackets kept on an IPv6 literal, port dropped. */
function hostName(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colon = h.lastIndexOf(':')
  return colon !== -1 ? h.slice(0, colon) : h
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/
const IPV6_LITERAL = /^\[[0-9a-f:.%]+\]$/

/**
 * The Host rule for every listener. Local (loopback) clients: `loopbackHostRefusal`.
 * Remote clients: the Host must be an IP literal (no DNS was involved, so no
 * rebinding), the listener's own address, or a Tailscale MagicDNS name
 * (`*.ts.net`). Any other DNS name is a rebound one: a page served under it is
 * same-origin to that name, so a pairing code typed into it would put the
 * device token where the attacker's own document can read it, and an Origin
 * equal to that Host would pass the Origin check. Null when the request may
 * proceed; otherwise the refusal to log. No Host at all is a non-browser client.
 */
export function hostRefusal(hostHeader: string | null | undefined, kind: ClientKind, listenerHost: string | null | undefined): string | null {
  if (kind === 'local') return loopbackHostRefusal(hostHeader)
  if (hostHeader === null || hostHeader === undefined || hostHeader.trim() === '') return null
  const name = hostName(hostHeader)
  const listener = (listenerHost ?? '').trim().toLowerCase()
  if (listener.length > 0 && (name === listener || name === `[${listener}]`)) return null
  if (IPV4_LITERAL.test(name) || IPV6_LITERAL.test(name)) return null
  if (name.endsWith('.ts.net')) return null
  return `host ${JSON.stringify(hostHeader)} is not an address of this listener`
}

// ---------------------------------------------------------------------------
// Which addresses the dashboard listens on
// ---------------------------------------------------------------------------

/**
 * `LOCALCODE_DASHBOARD_HOST` is one bind address, or a comma-separated list.
 * The first entry is the primary listener and keeps today's behaviour (port
 * walk, failure is fatal for the dashboard); every further entry is an extra
 * listener on the same port that may fail to bind without taking the dashboard
 * down — the Tailscale interface is simply absent when Tailscale is off.
 */
export function parseListenHosts(raw: string | undefined, fallback = '127.0.0.1'): string[] {
  const hosts = (raw ?? '').split(',').map(h => h.trim()).filter(h => h.length > 0)
  const unique = hosts.filter((h, i) => hosts.indexOf(h) === i)
  return unique.length > 0 ? unique : [fallback]
}

// ---------------------------------------------------------------------------
// The pairing code
// ---------------------------------------------------------------------------

export const PAIRING_CODE_LENGTH = 6
/** Wrong codes before pairing locks. 10^6 codes at five tries per ten minutes is years of guessing, and the code rotates with every use and every lockout. */
export const PAIRING_MAX_FAILURES = 5
export const PAIRING_LOCKOUT_MS = 10 * 60_000
/** Paired devices a token file may hold. Past this, revoke one first. */
export const MAX_DEVICES = 20

export function mintPairingCode(): string {
  return String(randomInt(0, 10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, '0')
}

export type PairingAttempt =
  | { ok: true }
  | { ok: false; reason: 'wrong' | 'locked'; retryAfterMs: number; attemptsLeft: number }

/**
 * One pairing code at a time, in memory, single-use. A successful pair
 * rotates it (so a code glimpsed on a screen or found in a log pairs nothing
 * later), and so does a lockout. An engine restart mints a fresh one; the
 * devices already paired keep their persisted tokens. While locked, even the
 * right code is refused — otherwise a guesser's sixth try is free. Check and
 * count happen in one synchronous call, so concurrent attempts cannot all
 * slip past the lock before any of them is counted.
 */
export class PairingGate {
  private current: string
  private failures = 0
  private lockedUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    code: string = mintPairingCode(),
    /** Told the new code whenever it rotates — the engine prints it. */
    private readonly onRotate: (code: string, why: 'used' | 'locked' | 'asked') => void = () => {},
  ) {
    this.current = code
  }

  get code(): string { return this.current }

  /** Milliseconds until pairing is accepted again; 0 when open. */
  lockedForMs(): number {
    return Math.max(0, this.lockedUntil - this.now())
  }

  /**
   * A fresh code. Asked for from the desk (management scope — the owner acting),
   * it also lifts a lockout: a guesser on the tailnet must not be able to keep
   * the owner from pairing until the engine restarts, and the fresh code
   * carries the full code space again.
   */
  rotate(why: 'used' | 'locked' | 'asked' = 'asked'): string {
    this.current = mintPairingCode()
    if (why === 'asked') { this.lockedUntil = 0; this.failures = 0 }
    this.onRotate(this.current, why)
    return this.current
  }

  attempt(presented: unknown): PairingAttempt {
    const locked = this.lockedForMs()
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked, attemptsLeft: 0 }
    const given = typeof presented === 'string' ? presented.replace(/[\s-]/g, '') : ''
    const a = Buffer.from(given, 'utf-8')
    const b = Buffer.from(this.current, 'utf-8')
    const match = a.length === b.length && timingSafeEqual(a, b)
    if (match) {
      this.failures = 0
      this.rotate('used')
      return { ok: true }
    }
    this.failures += 1
    if (this.failures >= PAIRING_MAX_FAILURES) {
      this.failures = 0
      this.lockedUntil = this.now() + PAIRING_LOCKOUT_MS
      this.rotate('locked')
      return { ok: false, reason: 'locked', retryAfterMs: PAIRING_LOCKOUT_MS, attemptsLeft: 0 }
    }
    return { ok: false, reason: 'wrong', retryAfterMs: 0, attemptsLeft: PAIRING_MAX_FAILURES - this.failures }
  }
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * Null when a browser request may proceed; otherwise the refusal to log.
 *
 * The page is served from this origin, so a browser's Origin names the Host it
 * loaded from — any other Origin is some other page trying to drive this
 * server through the browser. No Origin at all is a non-browser client (the
 * Python driver, a test), which the token still gates. Compared on host:port
 * only: the scheme may legitimately differ behind a TLS proxy later, the host
 * may not. Applied where a request carries no bearer token of its own:
 * the socket handshake and POST /api/pair.
 */
export function originMismatch(origin: string | null | undefined, host: string | null | undefined): string | null {
  if (origin === null || origin === undefined || origin === '') return null
  if (origin === 'null') return 'opaque origin'
  let o: URL
  try { o = new URL(origin) } catch { return `unparseable origin ${JSON.stringify(origin)}` }
  const expected = (host ?? '').trim().toLowerCase()
  if (expected.length === 0) return 'no Host header to match the origin against'
  if (o.host.toLowerCase() === expected) return null
  return `origin ${o.host} does not match host ${expected}`
}

// ---------------------------------------------------------------------------
// The device token in the browser, and the pairing page
// ---------------------------------------------------------------------------

/** Where a paired browser keeps its device secret. Origin-scoped (host AND port), unlike a cookie. */
export const DEVICE_TOKEN_STORAGE_KEY = 'cynco_device_token'

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
export const escapeHtml = esc

/**
 * What a not-yet-paired client gets at /pair: a code box and a name box,
 * posting to /api/pair; on success the returned device token goes into local
 * storage and the page reloads `/`, where the prelude finds it. Carries no
 * token and nothing about the engine. One document, no dependencies, readable
 * on a phone.
 */
export function pairingPage(opts: { locked?: boolean; retryAfterMs?: number; revoked?: boolean } = {}): string {
  const minutes = Math.max(1, Math.ceil((opts.retryAfterMs ?? 0) / 60_000))
  const notice = opts.locked
    ? `<p class="err">Too many wrong codes. Pairing is closed for about ${minutes} minute${minutes === 1 ? '' : 's'}.</p>`
    : opts.revoked
      ? '<p class="err">This device is no longer paired. Pair it again with a fresh code.</p>'
      : ''
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with CynCo</title>
<style>
body{margin:0;background:#1e1e1e;color:#d4d4d4;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;min-height:100dvh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{width:100%;max-width:360px}
h1{font-size:20px;color:#4ec9b0;margin:0 0 8px}
p{margin:0 0 12px;color:#a0a0a0;font-size:14px}
label{display:block;font-size:13px;color:#808080;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;background:#252525;color:#d4d4d4;border:1px solid #444;border-radius:8px;padding:12px;font-size:18px}
input:focus{outline:none;border-color:#4ec9b0}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:8px;background:#4ec9b0;color:#1e1e1e;font-size:16px;font-weight:600}
button:disabled{opacity:.5}
.err{color:#f48771}
</style></head>
<body><main>
<h1>Pair this device with CynCo</h1>
<p>Enter the pairing code from Config &rarr; Phone access on the computer's dashboard (the engine prints it in its log too). Each code works once.</p>
${notice}
<form id="f" autocomplete="off">
<label for="code">Pairing code</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="${PAIRING_CODE_LENGTH + 2}" required ${opts.locked ? 'disabled' : 'autofocus'}>
<label for="label">Name this device</label>
<input id="label" name="label" placeholder="e.g. Pixel" maxlength="40" ${opts.locked ? 'disabled' : ''}>
<button type="submit" ${opts.locked ? 'disabled' : ''}>Pair</button>
<p class="err" id="msg" role="alert"></p>
</form>
</main>
<script>
(function () {
  var f = document.getElementById('f'), msg = document.getElementById('msg'), btn = f.querySelector('button');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    btn.disabled = true; msg.textContent = '';
    var body = { code: document.getElementById('code').value, label: document.getElementById('label').value };
    fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        var j = res.body || {};
        if (res.status === 200 && j.token) {
          try { localStorage.setItem('${DEVICE_TOKEN_STORAGE_KEY}', j.token); } catch (err) { msg.textContent = 'This browser cannot store the pairing (private mode?).'; btn.disabled = false; return; }
          location.replace('/');
          return;
        }
        msg.textContent = j.error || ('Pairing failed (' + res.status + ')');
        btn.disabled = res.status === 429;
      })
      .catch(function () { msg.textContent = 'Could not reach the engine.'; btn.disabled = false; });
  });
})();
</script>
</body></html>`
}
