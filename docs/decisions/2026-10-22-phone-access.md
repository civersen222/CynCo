# Reach the dashboard from the phone over the tailnet, behind pairing — not a second client, not a public port

**Date:** 2026-10-22
**Status:** Accepted (slice 1 built; the owner's phone test and the access-model confirmation are the next step)
**Guard:** `engine/__tests__/dashboard/phoneAccess.test.ts`, `engine/__tests__/dashboard/access.test.ts`, `engine/__tests__/bridge/abortIsATurnEnd.test.ts`, `engine/__tests__/security/deviceTokens.test.ts`

## What was there

The dashboard (`engine/dashboard/server.ts` + `index.html`) listened on `127.0.0.1` only. Its one
ungated route, `GET /`, injected the shared `inference` token into the page; every API route and
the `/ws` socket took that token; the Chat tab's frames passed an allowlist. Loopback was treated
as the exposure model, and README said of `0.0.0.0`: "Don't."

The repository already had one phone channel: the liveness daemon pushes recommendations to the
phone over self-hosted ntfy bound to the Tailscale interface, "never 0.0.0.0", no public ports
(`docs/liveness-setup.md`). Tailscale runs on the CynCo box (node `100.101.192.101`, MagicDNS,
no HTTPS certificates, no `tailscale serve` config) and the phone is on the tailnet.

The engine's `abort()` cleared `processing` the instant it was called while the aborted turn went
on unwinding, emitted no terminal frame, and the busy guard dropped a message sent mid-turn with
one stdout line. The TUI's Esc had the same defects; a terminal hid them.

## What the owner asked for

From the phone: pair securely; see connection and run state; send a prompt to the existing
engine; see the streamed answer and tool activity; see running / completed / failed; stop a
running turn. No second engine, no second chat implementation, nothing bound beyond loopback by
default, and the access model decided before anything is exposed.

## Decision

**Access model: the owner's Tailscale tailnet only.** WireGuard encrypts the hop; no public port;
never `0.0.0.0`; never Funnel. The repository's existing phone channel set this posture and the
machine already runs it. Plain HTTP inside the tunnel for slice 1 (certificates are not enabled).

**Transport: the dashboard, with an additive listener.** `LOCALCODE_DASHBOARD_HOST` takes a
comma-separated list. The first entry is the desk's listener, unchanged (port walk, failure is
fatal). Every further entry — the Tailscale address — is an extra listener on the same port that
may fail to bind without costing the dashboard, retried every 15 s (Tailscale's adapter is absent
when Tailscale is off, or not yet up at login). Loopback stays bound because the mission driver,
`cynco-endpoints.mjs` and `project-chat-drive.mjs` read `127.0.0.1:<port+1>`, and because
loopback is the classification key below. The bridge is untouched.

**Classification: where a request came from decides what it may get.** `local` = a loopback peer
on a loopback (or wildcard) listener; everything else is `remote`, including an address Bun could
not read and the desk opening its own Tailscale address (which is how the phone path is tried
from the desk). A reverse proxy on the box must therefore target a non-loopback listener of its
own: proxying into the loopback listener would make every phone request `local`. The `Host`
header is checked on every listener (DNS rebinding): on loopback it must name this machine; on
the Tailscale listener it must be an IP literal, the listener's own address or a `*.ts.net`
MagicDNS name — a page served under a rebound name would otherwise be same-origin to it and keep
the pairing typed into it. Both pages refuse framing.

**Pairing, and what a phone holds.** A remote `GET /` serves the page with no token in it; its
prelude reads the device token the browser stored when it paired, or sends the browser to
`/pair`. The engine mints one 6-digit code at startup, prints it, and rotates it on every use and
every lockout (five wrong codes close pairing for ten minutes). `POST /api/pair` (remote only,
`application/json`, Origin must be this origin) answers with a `device-<8 hex>` record appended to
`~/.cynco/tokens.json` — `inference` scope, atomic write, owner-only permissions re-applied — and
the browser keeps the secret in `localStorage` (origin-scoped: host and port). **Off this machine
only a device record authenticates**: the shared `dashboard` and `admin` secrets are refused there
as unknown, so management is desk-only by construction, and the page never prompts a phone for
the management token.

**Revocation.** `GET /api/phone` (management) lists the code, the listeners, the devices and when
a remote request last arrived; `POST /api/phone/revoke` removes the record and closes that
device's sockets with code 4001; the device's page then meets a 401, drops its stored token and
returns to `/pair`. The Config tab's "Phone access" panel is the desk's view of this.

**The engine tells the truth about a turn.** `processing` stays true until an aborted turn has
unwound (a Bash child still running, a stream that has not yielded its next event); Stop also
denies a parked approval card and withdraws a parked AskUser question, so a turn waiting on a
person ends too; the loop
issues no further model call once stopped; the end is marked by `message.complete
{ stopReason: 'aborted' }`; the busy guard answers `session.error "busy: …"` on the wire; the
decisions the engine is waiting on (approval cards, AskUser questions) ride `/api/session` as
`pending`, so a page that connects mid-turn draws them. The page's Stop button sends `abort`, its
send box refuses while a turn is open, it reconnects on wake, and it settles from `/api/session`.

## Rejected alternatives

**1. `tailscale serve` in front of the loopback dashboard.** Rejected for slice 1: HTTPS
certificates are not enabled on this tailnet; proxied requests arrive on the loopback listener
from a loopback peer, which would need listener-identity classification and a dedicated listener
anyway; and it moves the exposure decision into tailscaled's persistent config. It remains the
route to HTTPS and an installable page later, targeting the Tailscale listener.

**2. A cookie carrying the device secret.** Rejected: cookies are keyed by host, not port, so the
secret would be sent to ntfy on the same Tailscale address and to anything else bound there;
`SameSite` reasoning and `Set-Cookie` plumbing bought nothing the origin-scoped `localStorage`
does not. `GET /` therefore stays ungated on both listeners and simply serves no token off this
machine.

**3. `0.0.0.0` with a peer-address allowlist.** Rejected: README's rule stands for a reason, and
binding the one interface that should carry the traffic needs no allowlist.

**4. Device records in a separate `devices.json`.** Rejected: one token file with one record shape
is the existing design ("one record shape carrying a scope vector"); device records are appended
after the three minted ones so `tokenFor('inference')` keeps returning the dashboard's secret, and
`revokeDevice` refuses anything not named `device-*`.

**5. Closing the turn on the page when Stop is pressed.** Rejected: twenty-five lines of guessing
that lie whenever a tool is still finishing. The engine already knows when the turn ended; one
emit replaces the heuristics.

**6. A general Origin policy on every POST and the socket.** Deferred, not adopted: bearer tokens
are not ambient credentials, so only the two requests that carry none — the handshake and
`POST /api/pair` — check Origin. A wider policy changes the stated CORS posture and gets its own
record if it is ever needed.

## Not covered, on purpose

Real cancellation (forwarding the abort signal into the provider fetch and killing a Bash child);
rebuilding text streamed while the phone was away (the loop's session id is not on the wire);
device `lastSeen`, expiry and "revoke all"; a tailnet ACL limiting the port to the owner's
devices; HTTPS, an installable page and push notifications; project-chat tuning on a phone. A
paired phone is equivalent to a terminal on this machine: it drives the agent through the same
allowlisted frames as the desk page and may approve its own Bash cards. Revoke a lost phone.

## Verification

Vitest: the four guard files above plus the existing dashboard, bridge-server and token suites.
Real runtime: Bun 1.3 on Windows binds the same port on `127.0.0.1` and `100.101.192.101`
(probed), throws synchronously for an unbindable host, and reports the peer and the listener per
request. End to end: an engine against a stub model, the desk page on loopback and the phone path
from the desk via the Tailscale address (pair, prompt, stream, Stop, revoke). The owner's own
phone, Windows Firewall for `bun.exe` on the Tailscale interface, and iOS/Android keyboard
behaviour are manual checks that remain.
