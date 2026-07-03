# diplomacy-declare-war-state

## Targeted behavior / symbol
`DiplomacyManager.declare_war` in `diplomacy.py`.

War declaration must:
1. Register the war **symmetrically** on both civs' war lists (so `is_at_war`
   and `get_active_wars` report it from either perspective).
2. Apply a **-50 relation penalty** via `modify_relation`, which is clamped to
   the `-100..100` range.

Downstream, the -50 relation drives `get_all_relations` into the `"War"` status
bucket (the war-status branch only fires once a relation entry exists for the pair).

## What the patch removes
`setup.patch` truncates `declare_war` so it only appends the defender to the
*aggressor's* war list. It deletes the reciprocal registration (defender -> aggressor)
and the `self.modify_relation(aggressor, defender, -50)` call.

Effect with patch:
- `is_at_war("Athens","Rome")` is False (defender side never recorded).
- `get_active_wars("Athens")` is `[]`.
- relation stays `0` (no penalty, no clamp exercise).
- `get_all_relations()` has no entry for the pair -> `KeyError`.

## Verification gate (temp clone of pinned commit 03b4032, headless)
- Clean:   `4 passed in 0.03s`
- Patched: `4 failed in 0.04s`

No randomness is on the asserted path. Real repo was never edited (temp clone only).
