# NOW — what CynCo is working on

One current objective at a time. Adjacent ideas go to the backlog, not into the current diff.
Changing the first section is the owner's decision. Rules: `AGENTS.md` → "How to change CynCo".

## Current objective

**Phone access, slice 1 — built 2026-10-22, verified on the owner's phone 2026-10-27.**

Use CynCo's existing engine and dashboard from the owner's phone over the owner's Tailscale
tailnet. Done when, on the phone: open the phone URL → pair once with the printed code → see
connection and run state → send a prompt → watch the streamed answer and tool rows → stop a
running turn. Nothing is bound beyond loopback by default; no second engine, chat implementation
or client codebase. Design and rejected alternatives: `docs/decisions/2026-10-22-phone-access.md`;
how to use it: README → Phone access.

Verified 2026-10-27 on the owner's Pixel 7 Pro over the tailnet: the engine launched from the TUI
with `LOCALCODE_DASHBOARD_HOST=127.0.0.1,100.101.192.101`, the phone paired on the first code,
a prompt streamed and Stop ended a turn; no firewall change was needed. The access model (tailnet
only, plain HTTP inside the tunnel) is confirmed by use. What is left of this objective is the
merge of PR #173 on GitHub and, once the owner is satisfied, making the variable permanent
(`setx`). The next objective is the owner's choice; Next 1 below is the candidate.

## Next (in rough order)

1. **The rest of the phone channel the owner decided on 2026-10-05** (the projects-mode brainstorm,
   recorded only in that chat: "phone = a dashboard page over Tailscale", uploads, inbox):
   photos and files from the phone into a project (upload route hardening), and an inbox where
   away-time work lands as drafts the owner accepts. Slice 1 is the page, the Tailscale bind and
   pairing; these two are what make the phone useful for projects rather than only for chat.
2. **Real cancellation.** Forward the turn's abort signal into the provider fetch
   (`engine/engine/callModel.ts` → the Ollama / llama.cpp clients) and give the Bash tool a way
   to kill its child, so Stop stops the GPU and the shell, not only the loop (F180's open item).
3. **HTTPS and an installable page.** Enable certificates on the tailnet and point
   `tailscale serve` at the Tailscale listener (never the loopback one — see the decision
   record), then a web manifest so the phone installs the page. Prerequisite for push.
4. **Rebuild what streamed while the phone was away.** Put the loop's session id on
   `/api/session` so a reconnecting page can fetch the transcript tail instead of showing a gap.
5. **Tell the phone when the engine waits.** When an approval card or AskUser question opens and
   no client is connected, push through the existing ntfy channel (`engine/daemon/ntfyChannel.ts`).
6. **Device hygiene.** `lastSeen` per device, an expiry, "revoke all", and a tailnet ACL note
   limiting the dashboard port to the owner's devices.

## Backlog (worth doing, not started)

- `CYNCO.md` still carries an architecture sketch that trails `docs/MANUAL.md`; decide whether it
  stays a conventions file only.
- Repository root carries stray artefacts: eight `preflight_l4*.ts` files, a `Userscivercivkings/`
  folder, an untracked `engine.log`; twelve worktrees under `.claude/worktrees` and `.worktrees`.
- The engine suite has nine files failing on this Windows box before any change (EPERM on temp
  directories, 5 s timeouts in loop-integration tests) — see the baseline in the 2026-10-22 report;
  either fix the temp-dir handling or mark them as needing a clean environment.
- The dashboard page is one 6,900-line file; its tests lift functions by text. Fine while it
  works; a split is justified only by a concrete change that it blocks.
- A remote page's Config tab still shows sliders whose writes are refused; hide them when
  `window.__CYNCO_REMOTE`.
- The management-token prompt on the desk is a `window.prompt`; a small inline field would be
  friendlier.

## Deferred (decided not now, and why)

- **Public-internet access.** Needs TLS termination, stronger authentication, rate limiting and
  abuse handling; the tailnet covers the owner's actual use. Revisit only with a concrete need.
- **A native phone app or a second client codebase.** The dashboard page is the client until it
  meets something it cannot do.
- **A second agent or engine implementation for mobile.** The engine is the engine.
- **A general Origin policy on every dashboard POST.** Bearer tokens are not ambient credentials;
  only the handshake and `POST /api/pair` check Origin. Its own decision record if ever needed.
