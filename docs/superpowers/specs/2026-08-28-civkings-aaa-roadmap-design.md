# CivKings AAA Roadmap + Campaign C6 (Vertical Slice) — Design Spec

**Date:** 2026-08-28
**Status:** Approved under full user delegation ("you make the exec decisions... spec, plan and implement")
**BASE for audit:** civkings fd5414d (C5 close), measured in an isolated clone at C:\tmp\civkings-audit
**Prereq for dispatch:** Stage 6B verdict (mission in flight); C6 BASE = post-6B head

---

## 1. The ask and the reframing

User: "take the game as is and see what it would take to make it a AAA game."

Literal AAA (team-years of content, art, VO, localization) is not the scoping unit —
per the standing rule, commercial framing is a prompt device for sharper direction,
not literal scope. The operative bar is **premium-indie CK-like** (Old World /
Norland tier): a game a stranger could buy, launch, learn, play to an ending, and
close without ever seeing scaffolding. "AAA" stays as the quality north star.

Instructive datapoint from research: Old World — the genre's premium-indie
benchmark — is criticized most for its *tutorial and overstuffed UI*, not for
content volume. Clarity and shell polish are where this tier is won or lost,
which is exactly where CivKings is weakest (see audit).

## 2. Audit — measured 2026-08-28 at fd5414d (isolated clone, mission untouched)

Method: booted `new_app_state(seed=42)`, ran turns, rendered every tab to PNG,
walked the module map. Numbers, not impressions:

- 186 py files; 19,660 lines game code; 36,722 lines tests (2,046 green at C5).
- Boot 4.26 s; 10 end_turns 0.10 s; draw 21 ms/frame. Performance is a non-issue.
- 7 houses, 204 provinces, 53 living characters in the player realm at seed 42.
- Systems that EXIST and work: ladder, beats, acts, ambitions, orders, intel,
  gentry, atlas, endings (`gilded/endings.py`: 4-axis judge → Epilogue +
  `_saga_coda`), save/load (`gilded/save.py`: versioned header + pickle,
  quicksave). War becomes live with 6B.
- **Production feel ~20%:** no main menu (app.py boots straight into the game),
  no settings of any kind, fixed window (`set_mode` at app.py:56), ZERO audio
  (no mixer, no .wav/.ogg anywhere in gilded/), House tab has severe text
  overdraw (sections collide — a rendered, screenshot-verified Clarity Law
  violation), Powers tab is sparse ("Their intentions are unknown" ×10).
- **Systems depth ~55%:** breadth is real (24 systems modules) but most surface
  as single prose beats; no multi-beat event chains a player would remember.
- **Commercial completeness ~35%:** endings + save exist, but there is no
  onboarding whatsoever — a cold-open player is never told the win condition
  or the core verbs.

## 3. Roadmap (staged; each stage is one CynCo campaign)

| Stage | Name | Bar |
|---|---|---|
| **C6** | **Vertical slice** (this spec) | One complete demo-grade run: menu → play → ending → epilogue, with sound, readable UI, cold-open onboarding |
| C7 | Content depth | Event-chain library across all acts; characters that accumulate history |
| C8 | Presentation | Map/art pass, portraits, transitions, ambient music bed per act |
| C9 | Ship shell | Resolutions, keybinds, saves UI, performance guard, packaging |

Only C6 is specified here. C7-C9 get their own specs after C6's verdict —
vertical-slice-first is the industry de-risking pattern: prove one slice at
near-final quality before spending on breadth.

## 4. Campaign C6 design (six sections)

### 4.1 The slice
A player who has never seen the game: launches → main menu → New Game →
plays seed 42 → is taught the win condition and core verbs in the first
5 turns → reaches an ending within 70 turns → reads the epilogue →
returns to menu. Every step demo-grade. Deterministic given seed.

### 4.2 Shell
- Main menu: New Game / Continue / Settings / Quit. Continue is enabled iff
  a quicksave exists (wire to existing `gilded/save.py` — do not rebuild).
- Settings (minimal, persisted to a settings file across restart): window
  size choice, narrate on/off, master volume, mute.
- Menu and settings drawn with the existing regions/widgets system —
  same press-through testability as every other surface.

### 4.3 Audio first pass
- ~8-12 sounds, pre-staged CC0 (Kenney.nl: Interface Sounds 100 / UI Audio 50 /
  Digital Audio 60 — all confirmed CC0, free, direct download, no account):
  UI press, end-turn bell, war stinger, beat stinger, ending sting, one
  ambient loop; licenses recorded in assets/audio/LICENSES.md.
- pygame.mixer behind the settings volume/mute; every play call goes through
  one sound module that no-ops cleanly when mixer init fails.
- Headless-testable: SDL_AUDIODRIVER=dummy; the gate asserts the sound module
  loads, resolves every registered event to an existing file, and respects mute.
- Supersedes the 2026-07-15 generative audio-stack spec for the slice: that
  spec targeted the pre-redesign codebase (master-plan X.9, music_manager —
  none of it exists in gilded/). The generative foundry remains a later
  ambition; CC0 pack now.

### 4.4 Clarity / visual QA
- Gate assertion: on every tab at turns {0, 10, 40}, no two drawn text region
  rects collide (the regions system exposes rects — overlap is measurable).
  This makes the House-tab overdraw a failing test, not an opinion.
- Cold-open onboarding: in the first 5 turns the beats system narrates the win
  condition and each core verb (orders, ambitions, war drawer, end turn) —
  gated by asserting the narration strings appear as beats on the page.

### 4.5 Depth teaser
- One polished multi-beat event chain per act (3 acts, 3 chains): a situation
  that arrives, escalates over turns based on a player-visible choice, and
  resolves with consequences the epilogue can reference. Deterministic per
  seed. Gate asserts each chain fires and spans >= 3 beats across >= 2 turns
  in a seeded 70-turn run.

### 4.6 Sealed gate (gate_c6)
- Rule-11 calibrated: clean FAIL at post-6B BASE, perturb_c6 cheat stub
  (e.g. menu that draws but whose New Game press doesn't construct a fresh
  game; sound registry pointing at missing files) flips only the lazy checks.
- Checks: menu reachable and press-through; Continue disabled without a save,
  enabled with one; settings persist across process restart; audio registry
  resolves under dummy driver and honors mute; no-overlap assertion; cold-open
  beats; 3 event chains; headless seeded run reaches an ending <= 70 turns;
  full C1-C5+6B regression chain.
- ONE long-horizon mission (per standing directive), waves only on MISS.
  Marker: "stage c6 complete".

## 5. Execution ownership

- Game code: CynCo mission only (CynCo-Only Scope). My side: this spec, the
  plan, gate_c6 + perturb_c6, the c6-wave1 brief, and pre-staging the CC0
  audio pack with licenses (downloads delegated by user for this task).
- Dispatch after the 6B verdict lands and the C6 gate is calibrated against
  the post-6B BASE.

## 6. Research sources

- [Interface Sounds — Kenney](https://kenney.nl/assets/interface-sounds), [UI Audio — Kenney](https://kenney.nl/assets/ui-audio), [Digital Audio — Kenney](https://kenney.nl/assets/digital-audio) — CC0, free, commercial-ok.
- [Vertical Slice in Game Development — Tono Game Consultants](https://tonogameconsultants.com/vertical-slice/), [Xsolla: the impact of the vertical slice](https://xsolla.com/blog/funding-101-the-impact-of-the-vertical-slice) — slice = all core elements at near-final quality; the standard de-risking artifact.
- [Old World PC review — Cultured Vultures](https://culturedvultures.com/old-world-pc-review/), [Old World Steam Deck settings](https://steamdeckhq.com/game-reviews/old-world-steam-deck-settings/) — premium-indie shell bar (UI scaling, colorblind filter, cloud saves) and the genre's known failure mode: tutorial/UI clarity.
