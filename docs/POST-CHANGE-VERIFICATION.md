# Post-Change Verification (mandatory)

> Canonical copy. `CONVENTIONS.md` points here for agent context; this
> file is the source of truth.

After EVERY change set (feature, fix, refactor), before moving on:

1. Run both suites: `npm test` (includes the guard tests in `engine/__tests__/guards/`, among them the strict type-check — `npm run typecheck` runs it alone and prints the errors) and `cd tui && python -m pytest tests/ -q`. Any guard failure is a stop-the-line bug.
2. New engine→TUI protocol event types must be emitted AND handled in the same PR (or added to the guard allowlist with a written reason).
3. Empty `catch {}` / `except: pass` blocks are banned — log the error or emit a governance.alert. The ratchet tests enforce this (comment-only bodies count as silent too).
4. Any README capability claim must cite a default-ON code path; opt-in features must be labeled opt-in with their env flag.
5. Every plan's final task greps all new symbols to prove they are imported and called on a live path (wire check — BLOCKING).
6. Report every check as *ran and passed*, *ran and failed* or *not run* — never as passed by implication. A failing test is never reported as acceptable, whatever its age (the owner's rule, 2026-11-24; F245): a failure that was there before the change is the first thing to investigate, so read its output, find what changed on the machine or in the code, fix it and say what it was. Open every environment gate that needs nothing outside the process at least once, and name every test that is skipped on this machine with its reason (`npx vitest run --reporter=verbose` shows the reasons; under an agent's shell the default reporter hides them). `jlens/tests` runs inside `npx vitest run` (`scripts/__tests__/jlens-python.test.mjs`); it is skipped by name where no Python with pytest is on PATH, and then `cd jlens && python -m pytest tests -q -rs` is run by hand where there is one. A timeout or a permissions error is a failure to run, not a pass.

Quick command: `npm run audit:wiring` runs the guard suite alone.
