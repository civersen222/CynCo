# Post-Change Verification (mandatory)

> Canonical, tracked copy. CLAUDE.md is gitignored in this repo — it mirrors this
> section for agent context, but this file is the source of truth.

After EVERY change set (feature, fix, refactor), before moving on:

1. Run both suites: `npm test` (includes the guard tests in `engine/__tests__/guards/`) and `cd tui && python -m pytest tests/ -q`. Any guard failure is a stop-the-line bug.
2. New engine→TUI protocol event types must be emitted AND handled in the same PR (or added to the guard allowlist with a written reason).
3. Empty `catch {}` / `except: pass` blocks are banned — log the error or emit a governance.alert. The ratchet tests enforce this (comment-only bodies count as silent too).
4. Any README capability claim must cite a default-ON code path; opt-in features must be labeled opt-in with their env flag.
5. Every plan's final task greps all new symbols to prove they are imported and called on a live path (wire check — BLOCKING).

Quick command: `npm run audit:wiring` runs the guard suite alone.
