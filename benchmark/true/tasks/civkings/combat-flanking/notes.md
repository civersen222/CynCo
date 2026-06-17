# combat-flanking — provenance

## Targeted behavior
`combat.calculate_flanking(attacker_pos, defender_pos, friendly_units)` in
`C:\Users\civer\civkings\combat.py`.

Clean logic: counts friendly units (excluding the attacker, which is filtered by
`unit.position != attacker_pos`) whose position is one of the defender's 6 hex
neighbors, awards +2 per such unit, capped at +12. The result is consumed by both
`resolve_combat` (multiplies attacker power by `1 + flank/100`) and
`preview_combat` (feeds `attacker_strength`, `estimated_damage`, and the
`bonuses["flanking"]` entry).

## What setup.patch removes
Replaces the entire body of `calculate_flanking` (neighbor set, the
per-adjacent-friendly count loop, and the `min(count*2, 12)` cap) with a flat
`return 0`. Surrounding combat logic (terrain, fortification, power formula,
preview win-chance sim) is left intact, so the scoped work is to restore the
flanking computation.

## Why the test requires real logic
The hidden test pins four independent properties of the real algorithm:
- zero when no ally is adjacent,
- +2 scaling per adjacent ally (1 ally → 2, 3 allies → 6),
- the +12 cap (8 allies on neighbor hexes → 12, not 16),
- the attacker excludes itself even when standing on a neighbor hex,
plus an end-to-end check through `preview_combat` (Catapult atk 16 on Plains,
3 adjacent allies → attacker_strength 16.96, estimated_damage 10.96,
bonuses["flanking"] == 6). A trivial constant/counter stub cannot satisfy all of
these simultaneously. Only `preview_combat`'s RNG win-chance sim uses
`random` and is never asserted (seeded for hygiene anyway).

## Gate result (verbatim pytest)
Temp clone of C:\Users\civer\civkings @ 03b4032, headless `SDL_VIDEODRIVER=dummy`.

1) Clean code (expect PASS):
```
.....                                                                    [100%]
5 passed in 0.07s
```

2) With setup.patch applied (expect FAIL):
```
.FF.F                                                                    [100%]
...
3 failed, 2 passed in 0.05s
```
`git apply setup.patch` reported "apply OK".
