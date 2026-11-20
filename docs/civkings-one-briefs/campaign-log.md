
## C20 wave 1 — c20-wave1-1795150424424 (graded 2026-11-20, BASE 801fd173ff53310fb16a6aa17baff32d60ad5a4a → HEAD d96b3cdffa61e27a232a31a39178d96371730e19)

- 163 tool calls, exitReason engine_closed_the_turn (5583s = 1.55h), 4 commit(s). maxCallsWithoutSourceEdit 27, maxCallsWithoutCommit 93. CodeIndex 0/163. graderProbes 0/163. Invariants: engine denied 0 call(s) (edit-gap 0, commit-gap 0, revert 0), 0 revert refusal(s), 0 CodeIndex-assisted Grep(s).
- Bash by effect: read 31, write 2, run 46, commit 2, revert 0, other 3 (sum 84 vs byName.Bash 84 — agree).
- Routing: 0 verify-first (revert 0, low-confidence edit 0): passed 0, failed 0, cached 0, could not run 0 (0/6 KEEP-GREEN runs spent).
- **Sealed gate at d96b3cdffa61e27a232a31a39178d96371730e19: PASS (0 fails).** 
  - PASS: C20.1a.old-ui-gone, C20.1b.nothing-imports-old-ui, C20.1c.simulation-tests-kept, C20.1d.simulation-green, C20.1e.simulation-untouched, C20.2a.every-turn-saves, C20.2b.saved-game-plays-on, C20.2c.chain-choices-unchanged, C20.3a.new-game, C20.3b.smoke-reads-back, C20.3c.smoke-can-fail
- Suite gate PASS: REGRESSED 0, REPAIRED 2.
- Derived sweep: UNMEASURED — sweep refused (exit 2): C:/Users/civer/civkings-one 801fd173ff53310fb16a6aa17baff32d60ad5a4a..d96b3cdffa61e27a232a31a39178d96371730e19 (and again on the --mutate retry).
- POSIWID Consistent (divergence 0.028, dominant inspect).
- Governance POSIWID v1 Contradicted (divergence 6.910, dominant signalsLogged, support 146; drift onset wave 1) | v2 Consistent (0 of 8 earned).
- Ledger: verified true; mutationSweep null.
- Identity: intact
- Autopoiesis: 3/6 — missing boundarySelfProduced, circularProduction, organizationallyClosed
- Progress: 8 → 0 fails over 3 readings (first fix at 30 min; last at 91 min: 0); R1.no-progress did not fire (3 decision(s)); R2.stalled did not fire (3 decision(s))
- Scoreboard: PASS/GPU-h 0.645 | waves 1 | lines fixed per landed wave 8.00 | human interventions per wave 0.00 | rules predictive 0/8 (best I3 58% NO EVIDENCE)
- Outcome hindcast: UNMEASURED — v2 holdout not yet frozen (2 of 38 labeled; eligible by version: v1: 106, v2: 2); R1.no-progress precision null on 0 fired p(Holm) null UNMEASURED — fired on no in-scope wave; R2.stalled precision 100% [21, 100] on 1 fired p(Holm) 1.000 TOO FEW; readings: UNMEASURED — reading holdout not yet frozen (17 of 38 labeled; improved 7 / stalled 10; need 8 of each)
- Denials (campaign to date): edit-gap 0/0 (TOO FEW); commit-gap 0/0 (TOO FEW); revert 0/0 (IDENTITY).
- Gate lines: cynco 0/0 held (rate —, ci [0.00, 1.00]) vs human 90/94; TOO FEW

Economics after this wave: VERDICT: from 2026-09-17 on, frontier spent $2308.68 SUPERVISING (development $12724.79 and unattributed $76.94 are excluded — building LocalCode is not oversight). The supervised generation would have cost ~$779.66 on the API ($779.66 priced from measured tokens, $0.00 still estimated) and ran locally for ~$5.06 of power. supervision ratio: $1 of frontier verify oversees ~$0.34 of displaced generation. This counts 15 mission(s) dispatched from 2026-09-17 on (the first day a transcript still on disk carries); 79 earlier one(s) are left out, because the transcripts of the sessions that supervised them are no longer on disk. It is not a running total.

Verdict: **CAMPAIGN PASS** — sealed gate PASS, suite gate PASS, sweep unmeasured
