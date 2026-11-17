# WebFetch resolves a name before it connects (2026-11-17)

**Status:** built. Asked for by the owner as mission B1 of the 2026-11-17 work order
(`docs/reviews/2026-11-17-work-order-triage.md`); it is item 6 of the 2026-10-27 review, which
`docs/NOW.md` had held as "a boundary change, owner's yes first".

## The problem

`WebFetch` and `AddToKnowledge` by URL go through `fetchGuarded`
(`engine/tools/impl/webFetch.ts`). It refused a literal private address in every spelling and
re-checked each redirect hop, but it never looked a name up. A public name that resolves to
127.0.0.1 passed, so a page the model was told to fetch could hand it this PC's own dashboard:
`http://localtest.me:9161/` is such a name, and it is in public DNS.

## What was decided

1. **No new range.** A name is held to exactly the ranges a literal address already was:
   0/8, loopback, 10/8, 172.16/12, 192.168/16, link-local 169.254/16, carrier-grade NAT
   100.64/10 (the tailnet), multicast and reserved; IPv6 loopback, unique-local, link-local
   and IPv4-mapped forms of the above. The tool has always described itself as "Only allows
   public HTTP/HTTPS URLs", and nothing in the engine reaches a private address through it:
   the image box and the vision model bypass it on purpose (`engine/imagegen/client.ts`,
   `engine/vision/lookClient.ts`). So this closes a way around a boundary that was already
   drawn; it does not move the boundary.
2. **Any one address refuses the name.** A name with a public address and a private one is
   refused: which one a connection would use is not the model's to choose.
3. **The request goes to the address that was checked.** Checking and then handing the name
   to `fetch` would let a DNS server answer differently the second time. The default request
   (`pinnedFetch`) connects to the checked address with the name in `Host` and in the TLS
   handshake. Measured under Bun 1.3.13: the right name is served, a wrong name and no name
   both fail the handshake, so the certificate is still checked against the name.
4. **A name that does not resolve fails as it always did**, as a fetch error, not as a
   refusal.

## What it costs

- One lookup per hop before the request.
- A pinned request has no fallback of its own, so IPv4 is tried first and one more address
  when the first cannot be reached. A site reachable only over its third address is not
  reached.
- `fetchGuarded` takes an options object (`fetch`, `resolve`, `maxRedirects`). A test that
  injects a fetch injects a lookup too; one that does not gets the real resolver and fails
  loudly on a made-up host, which is the point.

## What it does not cover

- NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and site-local (`fec0::/10`) IPv6 forms of a
  private address. They were not refused as literals either, and they are new ranges: the
  owner's to add (`docs/NOW.md`).
- `tls.serverName` is Bun's option. The engine runs under Bun; under another runtime the
  pinned HTTPS request would fail closed, not open.
- `WebSearch` and the research engines make their own requests to fixed public hosts and
  are unchanged.

## How it is verified

`engine/tools/impl/__tests__/webFetch.test.ts`: a name resolving to each refused range, one
private address among public ones, a private hop three redirects in (never requested), the
address handed to the request, the IPv4-first order and the second try, and the tool itself
refusing this machine's own name through the real resolver. With the one refusing line taken
out, five of them fail. Run once against the real network under Bun: `https://example.com/`
and a redirecting GitHub URL are fetched, `http://localtest.me:9161/` is refused with
"localtest.me resolves to 127.0.0.1 (loopback)".

## How it is undone

There is no switch, on purpose: a way to turn the lookup off is a way around it. Reverting
the commit restores the old behaviour.
