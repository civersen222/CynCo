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

### Stage 12 — the suite goes green and stays green
~70 tests are red and every one traces to 11I. This stage is the proof that they did.

**Exit:** ≥1907 collected, zero failures, three runs in a row, with no test deleted,
skipped, xfailed, or re-baselined into a weaker assertion than its own name claims.
(11H already tried to weaken `test_r6_richest_rival_is_most_enterprises` into
`assert result is not None` — that class of change fails this stage by definition.)
*Gate: `d1_suite`, plus a diff review of every touched test file.*

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

### Stage 14 — alliances that bind
`MarriageContract.alliance` is a flag nothing reads, and `truces` is the whole of diplomacy.
A CK-style game is bought for its web of obligation.

**Exit:** a House can be called into another's war and can refuse at a named cost; a marriage
that carries `alliance=True` creates a standing pact visible on the drawn page; over a played
century at three seeds, at least 8 pacts form, at least 2 are called on, and at least 1 is
broken — measured from the simulation, not from return values.
*Gate: new.*

### Stage 15 — consequences that outlive the turn
Petitions resolve and vanish. `event_chains.py` is 82 lines and `saga/` is 406 against the
docket's 1616. A decision the player made forty turns ago should still be visible.

**Exit:** at least 6 petition kinds create durable state a later turn reads; at least 3
chains of length ≥3 fire in a played century; the Gazette names the earlier decision by its
own text when the consequence lands. Measured over a century at three seeds.
*Gate: new.*

### Stage 16 — the ending you got is the ending you earned
The four axes and the epilogue exist and pass `g8`. What is not yet true is that different
play produces different endings.

**Exit:** across twelve seeds played by three scripted strategies (hoarder, conqueror,
dynast), at least 4 distinct named verdicts appear, no single verdict is more than 40% of
outcomes, and each strategy's modal verdict differs from the other two's.
*Gate: new. This is the replayability number.*

---

## Block C — make it startable. Two stages.

### Stage 17 — a stranger can play turn one
No tutorial, no welcome, no onboarding of any kind. This is the single largest gap between
the current build and a purchasable one, and it is the cheapest to close.

**Exit:** a first-run flow that names the goal, the three things the player spends
(attention, gold, standing) and the one thing that ends the game; every one of the 11 tabs
carries a one-sentence "what this is for"; and a scripted new-player path — start, rule one
petition, end turn, see the consequence — that completes without the player needing anything
outside the window. Assertable as: the path draws, every step names its next action, and no
step is reachable only by keyboard shortcut.
*Gate: new.*

### Stage 18 — it does not break in front of a stranger
Robustness pass. Fuzz the input, play to the century at fifty seeds, catch every unhandled
exception.

**Exit:** 50 seeds played to natural end with every tab drawn every turn, zero unhandled
exceptions; save/load exercised at a random turn in each; and a crash handler that writes a
report rather than closing the window.
*Gate: new, and this is the one that should also finally run the `mutationSweep` that has
been `null (UNMEASURED)` on every record in the ledger.*

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
Block A  close the simulation      11I  12  13
Block B  worth a second run        14   15  16
Block C  startable by a stranger   17   18
                                   ─────────────
                                   8 stages
```

Eight. Not a counter — a list. A failed run re-issues its stage; it does not add one.
The three Block B stages are the ones that decide whether this is a tech demo or a game,
and they are the ones with no gate written yet, so **authoring those three gates is the next
piece of my own work after 11I lands.**
