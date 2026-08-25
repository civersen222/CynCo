# CivKings Redesign Spec — "Make It an Actual Game"

**Date:** 2026-08-24
**Status:** Draft for user review
**Source:** Deep-dive brainstorm following the 2026-08-22 verdict: *"I can click and number change but nothing feels like it happens... tbh i'm not sure it's salvageable."*
**Scope rule:** CynCo-only — this spec produces requirements for CynCo missions. Nothing here is implemented directly in the civkings repo by hand.

---

## 0. Diagnosis (why this spec exists)

The shipped game is a detailed world simulation with no game wrapped around it:

- **No win condition.** `check_ending` (endings.py) has only extinction, fallen fate, and century-end. `LEGITIMACY_VICTORY_FLOOR` is a dead constant.
- **Rivals invisible.** Powers tab shows six houses, all "Their intentions are unknown."
- **~1 verb per screen**, presented as undifferentiated button lists (War tab: 6× "Declare War", 6× "Propose Marriage").
- **Dead presentation.** 11 broadsheet tabs; the Ledger prints "Income: 0 | Outlay: 0 | Net: 0"; the House screen renders 14 family members as identical "loyalty 50 (DUBIOUS) opinion +0" rows while the model underneath carries 30 dispositions, generated traits ("Powder Keg", "Self-Made Zealot", "Godless"), stats, secrets, and stress per character — none of it shown.
- **Test-blind spot.** 1,978 tests (35,193 lines — 2× the sim source) measured that controls exist/click/explain, never that anything *happens*.

**North stars (user, emphatic):** Crusader Kings and Dwarf Fortress simulation depth. Palette sensitivity: refinement matters; muddy defaults read as failure.

### Hidden assets (already built, currently wasted)

| Asset | Where | Today | Redesign use |
|---|---|---|---|
| All-house axis scoring | `endings.py` `_axis_capital` etc. | computes every house's wealth, discards it | live public ladder |
| AI agendas | `agenda.py` — 7 goal families, 10-turn commits, honest levers | AI-only; player has no agenda | player ambitions + Order agendas |
| Intel fog | `intel.py` — 4 additive tiers | renders as one dead line | earns the WHY behind ranks and agendas |
| Provenance | `provenance.py` Cause/Attributed with `.check()` | wired only to legitimacy | inquiry chains for ALL systems |
| Character depth | `society/characters.py` + realms — 30 dispositions, traits, stats, secrets, stress | never rendered | Court in Session, wants, Order heads |
| Union with a face | `society/labor.py` `Movement` + leader | mechanical only | the Combine (Order #1) |
| Press seat | `papers.py` Master of the Press slant | flavour | the Gazette (Order #4) seat template |

---

## 1. The Clarity Law (non-negotiable, gates everything)

Every screen must pass the **cold-open test**: a player who has never seen it can guess what each thing does, why it does that, and why they would want to do it **to win**.

1. **One home per fact.** No datum is rendered on two screens. Summaries and map glyphs may *point* to the home (click-through), never duplicate it. (Named offence: the old Docket duplicating Briefing's agenda card.)
2. **Every verb self-explains.** Each control carries, at point of use: what it does, why now, and which ladder axis or ambition it serves. Disabled verbs state their unmet requirement inline (dashed style, per the Banknote system).
3. **Testable.** CynCo mission gates must assert non-overlap (a datum's owner screen is unique) and verb annotation coverage — not merely that controls exist and click.

Any mission adding UI must state which spine/inner page owns the new content and prove nothing else shows it.

## 2. Spine: three screens, no tabs

**House · Powers · Atlas.** The 11 broadsheet tabs are dissolved:

| Old tab | Fate |
|---|---|
| Briefing | dies — agenda card becomes the House ambition banner; alerts become desk letters |
| Gazette | not a destination — the End Turn beat printing over the map, then archived (readable from the desk) |
| Ledger | House inner page (and the Income/Outlay/Net = 0 bug fixed on the way) |
| Letters | desk strip on the Atlas |
| Docket | dies — its decisions are the desk strip |
| Policies | House edicts, signed from the Court in Session — each slider move is a decision with a signature beat and family stances |
| Enterprises | governance (directors, dials, dividends) = House inner page; the physical mills = Atlas glyphs, click-through to the card |
| Powers | remains as the Powers chassis, reworked (§5) |
| War | dies — wars are drawn on the map; "Declare War" is a verb inside a rival's dossier |

## 3. Winning: Ladder + Ambitions

### 3.1 The Ladder
- Rank across the four axes (`_axis_capital`, `_axis_standing`, `_axis_blood`, `_axis_world`) is computed for **all houses every turn** and the overall rank is **always public**.
- The **WHY is earned**: per-axis breakdowns, trajectories, and rival agendas are gated behind the existing 4-tier intel fog (blind → mood → intent → depth; sources: border, ties, assets, informant).
- Victory: the century ends (existing `TURN_BUDGET`); the house atop the ladder wins the age, with `judge()`'s epilogues ("Hegemon of the Age", "The Long Ledger", ...) keyed to how they won. Extinction/revolution endings remain as loss states.

### 3.2 Ambitions — both levels, in tension (locked "C")
- **House ambition (player-chosen):** the player picks a Goal from the same 7 families the AI uses (Conquest, Dominion, Buyout, Dynasty, Intrigue, Glory, Consolidation) with the same 10-turn commit and honest levers. Symmetry: rivals read the player's agenda through *their* fog, exactly as the player reads theirs.
- **Character wants (derived — the one new mechanic):** each family member derives a private want from their 30 dispositions. Wants **align or clash** with the house ambition, yielding a stance: *backs / wary / opposes*.
- Opposing members are levers: rival Intrigue agendas and Order deflections can recruit them; managing them (assign, appease, marry off, sideline) is core House play.
- Completing an ambition pays ladder movement on its natural axis and unlocks the next choice.

## 4. House screen: the Court in Session (locked "A")

- **Ambition banner** on top: seal, family, target, why-string, commit clock ("turn 3 of 10").
- **Court grid**: portrait cards — name, age, relation, small-caps traits (the generated ones: "powder keg · labor sympathizer"), stance badge, and their one-line want citing the driving disposition.
- Stances are **computed** from dispositions vs. the ambition — never random, always inspectable.
- **Inner pages**: Dynasty Book (tree, succession, marriages, the Blood axis), Ledger, Enterprises governance, Edicts (ex-Policies).
- Vermillion budget: opposition badges only; ≤5 marks per screen per the Banknote accent rule.

## 5. Powers screen: dossiers, not rows

- **One dossier per power**: 6–8 great houses + the 4 Orders, on one chassis (minor gentry get compact entries, not full dossiers).
- Each dossier: engraved portrait of the head, intel tier indicator, threat rank (`threat_rank()` exists), known agenda (fog-gated: from "Their intentions are unknown" to "Pursuing Conquest: seeks to break a weaker neighbor by force"), ties, and **verbs in context** — Declare War, Propose Marriage, Place Informant, negotiate a seat — each annotated per the Clarity Law.
- The ladder strip (public ranks) heads the screen; clicking a rank opens that dossier.

## 6. The Four Orders (locked "B" — full first-class actors)

Institutions are actors with the same anatomy as houses — **not** aggregation shims:

| Order | Treasury | Reach | Head | Goal families |
|---|---|---|---|---|
| **The Combine** (labor) | strike fund | provinces with Movements | elected leader (exists) | Organize, Recognition, General Strike, Purge Scabs |
| **The Continental Bank** | capital reserve | every house's debt book | Chairman | Solvency, Expansion, Receivership, King-making |
| **The Church** | tithe income | parishes (population piety) | Prelate | Endowment, Crusade of Morals, Sanctuary, Schism |
| **The Gazette** (press) | circulation | literate provinces | Editor (seat exists) | Circulation War, Exposé, Respectability, Patronage |

- Each order runs `Goal(family, target, commit_turns=10, why)` — the agenda.py shape with order-specific families — so **intel fog reads Orders unchanged** (informant in the union hall → tier 3 on the Combine).
- **Heads are real characters** (30 dispositions, wants, stress, secrets) in a fifth realm. They can be courted, schemed against, or martyred — with `martyrdom: 4.0` tide cost already priced in `ideology.py`.
- Orders act through honest levers each turn: fund strikes / call loans, buy shares (`shares.py`) / swing piety, denounce / print exposés feeding the scandal system.
- **Deflection = crossing an order's active goal.** The paper trail is the goal itself: "Why did my takeover stall?" → "The Bank is committed to Receivership of Duval-Corse (turn 6 of 10); the Chairman froze the share registry."
- **One holdable seat per order** (Master of the Press is the template): Director's chair, Lay Patron, recognized-bargaining seat. Seats give influence, never control.
- Orders don't climb the ladder but can **end** a house: receivership, general strike, schism.

## 7. Atlas: the living map (home screen)

- **Map-first chassis** + Study elements: desk strip (decision letters) along the bottom, dossier/portrait access, Gazette printing over the map as the End Turn beat.
- **Every mechanic owns a glyph** (map law): cities scaled by population, regiments as blocks with strengths, battles as sabres + smoke, strikes as drawn crowds, trains with progress ("mile 31 of 44"), ships, the informant eye.
- **Three zoom tiers** (Continent / Region / Parish). Each glyph class is fully drawn at exactly one tier, hinted one tier away, absent otherwise. Never two tiers at once.
- **River blue (#6f93ad) is reserved** — no province fill may share it.

## 8. Consequence beats (how results reach the player)

1. **Signature** (instant): the player's act is acknowledged on the spot — ink, stamp, sound.
2. **Season** (End Turn): the Gazette front page prints above the fold with the turn's true headlines.
3. **Inquiry** ("why?"): every changed number chains back through `provenance.py` Cause/Attributed — **wired to all systems**, not just legitimacy. `.check()` guarantees causes sum to the delta.
4. **Deflection**: when the world thwarts the player, the thwart has an institutional FACE and a paper trail (§6). Never a silent fizzle, never an unexplained dice roll.

## 9. Art: the Banknote system

- **11 pinned inks**: paper #f5f0e1, field #ece5d0, card #fbf8ec, ink #1f2d26, ink-2 #44513f, dim #84876f, vermillion #c23a22 (+dark #8e2917), gold #a8842c, sage #ccd6bd, wheat #e3d7ae, slate #bccad2. River #6f93ad reserved.
- **Accent law (testable):** vermillion = consequence only (>~5 marks/screen is a bug); gold = the player only.
- **4 type roles.** Fonts: Bodoni Moda (display) + EB Garamond (body), shipped as TTF.
- Engraved portraits (SVG line-work), dashed disabled-state buttons with inline unmet-requirement text.

## 10. World scope: tiered

- **6–8 great houses** (full simulation) + **20–30 minor gentry** (light sim: shares, board seats, marriages; can rise to great or fall out) + **4 Orders**.
- **150–250 provinces** across the three zoom tiers (today: 7 houses / 50 provinces / 20 characters).
- Every house enmeshed in a system of systems; most player actions resolve as intended, some are deflected by the mesh (§8.4).

## 11. Delivery notes (for the CynCo plan, not commitments here)

- Order of value: consequence beats + ladder first (makes the existing sim visible), then ambitions/wants, then Orders, then world-scale-up, with the Banknote chassis carrying throughout.
- Every mission gate must test that something HAPPENS (state change + its beat), non-overlap, and verb annotation — per the Clarity Law and the standing gate-authoring rules (perturbed-base calibration).
- Stage 19 test-debt gate stays deprioritised until this design ships its first playable slice.

---

*Locked decisions recorded 2026-08-22 → 2026-08-24. Mockups: `.superpowers/brainstorm/1945-1787627291/content/` (style-v2, map-alive, zoom-consequence, house).*
