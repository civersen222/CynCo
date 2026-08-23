# CivKings — the remaining stages, and what "sellable" still requires

**Written 2026-08-15, at stage base `d7fa68f`, HEAD `b017832`.**

The stage counter has been growing because it has been indexed by *attempts* (11, 11B … 11H)
rather than by *work remaining*. This document fixes the denominator. It names **eight
remaining stages**, each with an exit criterion that is a number a sealed gate can assert,
and it separates the work CynCo can do from the work it cannot.

When a stage's exit number is met and committed, cross it off. The list does not grow when a
run fails; a failed run re-issues the same stage.

---

## Where the game actually is

Verified by reading the tree, not by recall. Corrections to earlier impressions are marked.

| Subsystem | State | Evidence |
|---|---|---|
| Character & dynasty simulation | **DONE** | `gilded/society/` — characters 391L, marriages 286L, relationships 158L, dispositions 226L, character_deepening 143L, succession 92L. Birth, aging, death, traits, matchmaking, inheritance, opinion drift all present. |
| Decision layer (petitions) | **DONE** | `gilded/docket.py` 1616L, 16 `_gen_*` generators, 14 kinds reaching a played century, 2–5 options each, unattended auto-resolve. This was Stage 11's objective and it is achieved. |
| Economy | **NEARLY** — one open defect | 6 enterprise types, tiers 1–5, directors, shareholding, a 19-label treasury journal. The open defect is Stage 11I below. |
| Endgame | **DONE** | `gilded/endings.py` 197L. Four hard stops, four scored axes, a named verdict and a four-paragraph epilogue that reaches the drawn page. Gate `g8` reads 8/8. |
| UI | **DONE** (earlier "stub tab" reading was wrong) | 11 tabs, ~7000L. The thin `_draw_*` routines in `broadsheet.py` delegate: Atlas → `atlas_view.py` 451L, War → `war_tab.py` 379L, House → `house_tab.py` 437L, Docket → `_draw_petition_cards`. |
| Save / load | **PARTIAL** | `app.py:92` pickles the game to `gilded_quicksave.pkl` and drops the docket first because option closures do not serialize; `console.py:280` reloads and rebuilds. Works; unversioned and untested across a schema change. |
| War | **PARTIAL** | `gilded/fronts.py` 410L — fronts, supply falloff, entrenchment, commander rolls, war score, negotiated peace. No sieges. |
| Diplomacy | **PARTIAL** | `House.relations` (−100..100) and `truces` with turn expiry. **No alliance or treaty system.** `MarriageContract.alliance` is a flag nothing acts on. |
| Narrative layer | **THIN** | `gilded/saga/` 406L total against docket's 1616L. Template prose, not a beat system with memory. |
| Onboarding | **ABSENT** | `TAB_HINTS` one-liners only. Zero matches for tutorial / welcome / onboarding anywhere in the tree. |
| Audio & art | **ABSENT** | No image or sound asset under `gilded/`. Default pygame fonts. A legacy sound directory exists and is not imported. |
| Tests | **DONE as scaffolding** | 91 files, ~1836 cases, ~34K lines. Currently ~70 red, all downstream of the Stage 11I defect. |

**The headline:** the *simulation* is close to finished. What is missing is not more systems —
it is (a) one economic defect, (b) the reasons to play a second time, and (c) everything that
makes a stranger able to start.

---

## Block A — close the simulation. Three stages.

### Stage 11I — the world is printing money
*Carried forward from 11H. Dispatched 2026-08-20 at base `c6144d8`.*

**The symptom named above was the wrong one and has since been fixed.** The docket-crowding
reading — `charter`, `share purchase` and `strike buyoff` never offered — no longer holds;
the sealed instrument's "all 6 spending decisions of the base still happen" reads green.
What remains is a real inflation, and it is not a missing sink. Measured 2026-08-20, seed 7,
twelve turns, against calibration base `d7fa68f`:

| | base | rev | delta |
|---|---|---|---|
| total gold | 14601 | 18729 | **+28%** |
| net created over 12 turns | +601 | +4729 | +4128 |
| dividends (credited) | 31915 | 39787 | +7872 |
| expansion (debited) | 22013 | 25266 | −3253 |
| enterprise count | 19 | 19 | **identical** |
| tier mix | `{1:6, 2:1, 3:4, 4:6, 5:2}` | `{1:6, 2:1, 3:3, 4:5, 5:4}` | **two more tier-5** |

Nobody founded an extra venture. The same nineteen exist — but two climbed to tier 5, and
`output_gold` is **linear in tier**. The dividend engine grew 7872 while the expansion sink
grew only 3253, and that gap *is* the inflation. Per House it lands exactly where that
predicts: Vantrell +303% and Brandtner +164% are precisely the two that gained a second
tier-5, while Ashworth — which paid to lift a mill from tier 2 to tier 4 — went **−77%**.
Houses that upgraded nothing barely moved.

`gilded/enterprises.py` and `gilded/society/shares.py` are **byte-identical** to `d7fa68f`,
so `EXPAND_COST`, `EXPAND_TURNS`, `TIER_MAX`, `output_gold` and the dividend split are all
untouched. No constant was tampered with. The cause is in the **decision layer** — who
chooses to expand, how often they are offered the choice, and what the unattended path does
when nobody rules (`ATTENTION_PER_TURN` 3 against `MAX_PETITIONS` 6, so most petitions
resolve unattended). One lead, unconfirmed: `docket.py:135` prices an expansion as
`EXPAND_COST[tier+1] * expand_cost_mod` while `docket.py:1097` prices one as bare
`EXPAND_COST[tier+1]`.

**Exit:** seed 7, twelve turns, `end_turn()` only, nobody ruling —
total gold in **13141–16061** (14601 ±10%); no House more than 40% from its base purse;
all 6 base spending labels still spending; all 14 kinds still offered over a century with
none above 25%. Plus a new `gilded/tests/test_money_supply.py` asserting the **total**, not
one House, calibrated to fail at `c6144d8`.
*Gate: `g10_the_money_supply.py` 4/4, `g9` 8/8. Runnable restatement: `C:/tmp/check_money.py`.*

**Not available as fixes** (each was tried by an earlier wave and each failed the band):
raising `EXPAND_COST` as a hidden throttle; giving the one-sided sinks a counterparty credit
to "fix the accounting" — those sinks *are* the brake; deleting or rarefying a decision;
draining every House equally, which fails a two-sided band exactly as hard as inflating them.

### Stage 12 — the assertions that measure the dice
*Rewritten 2026-08-21 against measurement, then corrected the same day once the gate
was actually built and calibrated. The original entry said "~70 tests are red and
every one traces to 11I" and demanded zero failures with no re-baselining; both
halves were wrong and the second was unsatisfiable. See F118, F119 and its addendum.*

**The number is sixteen, not seventy.** `d7fa68f` is 1932 passed, zero failures;
`eff03a4` is 16 failed, 1927 passed. Bisected: `d7fa68f 0 -> 641c90a 9 -> 9453eae 26
-> b017832 31 -> 8b50a85 14 -> 632e73c 16 -> eff03a4 16`. Fourteen survived the
`8b50a85` cleanup; `632e73c`/`3499eb6` added two.

**Fifteen of the sixteen are not regressions.** Burn N meaningless `rng.random()`
draws per game and per turn on the CLEAN base — which has zero failures of its own —
and it fails 3 to 9 tests at every N from 1 to 12, over the six files that hold
fourteen of the sixteen. Calibrated:

```
d7fa68f base    N=0:  0 failed      14 distinct offenders across N=1..12
eff03a4 head    N=0: 14 failed      19 distinct offenders across N=0..12
```

Those assertions pin one generated world: a House NAME, one seed's seven treasuries
to 1e-6, "a colliery happens to sit in a striking province", "the ledger happens to
be eight lines too long for an 800x600 page", "no control on this page is disabled".
Content landed between the two commits, the dice moved, and the tests reported it as
breakage. Demanding they go green without re-baselining asks for a change that does
not exist, which is exactly how F113/F114/F115/F117 spent four runs and ~18 GPU-hours.

**The one genuine defect** is `test_ai::test_s17_expanding_needs_more_gold_than_the_price`,
whose fixture contradicts its own docstring: it sets treasury 350 for an expand that
`EXPAND_COST` prices at 1200, and 350 is below the `sell_shares` floor of 500, so the
AI correctly does something else. A hand-edit broke a working threshold test.

**The triage rule is about the assertion, not the symptom.** "Red at N=0 only =>
genuine" is wrong — the four `test_i6b_measurement` colour cases are red at N=0 and
green at every N>=1, which is sample-pinning in the other direction. The question is
whether the assertion names something that exists only because the dice fell that
way. If it does, restate it over something stable and rename it to say what it now
measures. The sweep is evidence, not the verdict.

**Scope.** The whole-suite sweep finds 46 offenders on the clean base
(`test_ui_broadsheet` 19, `test_schemes` 8, `test_agenda` 8, `test_ui_actions_i4d2b1`
4, `test_ui_actions` 2, one each in five more). That is not one stage. Stage 12 takes
`test_agenda`, `test_ai`, `test_chassis`, `test_i6b_measurement`,
`test_treasury_journal` and `test_ui_ledger` — 232 tests, ~22s a run, so thirteen
values of N cost about five minutes and the gate can be *run*, not merely finished
on. `test_ui_broadsheet` and `test_schemes` are explicitly deferred to a Stage 12B.

**Exit:** those six files green at N=0 AND at every N from 1 to 12. No test deleted,
skipped, xfailed, or weakened into `assert result is not None` (11H tried exactly
that on `test_r6_richest_rival_is_most_enterprises`; a restatement must still name a
behaviour). `gilded/agenda.py` byte-identical — the tempting wrong fix is to make the
game produce the old House names again. Each restated test says in its docstring
which sample it used to pin and what it measures instead.

*Gate: `12/g12_the_suite_measures_the_rules.py` (scoped, N=0..12), plus
`common/g_suite_no_regression.py` against `suite_baseline.txt` — node-id sets, never
counts (F118) — plus `11/g11_hygiene.py` and a diff review of every touched file.*

### Stage 12B — the rest of the suite measures the rules
The 32 perturbation offenders Stage 12 deferred: `test_ui_broadsheet` (19),
`test_schemes` (8), `test_ui_actions_i4d2b1` (4), `test_ui_actions` (2),
`test_schemes_s9`, `test_capital_m8`. Same rule, same gate, different `CHK12_TARGET`.
Two of `eff03a4`'s sixteen standing failures live in `test_ui_broadsheet` and are
repaired here, not in Stage 12.

Both are diagnosed already. `test_the_takeover_click_spends_exactly_one_attention`
fails on a fixture-premise line, `assert 5 == 3`, because `ATTENTION_PER_TURN`
went 3 → 5 in `0754667` (see F120); its real subject, `after == before - 1`, still
passes, and the fix is to import the constant like every other site does.
`test_a_rivals_campaign_does_not_block_the_players_own` is dice — red at six of
eight N on the clean base.

**Exit:** the whole of `gilded/tests` green at N=0 and at every N from 1 to 12.

**Also here, or sooner:** a gate that pins the player-facing balance constants —
`ATTENTION_PER_TURN`, `EXPAND_COST`, `WAR_SCORE_WIN`, `TRUCE_TURNS`,
`DISLOYAL_OPINION`, `STRIKE_OUTPUT_MULT` — so that moving one is a decision
somebody makes rather than a diff nobody reads. A correct test suite is
structurally blind to these, because a well-written test imports the constant and
moves with it. F120.

### Stage 13 — the save survives a schema change
Save/load works but pickles a live object graph and discards the docket to do it. A player
who saves, gets a patch, and loses their century will refund.

**Exit:** a versioned save format; a round-trip test that saves at turn 20, reloads, and
replays ten more turns to a byte-identical outcome; and a load of a save written by the
*previous* commit that either restores or refuses with a readable message — never crashes.
*Gate: new, to be authored.*

---

## Block B — make it worth a second run. Three stages.

This is the block that turns a working simulation into a game someone buys. Everything here
is about **the player having a reason to make a different choice next time.**

### Stage 14A — wars that end

**This stage did not exist until the substrate was measured, and it displaces the one that
did.** What follows is measurement, not design intent.

Base `305daff`, seeds 7/61/42, 120 turns each, driven by `end_turn()` alone:

| | seed 7 | seed 61 | seed 42 |
|---|---|---|---|
| wars declared | 3 | 3 | 3 |
| wars ended | **0** | **0** | **0** |
| `war_score` at turn 120 | 0.0 | 0.0 | 0.0 |
| truces formed | 0 | 0 | 0 |
| regiments in the world | **0** | **0** | **0** |

Two of the three wars are declared on **turn 2**, at relation 0, before diplomacy has
happened at all. They are still running at turn 120. On seed 61, Duval-Corse spends 118
consecutive turns at war with three Houses simultaneously and nothing occurs.

The chain, root-caused rather than guessed:

1. `ai.py` never calls `raise_regiments`. Mustering is reachable **only** from player
   petitions — `docket.py:618`, `:1202`, `:1327`. An unattended House never raises a soldier.
2. So every `Front` sits at `attacker_regiments=0, defender_regiments=0` forever.
3. `resolve_front` (`fronts.py:245`) derives `power_a`/`power_d` from those counts. Zero
   against zero grinds nothing.
4. `war_score` therefore never leaves 0.0, and `WAR_SCORE_WIN` is ±100.
5. `ai_peace_check` gates on `war_score`, so it never returns terms and
   `negotiate_peace` (`fronts.py:404`) never fires.
6. `at_war_with` is never cleared and `truces` stays `{}`.

`test_fronts.py` calls `resolve_front` about thirty times and passes. It constructs fronts by
hand with regiments already on them, so it exercises step 3 and never observes that steps 1–2
do not happen in a played game. This is the wiring-bug signature: a well-tested subsystem that
is inert in the product.

`docket.py:1278` already contains a stalemate escape keyed on exactly this state —
`all(f.attacker_regiments == 0 and f.defender_regiments == 0 ...) and abs(war.war_score) < 0.05`
— but it is reachable only from a player-initiated peace petition, so unattended play never
takes it.

**Exit:** over a played century at three seeds, every war that starts either concludes or is
still credibly contested — `war_score` moves off 0.0, at least half of wars declared reach
peace, and truces exist at turn 120. Bought by the mechanism: `WAR_SCORE_WIN` stays ±100,
`test_fronts.py` stays byte-identical, and deleting or suppressing war declarations does not
count as ending a war.
*Gate: new.*

### Stage 14B — alliances that bind
`MarriageContract.alliance` is a flag nothing reads. It is set `alliance=True` on every
contract (`marriages.py:118`) and read exactly once (`:157`) to add +10 to a relation bonus.
The game prints `"Blood ties seal an ALLIANCE between X and Y"` and the alliance means
nothing: `_weaker_neighbor` (`ai.py:76-82`) picks war targets on `at_war_with` and `truces`
only, and never consults `relations`. On seed 61 turn 62, Ferrenholt declares war on
Duval-Corse at relation **100** — the maximum the scale allows.

**This stage is blocked by 14A and its original exit criterion was unreachable.** That
criterion asked for "at least 2 pacts called on" per century. Measured, the base offers
**exactly 1** call-to-arms opportunity per game on all three seeds — a war whose defender has
an uninvolved ally — and it offers only that many *because* wars never end, so the only wars
that exist were declared before any alliance formed. A gate demanding 2 would have been F89
again: a bar above anything the substrate can produce. Alliances cannot be shown to bind
until war moves.

**The post-14A substrate, measured 2026-08-21 at `1205ce7`**, 120 turns, seeds 7/42/61,
`end_turn()` alone:

| | seed 7 | seed 42 | seed 61 |
|---|---|---|---|
| wars declared / ended | 4 / 2 | 2 / 2 | 4 / 4 |
| `war_score` left 0.0 | 2 of 4 | 2 of 2 | 4 of 4 |
| truce entries at 120 | 4 | 4 | 8 |
| **allied House pairs at 120** | **15 of 21** | 6 of 21 | **17 of 21** |
| alliance-relevant wars | 2 | **0** | 3 |
| betrayals (war on an ally) | 0 | 0 | **2** |

14A holds: wars end, `war_score` moves, truces exist. Three things this changes about 14B:

1. **The alliance is degenerate before it is unread.** Every marriage sets `alliance=True`,
   and marriages are frequent — 15 of the 21 possible House pairs are "allied" by turn 120 on
   seed 7, 17 of 21 on seed 61. An alliance three quarters of the map holds is a phone book.
   The scarcity defect is upstream of the "nothing reads it" defect and has to be fixed first,
   which the original framing did not see.
2. **"Never attack an ally" and 14A are in direct conflict at these densities.** If 17 of 21
   pairs are allied and the target picker refuses allies, war very nearly stops — and 14A's
   exit goes red. Any 14B gate must re-assert 14A's numbers, because suppressing war is the
   cheapest way to pass a no-betrayal claim.
3. **Call-to-arms opportunities are 2 / 0 / 3.** Better than the base's 1, but seed 42 offers
   none, so an observational floor per seed is still F89. The gate builds the situation
   (declare a war on a House with an uninvolved ally, assert the ally joins or refuses for a
   recorded reason) and uses the played century only as a combined-across-seeds floor of ≥1.

Betrayal is now 0/0/**2** rather than 0/1/0 — seed 61's Karsgate attacks Brandtner at turn 41
and Ferrenholt at turn 63 while allied with both — so a played-century no-betrayal claim is no
longer vacuous, but it is still probed directly against the picker as well.

**Exit:** alliances are an explicit, scarce pact rather than a side effect of every wedding —
standing pacts at turn 120 are between 1 and 8 at each of the three seeds; the target picker,
probed directly by construction, never selects a House the aggressor holds a pact with, and a
played century shows 0 betrayals at all three seeds; a call to arms fires by construction and
at least once across the three played centuries; and 14A's numbers hold — at least half of
wars declared reach peace and truces exist at turn 120.
*Gate: new, blocked on 14A (now unblocked; substrate measured above).*

**LANDED 2026-08-21 at `cd48f40`.** `gilded/pacts.py` is the one place a pact is defined,
read and enforced; `may_declare_war` is asked on all three war paths (`ai.py:83`,
`agenda.py:262`, `docket.py:1348`). Gate green on all five phases: 6 / 3 / 6 pacts standing
at turn 120 with at most 2 per House, both pickers refuse a target they named themselves at
all three seeds, the call to arms is answered at all three (seed 7 by a recorded refusal,
42 and 61 by the ally joining), and 14A held with 15 wars declared against the base's 10.
Suite 1957 passed / 0 failed. Weddings were **not** suppressed to get there — marriages ran
59/33/73 at base against 60/33/71 at head.

The driver recorded `verified=false`; that was a **false negative from the gate**, not a
verdict on the work — see **F121**. It is also the origin of sealed-gate **rule 14**.

**Carried debt from the mutation sweep (18/25 killed).** Two survivors are real and belong
in a later stage's brief rather than being patched silently:

* `pacts.py:99:cmp->Gt` / `:100:const->True` — the per-House scarcity cap is checked
  symmetrically for `house_a` and `house_b`, but only the `house_a` half is killed. The
  `house_b` half is unprotected, so the cap is proven to bind on one of the two Houses and
  merely *asserted* on the other. Same "green while measuring nothing" family as F118,
  reached through an untested symmetry.
* `fronts.py:410:cmp->IsNot` — `if w is war` in the `pact_pledges` cleanup can be inverted
  to delete every pledge *except* the one that should go, and nothing notices.

Not gaps in the game; gaps in what its own tests can tell is wrong. Fold into Stage 18.

### Stage 15 — consequences that outlive the turn
Petitions resolve and vanish. A decision the player made forty turns ago should still be
visible.

**The substrate was measured on 026d38f before this stage was specified, and the
measurement overturned the exit that was written here first.** The old exit asked for
"at least 3 chains of length ≥3 fire in a played century". That is unreachable, and the
gate would have been an F89 spec error:

* `event_chains.py` (82 lines) is complete and correct — `ChainManager.tick` arms triggers
  and advances steps, deterministically. Twelve `ChainDef`s are authored across
  `event_content/chains_pack1.py` and `chains_pack2.py`.
* **None of it is wired.** `build_pack1`/`build_pack2` have zero callers and `ChainManager`
  is never instantiated in `chassis.py`. It *was* wired, at `legacy/civkings/game.py:552-557`
  — the port to `gilded/` dropped it. Same signature as 14A's `raise_regiments`.
* Exactly **three** of the twelve chains have ≥3 steps (`mine_inquiry`,
  `heir_radicalization`, `tabloid_war`); the other nine have 2. So the old exit needed all
  three of them.
* Wired experimentally and played a century at seeds 7/42/61, **2 of 12 chains ever fire**
  (`coping_spiral`, `succession_vultures`) — both 2-step. **All three 3-step chains fire at
  no seed.** Each is dead for its own reason:
  * `mine_inquiry` reads `getattr(game, "cities", None) or {}`. `GildedGame` has no
    `cities` attribute at all — the world is `atlas.provinces`. The `or {}` swallows it, so
    it fails silently rather than raising.
  * `heir_radicalization` needs `is_heir`. That flag is set `False` at
    `society/characters.py:153` and the only writer of `True` in the tree is
    `ui/court_actions.py:283` — **a player-only UI action**. An unattended century has 351
    characters and **zero** heirs. This also makes `succession.py:39`'s "a living designated
    heir stands FIRST, ahead of all tiers" branch unreachable in AI play.
  * `tabloid_war` needs two rulers to hold **mutual** opinion ≤ -40. The most negative
    one-way opinion measured is -80 at seed 42, and 0 at seeds 7 and 61.
* Separately: `chassis.py:174` does `self.events = []` at the **top** of every `end_turn()`,
  so `game.events` only ever holds the last resolved turn. Consequences literally cannot
  outlive the turn *in the record* today.

**Exit (to be pinned against a positive shim before dispatch):** the chain system is wired
into the turn; a named, reachable set of chains fires and runs to completion in a played
century at three seeds; at least 6 petition kinds write durable state a later turn reads,
with the reader cited; and the Gazette names the earlier decision by its own text when the
consequence lands. The chain count and which chains must be quoted from a re-measurement
after the trigger repairs, never from the authored inventory.
*Gate: new. Rule 11 + Rule 14 — this stage needs a positive shim, because its central
claim is one the base fails for four independent reasons.*

**LANDED 2026-08-22 at `2f44568`.** Two cuts, 117 tool calls, none of which touched the
grading apparatus. `g15 chains` PASS on all five phases, `g_suite` 1963 passed / 0 failed
against the empty `cd48f40` baseline, hygiene clean. The gate was calibrated against six
trees before dispatch — base (15 findings), wire-only (12), teleprompter (15), a positive
shim (0), and that shim perturbed by 1 and by 8 extra rng draws per turn (0 and 0) — and
the landed run reproduces the shim's numbers exactly:

* 8 / 5 / 8 chains completed at seeds 7 / 42 / 61, union of 8, two distinct completed-set
  shapes across the seeds, and `mine_inquiry` completing with ≥3 beats at every seed.
* Every completed chain names a real province, House or person, so no beat reached the
  gazette with its braces unfilled.
* All 7 AI Houses hold a living designated heir by turn 12, and at each seed an heir named
  before the ruler's death is the one who inherited — `succession.py:39`'s designated-heir
  branch executes in unattended play for the first time.
* 14A and 14B re-assert green in the same century (19 wars declared across the three).

The four ported reads were repaired honestly: every threshold (`unrest >= 35`, dial `>= 60`
/ `>= 80` / `<= 30`, `militancy >= 60`) is preserved verbatim and only the object being read
changed — `game.cities` → `atlas.provinces`, the dial joined back from the enterprises sited
in the province, `scheme_manager` → `scheme_mgr`. No existing test was modified; the
`test_true_believer_transforms_instead` casualty was resolved in the game, as specified, by
a fallen-House guard in `_drain_legitimacy`. The dice were not touched.

**Carried debt — `name_heir` does not pick who its own docstring says.** It claims "the
oldest living adult, else the oldest minor", but iterates `dynasty.all_characters` in dict
insertion order and takes the first match, while `succession_order`'s tier 1 sorts by age
descending. At turn 0 the two agree in 42 of 42 realms, which is why
`test_name_heir_designates_who_the_line_would_pick` passes; after 70 turns they diverge in
**16 of 21**. The divergence is married-in spouses: they enter the dynasty late but old, so
the line names a 74-year-old in-law and `name_heir` names a 35-year-old of the bloodline.
Two consequences, neither caught by the gate because neither breaks a claim the stage made:
the docstring is false, and that test is turn-0-lucky — precisely the coincidental-agreement
shape the brief warned about, arriving in the half of the test the brief did not name.
`name_heir`'s pick is arguably the better *game* rule, so this is a decision to make
explicitly, not a bug to patch quietly. Fold into Stage 18 with the 14B survivors.

**Carried debt — the authored trigger thresholds are unpinned.** Full-suite mutation sweep
over the stage's diff, `gilded/tests` as the test set: **8 of 25 killed**. All 17 survivors
are trigger predicates in `chains_pack1.py` and `chains_pack2.py` — comparisons that can be
inverted (`>=` → `>`, `==` → `!=`) and constants that can move 15 points, with no test in
1963 noticing. The wiring is pinned; the content is not. Recorded on ledger record #231.
Fold into Stage 18.

### Stage 16 — the ending you got is the ending you earned
The four axes and the epilogue exist and pass `g8`. What is not yet true is that different
play produces different endings.

**~~Exit:~~ RETIRED as an F89 spec error — every clause measured wrong.** The written exit
asked for "at least 4 distinct named verdicts, no single verdict more than 40%, and each
strategy's modal verdict differs from the other two's". Measured over 120 games (24 seeds ×
5 stances) at `2f44568`: the base **already** produces 4 distinct verdicts, so that clause
is free. No honest repair measured got any verdict below **43.3%**, so "no verdict above
40%" is a bar above what the substrate produces. And no honest repair separated all four
modals — the ceiling is **3 of 4**, because `hoarder` and `dynast` both end quiet and rich
and there is no fifth verdict for them to split into.

**Exit (re-derived from measurement):** over 24 seeds × 5 stances = 120 centuries —
≥5 distinct verdicts pooled, no verdict above 58.0%, `The Quiet Throne` reached ≥25 times
(it is reached **0** times today — one of the five named endings is dead content), ≥3
distinct modal verdicts across the four scripted stances, on ≥18 of 24 worlds the four
reigns end ≥3 distinct ways, a century of war putting ≥12.0 on the player's **own** ledger
(`tide.house_atrocities`, today 3.0), and a blood axis taking ≥5 distinct 5-point values
while pinned at 100.0 in at most 85 games (today: 119 of 120 pinned).

Four root causes, all measured: `fronts.py:220` calls `record_atrocity("war")` with no
`house=` — the one atrocity in the tree charged to nobody; `ATROCITY_WEIGHTS` has no `"war"`
key so a battle is tariffed below a cover-up; `endings.py` judges `tide.atrocities` (the
world's) in both `_axis_world` and the Quiet Throne branch though `tide.house_atrocities`
exists and is populated; and `_axis_blood` passes 100 at four living members and never comes
back.
*Gate: new. Rule 11 + Rule 14 — calibrated red on the base and on two cheat shims (constant
tuning; `house=` alone), green on the minimal honest repair, a fuller repair, and that
repair perturbed by 1, 3, 5 and 8 extra rng draws per turn.*

**LANDED at `537283a`** (3 commits, 4 files, +182/−15, 89 turns; ledger record #232).
Both sealed gates re-run by hand on the landed head: endings PASS on all five phases,
suite **1968 passed, 0 failed**. Every bar cleared with room: 5 distinct verdicts, largest
share **45.0%** (bar 58.0), `The Quiet Throne` reached **54** times (bar 25, base 0),
**3** distinct modals, **23 of 24** worlds ending ≥3 ways (bar 18, base 5), a century of war
putting **17.0** on the player's own ledger against the hoarder's 0.0 (bar 12.0, base 3.0),
and blood in **14** five-point buckets pinned at 100.0 in **27** of 120 (bar ≤85, base 119).
The repair went to the root of all four defects and no existing test was edited, skipped or
xfailed. 0 of 71 tool calls touched the grading apparatus.

Two debts, both for Stage 18. **`_axis_blood` still adds 5.0 for every _dead_ member**, so a
house that buried ten scores 50 above one that buried none — pre-existing at `2f44568`,
carried through the rewrite unexamined, and now the one term in the axis that does not read
the state of the line. And the **mutation sweep is 4 of 25 killed** (`gilded/tests` over the
stage's diff): all 21 survivors are coefficients or comparisons inside the new `_axis_blood`
(lines 92–100, 112) and the Quiet Throne threshold (line 133). The delivered tests pin the
_direction_ of every property and not one magnitude; the magnitudes are held only by the
held-out gate, which does not ship.

---

## Block C — make it startable. Two stages.

### Stage 17 — a stranger can play turn one
No tutorial, no welcome, no onboarding of any kind. This is the single largest gap between
the current build and a purchasable one, and it is the cheapest to close.

**~~Exit:~~ RETIRED — one of its four clauses was already true at `537283a`.** The written
exit asked for "every one of the 11 tabs carries a one-sentence 'what this is for'" and "no
step is reachable only by keyboard shortcut". Measured: `TAB_HINTS` already gives all 11
tabs a sentence, delivered as `hint=` on each tab `Region` — that clause is free.

**Correction, made while grading Stage 18's base.** The second retirement was wrong. This
note claimed the build has "no keyboard handlers at all"; `app.step_once` handles Esc, F5
and N today, and `_quicksave` is bound to F5 and reachable no other way. The clause retired
as vacuously true is measurably **false**: saving and quitting are keyboard-only, and no
tab, hint or drawn string in the build mentions either key. It was retired on a claim about
the code that was never measured — the same shape as F124, one level up. Stage 18 carries
it as a real bar: a click must be able to put the century down and take it back up.

What the hint clause was reaching for is real but different: the sentences exist **only as
hover tooltips**. On the Briefing tab 14 of 16 regions' hints appear nowhere in the drawn
text, and `TAB_HINTS` is a dict literal rebuilt inside `_draw_tab_bar` on every frame. A
stranger who does not know to hover never sees a word of it.

**Exit (re-derived from measurement):** over 24 worlds, driving the real pygame UI headlessly
through `new_app_state`, `view.draw`, `view.regions`, `view.handle_click` and
`app._apply_action` — the same seed draws the same frame twice; **`wrap()` reproduces its
input word for word**; the first frame of a new game names the objective, what ends the game,
and all three spends; a **blind walk that clicks only regions in group `guide`** rules a
petition and reaches turn 2 on ≥22 of 24 worlds; and acting and refusing are both answered on
screen — `rule`/`set_stance`/`place_informant` each put a line up on ≥22 of 24 worlds with
≥6 distinct rulings, and ≥95% of refused clicks show the reason the game already computed.

Five root causes, all measured at `537283a`:

1. **Every multi-line paragraph the game draws is doubled.** `widgets._word_groups` appends
   `current` to `groups` inside `if current:` and then again in the `else:` below it — the
   intervening `if surf.get_width() <= width` is the negation of the branch it sits in and can
   never be true. Measured in the real draw path: 54 of 384 `wrap()` calls in a pass over 6
   worlds × 11 tabs × turns 1/13/40 come back with every line twice, and it is the Gazette's
   prose that doubles. **1963 tests pass.**
2. **Nothing on the opening frame says what the game is.** 24 of 24 first frames draw
   ~900–1400 characters and name the objective 0 times and what ends the game 0 times.
3. **The game explains itself only on hover** (above).
4. **Acting is answered with silence.** `_rule_dispatch` calls `docket_rule(...)`, which
   returns narration lines, and throws them away — `return []`. `_set_stance_dispatch` and
   `_place_informant_dispatch` are silent too. The channel works: `_apply_action` appends any
   returned string to `view._action_messages` and `_draw_action_messages` draws it.
5. **Refusal is answered with silence.** `app._apply_action` binds the reason into `_reason`
   and returns without showing it. On turn one 24 of the 40 registered actions are refused,
   every one with a non-empty reason already computed, and the player is told none of them.

*Gate: new (`g17_turn_one.py`). Rule 11 + Rule 14 — 11 findings on the base, 0 on an honest
repair, with a repetition trap (48 identical words must survive wrapping) that a dedupe of
`wrap()` fails and a cure of `_word_groups` passes.* **Expect a casualty:** the honest repair
measured 4 red in `test_ui_broadsheet.py` — the per-tab region censuses and
`test_every_control_on_every_tab_explains_itself` — because a guide control genuinely now
exists on every tab. That premise really changed and belongs fixed in the census, not
loosened.

**LANDED `ada2e8f` (2026-08-22, mission_17-1787413154364, 213 turns, 2 cuts, 0 of 193 tool
calls touched the grading apparatus).** Both sealed gates re-run by hand at the landed head:
`turnone` PASS on all five phases, `suite` 1974 passed / 0 failed against an EMPTY baseline.

| bar | base `537283a` | landed | need |
|---|---|---|---|
| wrapped paragraphs that read back as themselves | 330 / 384 | 384 / 384 | all |
| 48 identical words survive wrapping | 92 words | 48 words | 48 |
| objective named on the opening frame | 0 / 24 | 24 / 24 | 24 |
| what ends it named on the opening frame | 0 / 24 | 24 / 24 | 24 |
| clickable region in group `guide` | 0 | 1 on every frame | ≥1 |
| blind walk rules a petition and reaches turn 2 | 0 / 24 | **24 / 24 in 2..4 clicks** | ≥22 |
| `rule` / `set_stance` / `place_informant` answered | 0 / 24 each | 24 / 24 each | ≥22 |
| distinct rulings across 24 worlds | 0 | 24 | ≥6 |
| refused clicks that show their reason | 0 / 48 (0%) | 48 / 48 (100%) | ≥95% |

The censuses moved honestly: every tab +1, the picker 22→23, the tooltip sweep 212→223. No
assertion loosened, skipped or xfailed.

**Two debts, both for Stage 18.**

**The opening statement teaches a false number.** It says *"The century ends after a hundred
turns"*; `chassis.TURN_BUDGET` is **70** and a measured game reports `game_over at turn 71 ->
century`. This is **the gate's fault, not the run's** — phase 3's published ender vocabulary
included the literals `hundred turns` and `100 turns`, which this game has never used, and the
run wrote to the list it was given. Logged as **F124**: a gate may accept a synonym for a
concept but never a literal for a quantity. Stage 18 must state the real budget and tie the
rendered text to `TURN_BUDGET` in a test. The neighbouring claim *"You win by keeping your
standing high"* is a half-truth worth sharpening too — `judge()` awards *Hegemon of the Age*
on capital **and** standing together.

**Cut 2 shipped behaviour with no test.** Cut 1 delivered six good ones that assert both halves
(the stance line names the key *and* where it landed; the refusal appears *verbatim*). Cut 2
delivered zero: `grep` for `next_step`, `GUIDE_STATEMENT` or `group="guide"` across
`gilded/tests/` returns nothing. Deleting `_draw_guide` would be caught by the region
censuses, but rewording the statement, breaking `next_step`'s action, or repointing the button
at a harmless view verb all pass the full suite. The only thing that ever checked the guide is
a held-out gate the repository does not have.

### Stage 18 — it does not break in front of a stranger
Robustness pass. Fuzz the input, play to the century at fifty seeds, catch every unhandled
exception.

**~~Exit:~~ REWRITTEN before dispatch.** The written exit asked for "50 seeds played to
natural end, zero unhandled exceptions". Measured on the base: **12 worlds already play to
natural end drawing all 11 tabs with 0 crashes, 4800 fuzzed clicks raise nothing, 8 malformed
action dicts raise nothing.** The build is not fragile, so that bar was already met and would
have proved nothing (F89 from the other side — a bar the substrate passes on arrival). The
real defect is the opposite: `gilded/ui/app.py` contained **no `except` at all**, so on the
day something *does* raise, the window vanishes with the century in it and no report is left.
The stage was re-scoped onto four measured defects.

**LANDED `2092b0c` (2026-08-22, mission_18-1787435374870, 416 turns, 4 commits, 0 of 349 tool
calls touched the grading apparatus; ledger record #234).** Both sealed gates re-run by hand
at the landed head: `finished` PASS on all five phases (12/12 findings), `suite` 1978 passed /
0 failed against an EMPTY baseline.

| bar | base `ada2e8f` | landed | need |
|---|---|---|---|
| blind walk rules a petition and reaches turn 2 (Stage 17's win) | 24 / 24 | 24 / 24 in 2..4 clicks | ≥22 |
| opening frame claims a century length | 24 / 24 | 24 / 24 | 24 |
| the length it claims equals `TURN_BUDGET` | **0 / 24** | **24 / 24** | 24 |
| a click writes the game to disk | 0 / 6 | 6 / 6 | 6 |
| a click brings an earlier turn back | 0 / 6 | 6 / 6 | 6 |
| an in-frame failure escapes `step_once` | 4 / 4 | **0 / 4** | 0 |
| the failure is written down with its traceback | 0 / 4 | 4 / 4 | 4 |
| burials that raise the blood axis | 36 / 36 | **0 / 36** | 0 |
| blood axis still varies (buckets / spread / pinned) | 7 / 48.0 / 0 | 7 / 48.0 / 0 | ≥5 / ≥20 / ≤20 |

The censuses moved honestly: every tab **+2** for the Save and Open controls, the picker
23→25, the tooltip sweep 223→245, the registry 40→42 — all four exactly the casualties the
brief predicted. No assertion loosened, skipped or xfailed. Two tests that went red mid-run
were repaired **in source, not in the test**: the contrast sweep (a new colour at 5.59:1
rather than a lowered 4.5:1 bar) and `test_layout_coverage`. `test_i6g_ellipsis.py` swapped a
positional `regions[-1]` for a lookup by action, which is stricter than what it replaced.

**The brief had a defect, and the run paid for it.** The brief told the run that phase 2
scans for an integer within four tokens of a word about the game's length, and listed those
words as `(turn, turns, century, age, ends, lasts, long, budget, over, last)`. The gate's
actual rule is `_SPAN_WORDS = ("turn", "turns", "year", "years", "century", "game")` — six
words, not ten, and **`age` is not among them.** I wrote that list from memory instead of
quoting the source line.

CivKings' pre-era title is the literal `"Before the Age"`, so the HUD chip rendered
`Before the Age · 1837 (4%)`. Against the brief that is a flagrant violation; against the
gate it is nothing — the scan returns the empty set. The run trusted the brief, which is
correct, since a sealed gate is unreadable to it by design. So it shipped commit `4ceea60`,
splitting `texts["era"]` in two so no integer would sit near `Age`. **Measured after the
fact: reverting that commit and re-running the sealed gate gives phase 2 a full pass,
`24/24 first frames claim exactly 70 turns`.** The change was never needed. The HUD is two
chips where it was one because of a sentence in a brief.

Logged as **F126**. The gate's scanner is sound and needs no change; what needs changing is
that a brief may not *restate* a sealed gate's rule in prose — it must quote the source line,
or describe only the shape and refuse to enumerate. **A sealed gate's brief is the only map
the run has, so every inaccuracy in it is load-bearing.** The unnecessary era split is
carried as a revert candidate for the next stage.

**One debt, and it is the same one Stage 17 left.** `grep` for `gilded_crash` or
`_report_frame_failure` across `gilded/tests/` returns **nothing**. The crash handler, the
save and open controls, and the `state.game = result` resync all ship with **zero tests of
their own** — the only thing that has ever checked them is a held-out gate the repository does
not have. The mutation sweep confirms the shape: **9 of 25 killed** (62 available, first 25
run, so a sample not a census), with survivors clustered as flipping `return False`→`True` in
both refusal guards (`actions.py:69,82` — nothing tests *why* Save or Open refuse),
`attention_cost=0, gold_cost=0` unpinned on both new actions (`actions.py:1153,1158` — nothing
stops saving becoming a paid action a broke player cannot afford), and the quickload resync
itself (`app.py:93`). Seven more sit on `endings.py:99`, the blood axis, where `8.0` mutates
freely to `1.0/5.0/9.0/16.0` — **the pre-existing Stage 16 magnitude debt, on the exact line
this stage edited.** Two more (`app.py:133,135`, the F5 and N handlers) are a measurement
artifact: pre-existing lines the diff counts as added only because they were re-indented into
the new `try`.

---

## What CynCo cannot do, and what that means

**Art, audio, typography, a Steam page, a trailer, pricing, store copy, age rating,
Steamworks integration.** None of this is a mission. The game is text-and-vector by design —
a broadsheet — which makes the art budget unusually small, but it is not zero: a typeface
licence, a masthead, a handful of engraving-style plates, and ambient sound would take the
build from "a simulation with a UI" to "a thing that looks made".

Treat this as one non-CynCo line item, scoped after Stage 18, when the game is known to be
finished and worth dressing. Doing it before then dresses something that is still moving.

---

## The burndown

```
Block A  close the simulation      11I  12  13     ✓ ✓ ✓
Block B  worth a second run        14   15  16     ✓ ✓ ✓
Block C  startable by a stranger   17   18         ✓ ✓
                                   ─────────────
                                   8 stages, 8 landed
```

Eight. Not a counter — a list. A failed run re-issues its stage; it does not add one.

**All eight have landed. Seven carry a hand-verified record** — a sealed gate re-run by hand
at the landed head, `verified: true` in the ledger. `python -m gilded` opens a game that a
stranger can start, understand, put down, pick up again, and be told the truth by when it
breaks.

**The eighth is Stage 11I, and it is not closed on paper.** Its missions
(`mission_11money`, `mission_11money2`) are `landed` but `verified: false` in the ledger, and
the section above still ends at its **Exit**, with no landed block and no measured close. The
artifact it was asked for does exist — `gilded/tests/test_money_supply.py` is in the tree and
green inside the 1978 — but nobody re-ran its gate (`g10_the_money_supply.py` 4/4, `g9` 8/8)
by hand afterwards. Treat the money-supply band as **unconfirmed**, not as passed. It is the
one place in this document where "landed" has been allowed to stand in for "measured".

**What "finished" here does and does not mean.** It means the eight defects this document
set out to close are closed and measured. It does not mean the build is beyond criticism,
and the honest reading of the last two stages is that the roadmap ran out before the
*testing* did. Stage 17 shipped its guide with no tests; Stage 18 shipped its crash handler
with no tests; the blood axis has had no magnitude test since Stage 16 and has now been
edited twice without gaining one. Every one of those is defended solely by a held-out gate
that the repository does not contain — which is exactly the arrangement this document
complains about elsewhere. A ninth stage that writes the repo's own tests for Stages 16–18's
behaviour would be the highest-value thing left, and it is not on this list because the list
was written before the debt existed.
