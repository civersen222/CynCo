# CivKings Redesign — Campaign Log

Plan: `docs/civkings-redesign-plan.md` · Spec: `docs/civkings-redesign-spec.md`
Gates (sealed, outside repo): `~/.cynco/heldout/civkings-redesign/c<N>/`

| campaign | BASE commit | gate sha256 | calib BASE | calib STUB | waves | verdict |
|---|---|---|---|---|---|---|
| C1 — the sim becomes visible | 2092b0c | f2dd97feb5db182f | clean MISS (8 surface fails, exit 1, no traceback) | discriminators FAIL both seeds: G1.1c, G1.3a.season/inquiry/deflection, G1.3c, G1.4a.verbs | wave 1 MISS (ledger c1-wave1-1787631354668: landed, verified False, markerSeen False; gate: acts+registry missing ×2 seeds; ladder/beats landed as methods with domain beat kinds — substance real, shape wrong) · wave 2 dispatched (adapt-shape brief c1-wave2.txt, BASE 185e9ec) | **PASS** — wave 2 (ledger c1-wave2-1787667568006, 784 turns): driver verify PASS 7166ms; hand re-run exit 0, 149 checks 0 fails; marker exact in a418d49 with wire-check proof; frames rendered (Briefing ladder + Gazette headlines, seed 7 t8); sweep 4/25 killed (record #236) — 15/21 survivors sit in the committed `_c1_selfcheck.py` probe, not game logic; real-logic survivors: acts.py:25/:41, beats.py:139/189/199/201 (thin-tests residual, carried to close-out) |
| C2 — the player has a stake | a418d49 | 1f6b4bc6ca740b5b | clean MISS (13 fails: 9 surface + 4 derived; 150 PASS incl. the full C1 chain green; exit 1, no traceback) | discriminators FAIL all 3 seeds: G2.4b.t4 ×3, G2.2c, G2.3.failable; 180 checks PASS | wave 1 MISS (ledger c2-wave1-1787691757144: landed, verified False, 659 turns; exactly one gate fail — G2.2b `AttributeError("'Character' object has no attribute 'want'")`, wants only derived inside set_ambition, absent at boot; CynCo misdiagnosed the sealed command as MSYS backslash-stripping and self-stopped at marker 79e0bca; sweep 0/25 killed (record #237) — all 25 sampled mutants sat in the `_c2_grid.py` scratch probe (25-cap sampled alphabetically; 298 available), so it measures probe pollution, not game logic — the probes wave 2 deleted) · wave 2 (adapt-shape brief c2-wave2.txt quoting the fail verbatim, BASE 79e0bca) | **PASS** — wave 2 (ledger c2-wave2-1787700776646, 40 turns): driver verify PASS 22846ms; hand re-run exit 0, 335 PASS 0 FAIL incl. G2.4c "0 C1 regressions"; marker exact in 9c4b773 (wants from boot: vs-agenda if one exists, else neutral from strongest disposition; committed gilded/tests/test_c2_contract.py; all 7 scratch probes removed incl. `_c1_selfcheck.py`); House frames render (banner family/why/clock "turn 4 of 10" + court cards with stance/want per adult, seed 7); sweep 2/8 killed (record #238) — 6 survivors all in ambitions.py:291-302 boot-want derivation (age-threshold + cmp mutants; thin-tests residual, same class as C1's) |
| C3 — the world pushes back | 9c4b773 | 9c0a6fbd4027a7c2 (hardened; was 90fa086ac43242e5) | clean MISS (hardened gate: 6 fails, independent surface prongs; exit 1, no traceback) | inert-orders stub FAILs exactly the 9 discriminators: G3.3a ×4 (no head-faced beats), G3.4a.deflection, G3.5a ×4 (seat run identical to control); 46 anatomy/fog checks PASS — re-verified post-hardening in a BASE worktree | wave 1 MISS (shape divergence: keys Church/Crown/Guilds/Treasury, no hold_seat; 8 fails, 336 PASS); wave 2 MISS (contract inversion F128 — root cause superseded by F129, IDENTICAL 8 fails, 440 turns spent improving the invented world); wave 3 run 1 VOID (engine defect F129: compaction destroyed the brief; 217 tool calls, 2-line diff, not chargeable to the wave budget); wave 3 (final) re-dispatched post-fix | — |
| C4 — one living UI | — | — | — | — | — | — |
| C5 — the world is big | — | — | — | — | — | — |

## Calibration transcripts

### C1 (2026-08-24, BASE 2092b0c, gate f2dd97feb5db182f)

BASE run (expect clean FAIL — features absent):

```
s7.surface.ladder: FAIL game.ladder missing
s7.surface.beats: FAIL game.beats missing
s7.surface.acts: FAIL game.acts missing
s7.surface.registry: FAIL gilded.ui.registry missing
s11.surface.ladder: FAIL game.ladder missing
s11.surface.beats: FAIL game.beats missing
s11.surface.acts: FAIL game.acts missing
s11.surface.registry: FAIL gilded.ui.registry missing
GATE: MISS (8 fails)   exit 1, no traceback
```

Cheat-stub run (perturb_c1.py — constant ranks, empty-cause provenance,
signature-only beats, hollow registry; discriminators must FAIL):

```
s7/s11.G1.1c: FAIL rank order never changed across 20 turns
s7/s11.G1.3a.season|inquiry|deflection: FAIL kinds seen: ['signature']
s7/s11.G1.3c: FAIL inquire('stub')
s7/s11.G1.4a.verbs: FAIL 1 verbs
GATE: MISS (12 fails)  — stub cannot pass; gate discriminates.
```

Known accepted residual: a delta list containing only trivial self-consistent
Attributeds could satisfy G1.2; countered by G1.3c (causes>=1), the brief's
"deltas() IS the render source" contract (asserted structurally in C4), and
mutation sweep at verdict.

### C2 (2026-08-25, FINAL — re-calibrated on post-C1 BASE a418d49; the
### provisional pre-C1 run gave identical discriminators. gate 1f6b4bc6ca740b5b)

BASE run on a418d49 (full gate incl. C1 chain): identical C2 fails to the
transcript below, plus 150 PASS — the entire C1 regression chain runs green
inside the C2 gate. Stub run on a418d49: identical to the transcript below
(perturb updated to piggyback the real C1 beats facade, which chassis's
end_turn_close call now requires).

Original provisional BASE run (pre-C1 tree, `CYNCO_GATE_SKIP_C1=1`; expect clean
FAIL — features absent):

```
s7/s11/s13.surface.set_ambition: FAIL game.set_ambition missing
s7/s11/s13.surface.ambitions: FAIL game.ambitions missing
s7/s11/s13.surface.ui.house: FAIL gilded.ui.house missing
G2.2b: FAIL AttributeError("'Character' object has no attribute 'want'")
G2.2c: FAIL stances across seeds: []
G2.3.achievable: FAIL no ambition ever fulfilled: []
G2.3.failable: FAIL no ambition ever failed: []
GATE: MISS (13 fails)  exit 1, no traceback
```

Cheat-stub run (perturb_c2.py — every want "backs" with first disposition key,
banner clock frozen at "turn 1 of 10", ambitions always fulfilled; skips the C1
regression chain via `CYNCO_GATE_SKIP_C1`; discriminators must FAIL):

```
s7.G2.4b.t4: FAIL banner={'family': 'Consolidation', 'clock': 'turn 1 of 10'}
s11.G2.4b.t4: FAIL banner={'family': 'Glory', 'clock': 'turn 1 of 10'}
s13.G2.4b.t4: FAIL banner={'family': 'Buyout', 'clock': 'turn 1 of 10'}
G2.2c: FAIL stances across seeds: ['backs']
G2.3.failable: FAIL no ambition ever failed: [True, True, True]
GATE: MISS (5 fails), 180 checks PASS — stub cannot pass; gate discriminates.
```

Stub notes: real `intel.report` runs unmodified against the stubbed agenda
(tier-3 path reads `goal.why`); `gilded.provenance.Cause(label, amount, source)`.
Known accepted residuals: G2.2a cannot tell a genuinely disposition-derived want
from a want that merely name-drops a disposition key — countered by G2.2c
(stance diversity across seeds must emerge from the derivation) and mutation
sweep at verdict. G2.3.achievable/failable need both outcomes across the
3-seed grid; a degenerate coin-flip implementation could satisfy them but would
break G2.2b determinism and the honest-levers rule.

### C3 (2026-08-25, BASE 9c4b773, gate 90fa086ac43242e5)

BASE run (expect clean FAIL — features absent):

```
s7.surface.orders: FAIL game.orders missing
s7.surface.hold_seat: FAIL game.hold_seat missing
s11.surface.orders: FAIL game.orders missing
s11.surface.hold_seat: FAIL game.hold_seat missing
G3.4a: FAIL game.orders missing
GATE: MISS (5 fails)   exit 1, no traceback; 336 checks PASS (full C1+C2 chain)
```

Cheat-stub run (perturb_c3.py — orders with correct anatomy but INERT: no
lever beats, no deflection, hold_seat a no-op; Bank goal rotates so the
collision scan finds a fresh Receivership; discriminators must FAIL):

```
s7.G3.3a.Combine|Bank|Church|Gazette: FAIL 0 beats faced by [head], 0 with provenance, over 40 turns
G3.4a.deflection: FAIL seed 3: no deflection beat with face='Stub Head of the Bank', 'Receivership' and the commit clock ('of 10') in text
s11.G3.5a.Combine|Bank|Church|Gazette: FAIL seat trajectory identical to no-seat control over 20 turns
GATE: MISS (9 fails), 46 checks PASS — stub cannot pass; gate discriminates.
```

Known accepted residuals: G3.5a is the weakest assertion (plan self-review
agrees) — any real divergence satisfies it, so a hold_seat that directly
credits treasury would pass; countered by the honest-levers rule in the brief
and mutation sweep at verdict. The G3.5a.det guard (two no-seat runs must be
byte-identical) makes divergence attributable to the seat. G3.4a's seed scan
(seeds 3–18, 16 turns) requires deterministic goal selection to reach
Receivership somewhere in that window — the brief states this explicitly.
G3.4a.thwarted passed under the stub (seed-3 buyout failed naturally);
the deflection beat is the real discriminator, as designed.

#### C3 wave 1 — MISS (ledger c3-wave1-1787708879995, 388 turns, head 52c90ca)

Shape divergence, the C1-wave-1 failure class again: CynCo built real Order
machinery (gilded/orders.py, committed tests in gilded/tests/test_c3_orders.py
— F127 held, no scratch probes) but invented its own world — orders keyed
`['Church', 'Crown', 'Guilds', 'Treasury']` instead of the spec §6 table's
Combine/Bank/Church/Gazette, and no `hold_seat` at all. Probing the head
(seed 7, 1 end_turn) shows the divergence runs deeper than keys: order goals
draw from the C2 HOUSE families (`Crown: Dominion, Treasury: Buyout, Guilds:
Consolidation, Church: Intrigue`), not the spec's order-specific family
lists; `.reach` is an int (`5505`), not a set; treasuries sit at 0.0. Real
substance exists (Order class with head Characters — "Corbin Crown",
"Maren Treasury" — goal objects with commit_turns=10, tick_orders wired into
chassis.end_turn, intel order path, committed tests), so wave 2 is a
remap-plus-behaviour wave, not a rebuild — but not a rename-only either.

ContractAssertPass economics worked live: CynCo tried to self-mark the gate
assertion passed; the engine checked the repo and denied it ("Assertion 0 was
NOT marked passed — the repository contradicts it"), and CynCo kept working.
0/358 tool calls touched the grading apparatus.

CodeIndex adoption negative result: this 388-turn exploratory run was the real
test of the steering changes, and CodeIndex was called **0** times (Grep 60,
Read 108, Bash 145, total 358). C2-wave-2's single call remains the only use.

Gate hardening (sha 90fa086ac43242e5 → 9c0a6fbd4027a7c2): the original gate
crashed with `KeyError: 'Combine'` on the wave-1 head — it checked
`hasattr(g, "orders")` but then indexed by canonical names, and surface_ok's
early return on missing hold_seat hid the names-mismatch report. Fixes:
`orders_shaped()` guard before any by-name indexing (fog/levers/collision/
seats now emit clean FAILs on wrong-shape trees), and independent surface
prongs. Contract semantics unchanged — only guard/reporting paths. Rule 11
re-run in a worktree at BASE 9c4b773 (path-swapped calibration copies, only
the sys.path line differs): BASE clean MISS (6 fails — one per guarded
section, exit 1, no traceback); cheat stub MISS with the same 9
discriminators. NEW CALIBRATION LESSON: the perturb suite must include a
wrong-shape variant (orders present, wrongly keyed), not just an inert one —
that variant would have caught the KeyError before dispatch.

Wave-1 verbatim fails (hardened gate on head 52c90ca — the wave-2 contract):

```
s7.surface.hold_seat: FAIL game.hold_seat missing
s7.surface.names: FAIL orders = ['Church', 'Crown', 'Guilds', 'Treasury']
s11.surface.hold_seat: FAIL game.hold_seat missing
s11.surface.names: FAIL orders = ['Church', 'Crown', 'Guilds', 'Treasury']
s7.G3.2b: FAIL orders dict absent or wrongly keyed — fog unreadable
s7.G3.3a: FAIL orders dict absent or wrongly keyed — no lever beats to find
G3.4a: FAIL orders dict absent or wrongly keyed — no Bank to collide with
s11.G3.5a: FAIL orders dict absent/wrongly keyed or hold_seat missing — no seats to test
GATE: MISS (8 fails)   336 prior-chain checks PASS
```

#### C3 wave 2 — MISS (ledger c3-wave2-1787715373980, 440 turns, head 17646bc)

Contract inversion — logged as **F128** in docs/cynco-failure-log.md. The
brief quoted all 8 fails verbatim and numbered the divergences (1. KEYS,
2. FAMILIES, 3. ANATOMY, plus hold_seat); the run fixed none of them and the
gate fails the IDENTICAL 8 checks at its head as at its base. It instead
finished its own wave-1 plan: levers now move real deterministic quantities
(Crown +0.5 unrest on target border, Treasury collects a 100-gold tax share,
Guilds −0.5 unrest, Church +0.25 on the target capital), press beats carry
the head's face and causes, deflection beat fixed, rng stream protected via
A/B/C worktree experiments, suite 2027 passed / 0 failed. All real, all
reusable, all on a world the contract rejects. Failure signatures: committed
test_c3_contract.py in "adapted shape" (test bent to code), and a self-
imposed design constraint the contract forbids ("House treasuries are never
touched" vs G3.5a seat divergence). C1+C2 chain stayed fully green both runs.
Hygiene: 0/413 tool calls touched grading apparatus; no scratch probes;
1 untracked file (the mid-run-delivered wave-1 brief, F-rule 15).

Wave 3 (final under the 3-wave budget): rename-first brief — Cut 1 is the
literal remap (keys/families/reach/hold_seat) with surface checks as the
immediate measurement, DO-NOT list covering wave-2's landed work, and the
sealed-contract sentence: when your tests and the contract disagree, your
code moves, never the test.

### C3 wave 3 run 1: VOID — engine defect F129, not chargeable to the wave budget

Run 1 of wave 3 (BASE 17646bc, 217 tool calls, exitReason
engine_closed_the_turn, markerSeen false) delivered a 2-line window-title
rename and nothing else. Session-transcript forensics proved the cause was
the ENGINE, not the model: the 12,407-char brief arrived intact, the first
compaction (8.5 min in) garbled it, and by the third compaction the surviving
goal statement was "rename the window title". `selectVerbatimAnchors` pinned
only the last 6 user messages (all bare tool_results in an unattended
mission) and the driver's 200-char contract slice — nothing of the ask
survived verbatim. Stale scratch (`.cynco-plan.md` from June,
wave 2's `.cynco-state.md`) was injected as system context and misdirected
re-grounding. Retro-diagnosis: the SAME defect explains wave 1's invented
world (compaction turned anatomy attrs into institution names) and wave 2's
refusal to rename (compaction 1 enshrined "(Crown/Treasury/Guilds/Church)" as
the goal). All three C3 waves failed on one engine bug; the sealed gate
caught every one. Full account: docs/cynco-failure-log.md F129.

Fixes landed in localcode before re-dispatch: compressor pins the first user
message verbatim as `[Pinned original task]` through every compaction
(engine/context/compressor.ts + regression tests), and the driver purges
untracked `.cynco-plan.md`/`.cynco-state.md` at dispatch
(scripts/cynco-workspace.mjs `purgeStaleAgentState`). Ruling: the void run
does not consume the final wave; the unchanged c3-wave3.txt brief is
re-dispatched at the new BASE.
