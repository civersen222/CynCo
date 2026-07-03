# military-promotion-bonus

## Function / behavior targeted
`Unit._apply_promotions` in `military.py` (exercised via the full promotion chain:
`Unit.gain_xp` -> `Unit._offer_promotion` -> `Unit.accept_promotion` -> `Unit._apply_promotions`).

Promotions are stored as a list of `{stat: bonus}` dicts. `_apply_promotions` resets
attack/defense/max_moves to the unit-type base, then re-adds every earned promotion
bonus on top. `accept_promotion` appends the chosen bonus, bumps `level`, clears
`pending_promotion`, and calls `_apply_promotions`. XP threshold for a promotion is
`XP_PER_PROMOTION * level` (10 * level), fully deterministic with no RNG.

## What the patch removes
`setup.patch` deletes the bonus-application loop inside `_apply_promotions`:

```python
for bonus in self.promotions:
    for stat, val in bonus.items():
        if stat == "attack":
            self.attack += val
        elif stat == "defense":
            self.defense += val
        elif stat == "movement":
            self.max_moves += val
```

With the loop gone, `_apply_promotions` only resets stats to base, so promotions are
tracked (`level` still increments, `promotions` list still grows) but never affect
combat stats. The symptom: promoted units stay at base attack/defense.

## Hidden test
`test_promotion_applies_stat_bonuses` builds a Swordsman (base attack 10, defense 10,
movement 1), drives three successive promotions (attack, defense, attack) across the
escalating XP thresholds, and asserts the stacked bonuses land (attack 12, defense 11,
level 4). Requires the real re-application logic, not a trivial getter.

## Gate result (temp clone of 03b4032, headless SDL_VIDEODRIVER=dummy)
- Clean:   `1 passed in 0.12s`
- Patched: `1 failed in 0.04s`  (`assert 10 == 11` at hidden_test.py:20)
